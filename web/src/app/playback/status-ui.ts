import { countTuningBranches } from "@forever-jukebox/shared";
import type { BpmBarPulseBeat } from "../bpmBarTimeSignature";
import {
  BPM_CHANGE_CLEAR_TIMEOUT_MS,
  clearBpmTrackerTrend,
  createBpmTrackerState,
  formatBpmText,
  resolveEffectivePlaybackRate,
  resolveLocalBeatBpm,
  stepBpmTracker,
  type BpmBeatSample,
  type BpmTrackerState,
} from "../liveBpm";
import type { AppContext } from "../context";
import { formatDuration } from "@forever-jukebox/shared/ui/format";
import { useAppStore } from "../store";

export type TuningModalTab = "tuning" | "extras";

let bpmTrackerState: BpmTrackerState = createBpmTrackerState();
let bpmTrendClearTimerId: number | null = null;

/**
 * Cancels any pending fallback timeout for clearing the BPM trend arrow.
 */
function clearBpmTrendTimer(): void {
  if (bpmTrendClearTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(bpmTrendClearTimerId);
  }
  bpmTrendClearTimerId = null;
}

/**
 * Commits the tracker's formatted BPM string and trend direction to the store
 * only when the displayed values have changed.
 */
function commitBpmToStore(): void {
  const bpmText = formatBpmText(bpmTrackerState.currentBpm);
  const bpmTrend = bpmTrackerState.trend;
  const current = useAppStore.getState();
  if (current.bpmText !== bpmText || current.bpmTrend !== bpmTrend) {
    useAppStore.setState({ bpmText, bpmTrend });
  }
}

/**
 * Schedules a fallback timeout so a detected tempo-change arrow clears even if
 * playback pauses or stops emitting beat updates.
 */
function scheduleBpmTrendClear(): void {
  clearBpmTrendTimer();
  if (typeof window === "undefined") {
    return;
  }
  bpmTrendClearTimerId = window.setTimeout(() => {
    bpmTrendClearTimerId = null;
    bpmTrackerState = clearBpmTrackerTrend(bpmTrackerState);
    commitBpmToStore();
  }, BPM_CHANGE_CLEAR_TIMEOUT_MS);
}

/**
 * Steps the live BPM tracker with a new effective BPM reading and keeps the
 * fallback clear timer and store values synchronized.
 */
function applyLiveBpmSample(rawBpm: number | null, advanceBeat: boolean): void {
  const prev = bpmTrackerState;
  const next = stepBpmTracker(prev, rawBpm, { advanceBeat });
  bpmTrackerState = next;
  if (next.trend === null) {
    clearBpmTrendTimer();
  } else if (
    next.trend !== prev.trend ||
    (next.currentBpm !== prev.currentBpm && next.beatsSinceChange === 0)
  ) {
    scheduleBpmTrendClear();
  }
  commitBpmToStore();
}

/**
 * Resets live BPM tracking to the track's baseline tempo scaled by the active
 * playback rate, clearing any active change arrow.
 */
export function resetLiveBpm(baseTempoBpm?: number | null): void {
  clearBpmTrendTimer();
  const state = useAppStore.getState();
  const resolvedBase =
    baseTempoBpm !== undefined ? baseTempoBpm : state.trackTempoBpm;
  if (baseTempoBpm !== undefined && state.trackTempoBpm !== baseTempoBpm) {
    useAppStore.setState({ trackTempoBpm: baseTempoBpm });
  }
  const rate = resolveEffectivePlaybackRate(
    state.playMode,
    state.jukeboxAudioMode,
    state.audioIntensity,
  );
  bpmTrackerState = createBpmTrackerState(
    resolvedBase !== null ? resolvedBase * rate : null,
  );
  commitBpmToStore();
}

/**
 * Updates the live BPM readout from the newly entered beat and current playback
 * rate, triggering an arrow when BPM shifts by more than 10 BPM.
 */
export function updateLiveBpmForBeat(
  beat: BpmBeatSample | null | undefined,
  options?: {
    beats?: readonly BpmBeatSample[] | null;
    beatIndex?: number | null;
    playbackRate?: number | null;
  },
): void {
  const state = useAppStore.getState();
  const localBpm =
    resolveLocalBeatBpm(beat, options?.beats, options?.beatIndex) ??
    state.trackTempoBpm;
  const rate = resolveEffectivePlaybackRate(
    state.playMode,
    state.jukeboxAudioMode,
    state.audioIntensity,
    options?.playbackRate,
  );
  applyLiveBpmSample(localBpm !== null ? localBpm * rate : null, true);
}

/**
 * Recomputes the displayed live BPM when the audio mode or playback rate
 * changes mid-track without advancing the beat-hold counter.
 */
export function syncLiveBpmForPlaybackRate(
  playbackRate?: number | null,
): void {
  const state = useAppStore.getState();
  const beats = state.vizData?.beats;
  const activeBeat =
    state.lastBeatIndex !== null && beats
      ? beats[state.lastBeatIndex]
      : undefined;
  const baseBpm =
    resolveLocalBeatBpm(activeBeat, beats, state.lastBeatIndex) ??
    state.trackTempoBpm;
  const rate = resolveEffectivePlaybackRate(
    state.playMode,
    state.jukeboxAudioMode,
    state.audioIntensity,
    playbackRate,
  );
  applyLiveBpmSample(baseBpm !== null ? baseBpm * rate : null, false);
}

export function updateListenTimeDisplay() {
  const { playTimerMs, lastPlayStamp } = useAppStore.getState();
  const now = performance.now();
  const totalMs = playTimerMs + (lastPlayStamp !== null ? now - lastPlayStamp : 0);
  // Polled ~5Hz but the displayed value only changes per second; skip the
  // redundant writes so subscribers aren't woken four times a second for the
  // same string.
  const listenTimeText = formatDuration(totalMs / 1000);
  if (useAppStore.getState().listenTimeText !== listenTimeText) {
    useAppStore.setState({ listenTimeText });
  }
}

export function updateTrackInfo(context: AppContext) {
  const { engine, player } = context;
  const { trackDurationSec, vizData, deletedEdgeIds } = useAppStore.getState();
  const graph = engine.getGraphState();
  const resolvedDuration =
    typeof trackDurationSec === "number" && Number.isFinite(trackDurationSec)
      ? trackDurationSec
      : player.getDuration();
  const durationText =
    typeof resolvedDuration === "number" && Number.isFinite(resolvedDuration)
      ? formatDuration(resolvedDuration)
      : "00:00:00";
  const branchCount = vizData
    ? countTuningBranches(vizData)
    : (graph?.allEdges.filter((edge) => !edge.deleted).length ?? 0);
  const deletedCount = graph
    ? graph.allEdges.filter((edge) => edge.deleted).length
    : deletedEdgeIds.length;
  // The React info modal renders this store state.
  useAppStore.setState({
    trackInfo: {
      durationText,
      totalBeats: graph ? graph.totalBeats : 0,
      branchCount,
      deletedCount,
    },
  });
}

// React renders this pulse marker onto #viz-stats (and its active bar segment).
export function pulseVizStats(
  beatIndex?: number | null,
  beat?: BpmBarPulseBeat | null,
) {
  if (!useAppStore.getState().bpmBarEnabled) {
    return;
  }
  useAppStore.setState({
    vizStatsPulseId: useAppStore.getState().vizStatsPulseId + 1,
    vizStatsPulseBeatIndex:
      typeof beatIndex === "number" && beatIndex >= 0 ? beatIndex : null,
    vizStatsPulseBeat: beat ?? null,
  });
}

// The React transport buttons derive icon/label/disabled from the store;
// only the play-tab pulse needs an explicit write here.
export function updatePlayButton() {
  const { isRunning, activeTabId, setPlayTabPulsing } = useAppStore.getState();
  setPlayTabPulsing(isRunning && activeTabId !== "play");
}

export function updateVizVisibility() {
  // Panel visibility and resize-on-reveal are derived in <VizContainer>;
  // only the play-tab pulse remains imperative.
  updatePlayButton();
}

// The React volume panel renders this store value.
export function syncVolumeUI(context: AppContext) {
  const { player } = context;
  useAppStore.setState({ volumePct: Math.round(player.getVolume() * 100) });
}

// Fan a 0–100 volume percentage out to every audio sink: the main player, the
// autocanonizer (only once its viz controller is attached), and the cowbell
// overlay. Centralised so the pct→fraction conversion can't drift — a missing
// /100 here ships audio 100x too loud.
export function setMasterVolume(context: AppContext, volumePct: number) {
  const linear = Math.max(0, Math.min(1, volumePct / 100));
  const volume = Math.pow(linear, 1.5);
  context.player.setVolume(volume);
  context.autocanonizer?.setVolume(volume);
  context.wubmachine?.setVolume(volume);
  context.cowbellOverlay.setVolume(volume);
  context.metronomeOverlay.setVolume(volume);
}

export function setAutocanonizerStreamPans(
  context: AppContext,
  mainPan: number,
  otherPan: number,
) {
  context.autocanonizer?.setStreamPans(mainPan / 100, otherPan / 100);
}

/**
 * Forwards percentage-based stream gain trims (0–200%) to the
 * AutocanonizerController as linear multipliers.
 */
export function setAutocanonizerStreamGains(
  context: AppContext,
  mainGainPct: number,
  otherGainPct: number,
) {
  context.autocanonizer?.setStreamGains?.(mainGainPct / 100, otherGainPct / 100);
}

function openTuningTab(context: AppContext, tab: "tuning" | "extras") {
  syncVolumeUI(context);
  const state = useAppStore.getState();
  const hasExtrasTab = state.playMode === "jukebox";
  useAppStore.setState({
    tuningModalOpen: !state.tuningModalOpen,
    tuningModalTab: tab === "extras" && hasExtrasTab ? "extras" : "tuning",
  });
}

export function openTuning(context: AppContext) {
  openTuningTab(context, "tuning");
}

export function openExtras(context: AppContext) {
  openTuningTab(context, "extras");
}

export function closeTuning() {
  useAppStore.setState({ tuningModalOpen: false });
}

export function openInfo(context: AppContext) {
  updateTrackInfo(context);
  useAppStore.setState((state) => ({ infoModalOpen: !state.infoModalOpen }));
}

export function closeInfo() {
  useAppStore.setState({ infoModalOpen: false });
}
