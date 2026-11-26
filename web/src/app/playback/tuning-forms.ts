import type { AppContext } from "../context";
import type { JukeboxAudioMode } from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import { storeAnchorHighlight } from "../anchorHighlight";
import { storeBranchStatsEnabled, storeCustomAnchorEnabled } from "../extrasMode";
import { discardCustomAnchorEdit, exitCustomAnchorEdit } from "./custom-anchor";
import { useAppStore } from "../store";
import {
  appendAudioModeParams,
  getAnchorParamFromUrl,
  getDeletedEdgeIdsFromUrl,
  resetAudioModeToOff,
  syncTuningParamsState,
  writeTuningParamsToUrl,
} from "../tuning";
import { clearModeLoadingStep, showToast } from "../ui";
import {
  DEFAULT_MIN_LONG_BRANCH_PERCENT,
  DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
  DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  DEFAULT_TIME_SIGNATURE_NUMERATOR,
  clampMaxBranches,
  hasNonDefaultTuning as engineHasNonDefaultTuning,
} from "@forever-jukebox/shared";
import {
  audioModeChangeAffectsPlayback,
  audioModeSupportsIntensity,
  clampAudioModeIntensity,
} from "@forever-jukebox/shared/audio/audioModes";
import {
  DEFAULT_METRONOME_BEAT_OFFSET,
  DEFAULT_METRONOME_VOLUME_PCT,
  clampMetronomeBeatOffset,
  clampMetronomeVolumePct,
  resolveMetronomeTimeSignatureOverride,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import { trackEvent, trackModeEnabled } from "../analytics";
import {
  syncLiveBpmForPlaybackRate,
  updatePlayButton,
  updateTrackInfo,
} from "./status-ui";
import {
  canPrepareInstrumentalMode,
  prepareInstrumentalMode,
} from "./instrumental";
import { cancelInstrumentalRender } from "@forever-jukebox/shared/audio/instrumentalRenderer";
import { canPrepareSwingMode, prepareSwingMode } from "./swing";
import { syncPredictedJumps } from "./branch-lookahead";
import i18n from "../i18n";
import { MAX_RANDOM_BRANCH_DELTA } from "@forever-jukebox/shared/constants/playback";

const RANDOM_BRANCH_DELTA_PERCENT_SCALE = 100 / MAX_RANDOM_BRANCH_DELTA;

function getDeletedEdgeIdsFromGraph(
  graph: ReturnType<AppContext["engine"]["getGraphState"]>,
) {
  if (!graph) {
    return [];
  }
  return graph.allEdges.filter((edge) => edge.deleted).map((edge) => edge.id);
}

function applyDeletedEdgesById(context: AppContext, ids: number[]): boolean {
  if (ids.length === 0) {
    return false;
  }
  const graph = context.engine.getGraphState();
  if (!graph) {
    return false;
  }
  const edgeById = new Map(graph.allEdges.map((edge) => [edge.id, edge]));
  let changed = false;
  for (const id of ids) {
    const edge = edgeById.get(id);
    if (edge && !edge.deleted) {
      context.engine.deleteEdge(edge);
      changed = true;
    }
  }
  if (changed) {
    context.engine.rebuildGraph();
  }
  return changed;
}

export function applyDeletedEdgesFromUrl(context: AppContext) {
  const urlIds = getDeletedEdgeIdsFromUrl();
  const fallbackIds = useAppStore.getState().deletedEdgeIds;
  const ids = urlIds.length > 0 ? urlIds : fallbackIds;
  if (applyDeletedEdgesById(context, ids)) {
    const vizData = context.engine.getVisualizationData();
    useAppStore.setState({ vizData });
    if (vizData) {
      context.jukebox?.setData(vizData);
    }
    syncPredictedJumps(context);
  }
}

export function applyAnchorBranchFromUrl(context: AppContext) {
  context.engine.applyAnchorParam(getAnchorParamFromUrl());
}

export function syncDeletedEdgeState(context: AppContext) {
  const { engine } = context;
  useAppStore.setState({ deletedEdgeIds: getDeletedEdgeIdsFromGraph(engine.getGraphState()) });
  syncTuningParamsState(context);
}

// Only the slider-backed modes carry intensity, so the metric averages real
// adjustments instead of a constant default.
function trackAudioModeChange(mode: JukeboxAudioMode, intensity: number): void {
  trackEvent(
    "audio_mode",
    audioModeSupportsIntensity(mode)
      ? { audio_mode: mode, audio_intensity: intensity }
      : { audio_mode: mode },
  );
}

export type ExtrasApplyResult = {
  branchStatsChanged: boolean;
  audioModeChanged: boolean;
};

export type ExtrasFormValues = {
  bringItHomeMode: boolean;
  branchStatsEnabled: boolean;
  customAnchorEnabled: boolean;
  audioMode: JukeboxAudioMode;
  audioIntensity: number;
  metronomeVolumePct: number;
  metronomeBeatsPerBar: number | null;
  metronomeBeatOffset: number;
};

export function getExtrasFormValues(): ExtrasFormValues {
  const {
    playMode,
    bringItHomeMode,
    branchStatsEnabled,
    jukeboxAudioMode,
    audioIntensity,
    metronomeVolumePct,
    metronomeBeatsPerBar,
    metronomeBeatOffset,
    customAnchorEnabled,
  } = useAppStore.getState();
  const inJukeboxMode = playMode === "jukebox";
  return {
    bringItHomeMode: inJukeboxMode && bringItHomeMode,
    branchStatsEnabled: inJukeboxMode && branchStatsEnabled,
    customAnchorEnabled,
    audioMode: jukeboxAudioMode,
    audioIntensity,
    metronomeVolumePct,
    metronomeBeatsPerBar,
    metronomeBeatOffset,
  };
}

export function applyExtrasChanges(
  context: AppContext,
  values: ExtrasFormValues,
): ExtrasApplyResult {
  const { cowbellOverlay, engine, metronomeOverlay, player } = context;
  const previousBranchStatsEnabled = useAppStore.getState().branchStatsEnabled;
  const previousAudioMode = useAppStore.getState().jukeboxAudioMode;
  const previousAudioIntensity = useAppStore.getState().audioIntensity;
  const previousBringItHomeMode = useAppStore.getState().bringItHomeMode;
  useAppStore.setState({
    bringItHomeMode:
      useAppStore.getState().playMode === "jukebox" && values.bringItHomeMode,
  });
  trackModeEnabled("bring_it_home_mode", previousBringItHomeMode, useAppStore.getState().bringItHomeMode, {
    ui_source: "extras",
  });
  if (useAppStore.getState().bringItHomeMode && useAppStore.getState().shiftBranching) {
    useAppStore.setState({ shiftBranching: false });
    engine.setForceBranch(false);
  }
  engine.setBringItHomeMode(useAppStore.getState().bringItHomeMode);
  trackModeEnabled(
    "custom_anchor_mode",
    useAppStore.getState().customAnchorEnabled,
    values.customAnchorEnabled,
  );
  // The toggle only shows the editor button; an anchor already set keeps playing.
  useAppStore.setState({ customAnchorEnabled: values.customAnchorEnabled });
  storeCustomAnchorEnabled(values.customAnchorEnabled);
  if (!values.customAnchorEnabled) {
    exitCustomAnchorEdit(context);
  }
  useAppStore.setState({
    branchStatsEnabled:
      useAppStore.getState().playMode === "jukebox" && values.branchStatsEnabled,
  });
  trackModeEnabled("branch_stats_mode", previousBranchStatsEnabled, useAppStore.getState().branchStatsEnabled);
  if (!useAppStore.getState().branchStatsEnabled) {
    useAppStore.setState({ branchStats: null });
  }
  storeBranchStatsEnabled(useAppStore.getState().branchStatsEnabled);
  const nextAudioMode = values.audioMode;
  const nextAudioIntensity = clampAudioModeIntensity(values.audioIntensity);
  const nextMetronomeVolumePct = clampMetronomeVolumePct(values.metronomeVolumePct);
  const nextMetronomeBeatsPerBar = resolveMetronomeTimeSignatureOverride(
    values.metronomeBeatsPerBar,
  );
  const effectiveBeatsPerBar =
    nextMetronomeBeatsPerBar ??
    useAppStore.getState().metronomeDetectedBeatsPerBar;
  const nextMetronomeBeatOffset = clampMetronomeBeatOffset(
    values.metronomeBeatOffset,
    effectiveBeatsPerBar,
  );
  useAppStore.setState({
    jukeboxAudioMode: nextAudioMode,
    audioIntensity: nextAudioIntensity,
    metronomeVolumePct: nextMetronomeVolumePct,
    metronomeBeatsPerBar: nextMetronomeBeatsPerBar,
    metronomeBeatOffset: nextMetronomeBeatOffset,
  });
  metronomeOverlay.setMetronomeVolumePct(nextMetronomeVolumePct);
  metronomeOverlay.setBeatsPerBarOverride(nextMetronomeBeatsPerBar);
  metronomeOverlay.setBeatOffset(nextMetronomeBeatOffset);
  if (nextAudioMode === "cowbell") {
    cowbellOverlay.enable();
  } else {
    cowbellOverlay.disable();
  }
  if (nextAudioMode === "metronome") {
    metronomeOverlay.enable();
  } else {
    metronomeOverlay.disable();
  }
  if (nextAudioMode !== "instrumental") {
    cancelInstrumentalRender();
  }
  if (nextAudioMode === "swing") {
    player.setJukeboxAudioModeIntensity(nextAudioIntensity);
    if (canPrepareSwingMode(context)) {
      prepareSwingMode(context);
    } else {
      showToast(i18n.t("playback.swingWhenLoaded"), {
        icon: "hourglass_top",
      });
    }
  } else if (nextAudioMode === "instrumental") {
    player.setJukeboxAudioModeIntensity(nextAudioIntensity);
    if (canPrepareInstrumentalMode(context)) {
      prepareInstrumentalMode(context);
    } else {
      showToast(i18n.t("playback.instrumentalWhenLoaded"), {
        icon: "hourglass_top",
      });
    }
  } else {
    useAppStore.setState({
      audioModeRenderToken: useAppStore.getState().audioModeRenderToken + (1),
    });
    useAppStore.setState({ audioModePreparing: false });
    clearModeLoadingStep();
    player.setJukeboxAudioMode(nextAudioMode, nextAudioIntensity);
    if (
      audioModeChangeAffectsPlayback(
        previousAudioMode,
        nextAudioMode,
        previousAudioIntensity,
        nextAudioIntensity,
      )
    ) {
      syncLiveBpmForPlaybackRate(player.getPlaybackRate?.());
      if (
        useAppStore.getState().playMode === "jukebox" &&
        (useAppStore.getState().isRunning || useAppStore.getState().isPaused)
      ) {
        engine.syncToPlaybackPosition();
      }
    }
    updatePlayButton();
  }
  if (
    previousAudioMode !== nextAudioMode ||
    previousAudioIntensity !== nextAudioIntensity
  ) {
    trackAudioModeChange(nextAudioMode, nextAudioIntensity);
  }
  syncPredictedJumps(context);
  syncTuningParamsState(context);
  writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
  return {
    branchStatsChanged:
      previousBranchStatsEnabled !== useAppStore.getState().branchStatsEnabled,
    audioModeChanged: previousAudioMode !== useAppStore.getState().jukeboxAudioMode,
  };
}

export function resetExtrasDefaults(context: AppContext) {
  const { cowbellOverlay, engine, metronomeOverlay, player } = context;
  const previousAudioMode = useAppStore.getState().jukeboxAudioMode;
  useAppStore.setState({ bringItHomeMode: false });
  engine.setBringItHomeMode(false);
  cowbellOverlay.disable();
  metronomeOverlay.disable();
  metronomeOverlay.setMetronomeVolumePct(DEFAULT_METRONOME_VOLUME_PCT);
  metronomeOverlay.setBeatsPerBarOverride(null);
  metronomeOverlay.setBeatOffset(DEFAULT_METRONOME_BEAT_OFFSET);
  useAppStore.setState({
    metronomeVolumePct: DEFAULT_METRONOME_VOLUME_PCT,
    metronomeBeatsPerBar: null,
    metronomeBeatOffset: DEFAULT_METRONOME_BEAT_OFFSET,
  });
  cancelInstrumentalRender();
  useAppStore.setState({
    audioModeRenderToken: useAppStore.getState().audioModeRenderToken + (1),
  });
  useAppStore.setState({ audioModePreparing: false });
  clearModeLoadingStep();
  resetAudioModeToOff(player);
  if (previousAudioMode !== "off") {
    trackAudioModeChange("off", useAppStore.getState().audioIntensity);
    syncLiveBpmForPlaybackRate(player.getPlaybackRate?.());
  }
  updatePlayButton();
  if (
    previousAudioMode !== "off" &&
    useAppStore.getState().playMode === "jukebox" &&
    (useAppStore.getState().isRunning || useAppStore.getState().isPaused)
  ) {
    engine.syncToPlaybackPosition();
  }
  syncPredictedJumps(context);
  syncTuningParamsState(context);
  writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
}

export type TuningFormValues = {
  threshold: number;
  computedThreshold: number | null;
  crossThreshold?: number;
  computedCrossThreshold?: number | null;
  maxBranches: number;
  minProbPct: number;
  maxProbPct: number;
  rampPct: number;
  justBackwards: boolean;
  minLongBranchPercent: number;
  maxLongBranchPercent?: number;
  removeSequentialBranches: boolean;
  highlightAnchorBranch: boolean;
};

// Snapshot the engine config for the React tuning form (the read half of
// the old syncTuningUI).
export function getTuningFormValues(context: AppContext): TuningFormValues {
  const { engine } = context;
  const config = engine.getConfig();
  const graph = engine.getGraphState();
  const thresholdValue =
    config.currentThreshold === 0 && graph
      ? Math.round(graph.currentThreshold)
      : config.currentThreshold;
  // The engine's own default for this track, which is not the threshold in use
  // whenever the user has pinned one.
  const computedValue = graph ? Math.round(graph.computedThreshold) : null;
  const rawCrossThreshold = config.crossTrackThreshold ?? 0;
  const crossThresholdValue =
    rawCrossThreshold === 0 && graph?.currentCrossThreshold !== undefined
      ? Math.round(graph.currentCrossThreshold)
      : rawCrossThreshold;
  const computedCrossValue =
    graph?.computedCrossThreshold !== undefined
      ? Math.round(graph.computedCrossThreshold)
      : null;
  return {
    threshold: thresholdValue,
    computedThreshold: computedValue,
    crossThreshold: crossThresholdValue,
    computedCrossThreshold: computedCrossValue,
    maxBranches: config.maxBranches,
    minProbPct: Math.round(config.minRandomBranchChance * 100),
    maxProbPct: Math.round(config.maxRandomBranchChance * 100),
    rampPct:
      Math.round(
        config.randomBranchChanceDelta * RANDOM_BRANCH_DELTA_PERCENT_SCALE * 10,
      ) / 10,
    justBackwards: config.justBackwards,
    minLongBranchPercent: config.justLongBranches
      ? (config.minLongBranchPercent ?? DEFAULT_MIN_LONG_BRANCH_PERCENT)
      : 0,
    maxLongBranchPercent:
      config.maxLongBranchPercent && config.maxLongBranchPercent > 0
        ? config.maxLongBranchPercent
        : 100,
    removeSequentialBranches: config.removeSequentialBranches,
    highlightAnchorBranch: useAppStore.getState().highlightAnchorBranch,
  };
}

// Reports which controls the user touched, never the values they chose: the
// values are high-cardinality and unreadable as GA dimensions.
export function changedTuningControls(
  previous: TuningFormValues,
  next: TuningFormValues,
): string[] {
  const controls: string[] = [];
  if (previous.threshold !== next.threshold) {
    controls.push("threshold");
  }
  if ((previous.crossThreshold ?? 0) !== (next.crossThreshold ?? 0)) {
    controls.push("cross_threshold");
  }
  if (previous.maxBranches !== next.maxBranches) {
    controls.push("maxBranches");
  }
  if (
    previous.minProbPct !== next.minProbPct ||
    previous.maxProbPct !== next.maxProbPct ||
    previous.rampPct !== next.rampPct
  ) {
    controls.push("branch_probability");
  }
  if (previous.minLongBranchPercent !== next.minLongBranchPercent) {
    controls.push("min_branch_length");
  }
  if (
    (previous.maxLongBranchPercent ?? 100) !==
    (next.maxLongBranchPercent ?? 100)
  ) {
    controls.push("max_branch_length");
  }
  if (previous.justBackwards !== next.justBackwards) {
    controls.push("just_backwards");
  }
  if (previous.removeSequentialBranches !== next.removeSequentialBranches) {
    controls.push("sequential");
  }
  if (previous.highlightAnchorBranch !== next.highlightAnchorBranch) {
    controls.push("anchor_highlight");
  }
  return controls;
}

/**
 * Applies tuning form values to the engine, rebuilds the jump graph, and syncs
 * resolved auto thresholds and URL tuning state.
 */
export function applyTuningChanges(
  context: AppContext,
  form: TuningFormValues,
): TuningFormValues {
  const { engine, jukebox } = context;
  const previousForm = getTuningFormValues(context);
  const threshold = form.threshold;
  const computed = form.computedThreshold;
  // The slider has no way to show "auto" — it displays the number the track resolved to — so
  // setting it to that number is the same as never having moved it, and both build the same
  // graph. Landing there returns the threshold to auto whatever it was before.
  const useAutoThreshold =
    computed !== null &&
    Number.isFinite(computed) &&
    threshold === computed;
  const crossThreshold = form.crossThreshold ?? 0;
  const computedCross = form.computedCrossThreshold ?? null;
  const useAutoCrossThreshold =
    crossThreshold <= 0 ||
    (computedCross !== null &&
      Number.isFinite(computedCross) &&
      crossThreshold === computedCross);
  let minProb = form.minProbPct / 100;
  let maxProb = form.maxProbPct / 100;
  const ramp = form.rampPct / RANDOM_BRANCH_DELTA_PERCENT_SCALE;
  if (minProb > maxProb) {
    [minProb, maxProb] = [maxProb, minProb];
  }
  const maxBranches = clampMaxBranches(form.maxBranches);
  const rawMaxPct = form.maxLongBranchPercent ?? 100;
  const sliderMaxPct =
    rawMaxPct > 0 && rawMaxPct < 100
      ? Math.max(1, Math.round(rawMaxPct))
      : 100;
  const maxLongBranchPercent = sliderMaxPct >= 100 ? 0 : sliderMaxPct;
  engine.updateConfig({
    maxBranches,
    currentThreshold: useAutoThreshold ? 0 : threshold,
    crossTrackThreshold: useAutoCrossThreshold ? 0 : crossThreshold,
    minRandomBranchChance: minProb,
    maxRandomBranchChance: maxProb,
    randomBranchChanceDelta: ramp,
    justBackwards: form.justBackwards,
    justLongBranches: form.minLongBranchPercent > 0,
    minLongBranchPercent:
      form.minLongBranchPercent > 0
        ? form.minLongBranchPercent
        : DEFAULT_MIN_LONG_BRANCH_PERCENT,
    maxLongBranchPercent,
    removeSequentialBranches: form.removeSequentialBranches,
  });
  useAppStore.setState({ highlightAnchorBranch: form.highlightAnchorBranch });
  storeAnchorHighlight(useAppStore.getState().highlightAnchorBranch);
  jukebox?.setAnchorHighlightEnabled(useAppStore.getState().highlightAnchorBranch);
  engine.rebuildGraph();
  useAppStore.setState({ vizData: engine.getVisualizationData() });
  const data = useAppStore.getState().vizData;
  if (data) {
    jukebox?.setData(data);
  }
  syncPredictedJumps(context);
  const graph = engine.getGraphState();
  updateTrackInfo(context);
  let nextThreshold = threshold;
  let nextComputed: number | null;
  let nextCrossThreshold = crossThreshold;
  let nextComputedCross: number | null;
  if (graph) {
    if (useAutoThreshold) {
      nextThreshold = Math.max(0, Math.round(graph.currentThreshold));
    }
    nextComputed = Math.round(graph.computedThreshold);
    if (graph.currentCrossThreshold !== undefined) {
      if (useAutoCrossThreshold) {
        nextCrossThreshold = Math.max(
          0,
          Math.round(graph.currentCrossThreshold),
        );
      }
      nextComputedCross =
        graph.computedCrossThreshold !== undefined
          ? Math.round(graph.computedCrossThreshold)
          : null;
    } else {
      nextComputedCross = null;
    }
  } else {
    nextComputed = form.computedThreshold;
    nextComputedCross = form.computedCrossThreshold ?? null;
  }
  for (const control of changedTuningControls(previousForm, form)) {
    trackEvent("tune", { control });
  }
  syncTuningParamsState(context);
  writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
  return {
    ...form,
    maxBranches,
    maxLongBranchPercent: sliderMaxPct,
    threshold: nextThreshold,
    computedThreshold: nextComputed,
    crossThreshold: nextCrossThreshold,
    computedCrossThreshold: nextComputedCross,
    minProbPct: Math.round(minProb * 100),
    maxProbPct: Math.round(maxProb * 100),
  };
}

export function hasNonDefaultTuning(context: AppContext): boolean {
  return engineHasNonDefaultTuning(context.engine, context.defaultConfig);
}

/**
 * Resets engine tuning parameters and deleted/anchor overrides back to defaults
 * while preserving the active multi-track cross-song branch restriction.
 */
export function resetTuningDefaults(context: AppContext) {
  const { engine, jukebox } = context;
  discardCustomAnchorEdit(context);
  engine.clearDeletedEdges();
  const {
    multiTrackEnabled,
    crossTrackOnly,
    coverSyncEnabled,
    timeSignatureBranchingEnabled,
    timeSignatureBranchMode,
    timeSignatureNumerator,
    timeSignatureDenominator,
    timeSignatureTrackOffsets,
    timeSignatureSimilarityRestrictEnabled,
    timeSignatureSimilarityNumerator,
    timeSignatureSimilarityDenominator,
  } = useAppStore.getState();
  engine.updateConfig({
    ...context.defaultConfig,
    crossTrackOnly: multiTrackEnabled ? crossTrackOnly : false,
    crossTrackThreshold: 0,
    coverSync: multiTrackEnabled ? coverSyncEnabled : false,
    timeSignatureBranching: multiTrackEnabled
      ? timeSignatureBranchingEnabled
      : false,
    timeSignatureBranchMode: multiTrackEnabled
      ? timeSignatureBranchMode
      : DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
    timeSignatureNumerator: multiTrackEnabled
      ? timeSignatureNumerator
      : DEFAULT_TIME_SIGNATURE_NUMERATOR,
    timeSignatureDenominator: multiTrackEnabled
      ? timeSignatureDenominator
      : DEFAULT_TIME_SIGNATURE_DENOMINATOR,
    timeSignatureTrackOffsets: multiTrackEnabled
      ? [...timeSignatureTrackOffsets]
      : [],
    timeSignatureSimilarityRestrict: multiTrackEnabled
      ? timeSignatureSimilarityRestrictEnabled
      : false,
    timeSignatureSimilarityNumerator: multiTrackEnabled
      ? timeSignatureSimilarityNumerator
      : DEFAULT_TIME_SIGNATURE_NUMERATOR,
    timeSignatureSimilarityDenominator: multiTrackEnabled
      ? timeSignatureSimilarityDenominator
      : DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  });
  if (!multiTrackEnabled) {
    useAppStore.setState({
      timeSignatureSimilarityRestrictEnabled: false,
      timeSignatureSimilarityNumerator: DEFAULT_TIME_SIGNATURE_NUMERATOR,
      timeSignatureSimilarityDenominator: DEFAULT_TIME_SIGNATURE_DENOMINATOR,
      timeSignatureTrackOffsets: [],
    });
  }
  engine.rebuildGraph();
  useAppStore.setState({ vizData: engine.getVisualizationData() });
  const data = useAppStore.getState().vizData;
  if (data) {
    jukebox?.setData(data);
  }
  syncPredictedJumps(context);
  syncDeletedEdgeState(context);
  // Serialize am/ai only in jukebox mode — autocanonizer URLs carry no tuning.
  const { jukeboxAudioMode, audioIntensity, playMode } = useAppStore.getState();
  const audioModeParams = new URLSearchParams();
  if (playMode === "jukebox") {
    appendAudioModeParams(audioModeParams, jukeboxAudioMode, audioIntensity);
  }
  const serialized = audioModeParams.toString();
  useAppStore.setState({
    tuningParams: serialized.length > 0 ? serialized : null,
  });
  writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
  updateTrackInfo(context);
}
