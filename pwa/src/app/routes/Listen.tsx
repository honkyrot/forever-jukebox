import React from "react";
import "@/app/i18n";
import { Link, useNavigate } from "react-router-dom";
import { AnalysisWorkerClient } from "@/core/infrastructure/analysis/AnalysisWorkerClient";
import { AudioDecoder } from "@/core/infrastructure/audio/AudioDecoder";
import {
  createAnalysisCache,
  trimRenderedTracks,
} from "@/core/infrastructure/cache/analysisCache";
import { setFileHandle } from "@/core/infrastructure/cache/fileHandleStore";
import {
  loadTuning,
  removeTuning,
  saveTuning,
} from "@/core/infrastructure/cache/tuningStore";
import { AnalyzeAudioUseCase, AnalyzeStage } from "@/core/application/usecases/analyzeAudio";
import type { AnalysisOutput } from "@/shared/analysis-schema/schema";
import {
  BufferedAudioPlayer,
  type JukeboxAudioMode,
} from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import { CowbellOverlayService } from "@forever-jukebox/shared/audio/CowbellOverlayService";
import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_METRONOME_VOLUME_PCT,
  MetronomeOverlayService,
  clampMetronomeVolumePct,
  detectTrackBeatsPerBar,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import {
  DEFAULT_AUDIO_MODE_INTENSITY,
  audioModeChangeAffectsPlayback,
  clampAudioModeIntensity,
} from "@forever-jukebox/shared/audio/audioModes";
import { getOrCreateSwingBuffer } from "@forever-jukebox/shared/audio/swingBufferCache";
import { renderSwingBuffer } from "@forever-jukebox/shared/audio/swingRenderer";
import {
  cancelInstrumentalRender,
  renderInstrumentalBuffer,
} from "@forever-jukebox/shared/audio/instrumentalRenderer";
import {
  DEFAULT_JUKEBOX_CONFIG,
  DEFAULT_MIN_LONG_BRANCH_PERCENT,
  DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
  DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  DEFAULT_TIME_SIGNATURE_NUMERATOR,
  Edge,
  JukeboxEngine,
  clampMaxBranches,
  clampTimeSignatureDenominator,
  clampTimeSignatureNumerator,
  clampTimeSignatureTrackOffset,
  countTuningBranches,
  findBackwardTwin,
  hasNonDefaultExtras,
  hasNonDefaultTuning,
  isCustomAnchorEdge,
  normalizeAnalysis,
  normalizeTimeSignatureBranchMode,
  type QuantumBase,
  type TimeSignatureBranchMode,
  type TrackAnalysis,
} from "@forever-jukebox/shared";
import {
  visualizationSeparatesPairedEdges,
} from "@forever-jukebox/shared/constants/visualization";
import {
  createToastQueue,
} from "@forever-jukebox/shared/ui/toastQueue";
import {
  AutocanonizerController,
  type AutocanonizerMixAlignmentMode,
  type AutocanonizerQuadBranchMode,
  type AutocanonizerSingleVoiceCount,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerController";
import { SongSyncController } from "@forever-jukebox/shared/songsync/SongSyncController";
import { WubMachineController } from "@forever-jukebox/shared/wubmachine/WubMachineController";
import {
  renderWubMachineBuffer,
  type WubMachineRender,
} from "@forever-jukebox/shared/wubmachine/wubMachineRender";
import { JukeboxController } from "@forever-jukebox/shared/viz/JukeboxController";
import type { VisualPreferences } from "@forever-jukebox/shared/viz/JukeboxViz";
import { useAppState } from "../state/AppState";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { useMarquee } from "./listen/useMarquee";
import { useTranslation } from "react-i18next";
import { applyTheme, resolveStoredTheme, type ThemeName } from "../theme";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import type { TuningModalTab } from "./listen/types";
import {
  resolveAudioIntensityFromUrl,
  resolveAudioModeFromUrl,
  writeAudioModeToUrl,
} from "./listen/audioMode";
import {
  resolveStoredAnchorHighlight,
  resolveStoredBranchStatsEnabled,
  resolveStoredCustomAnchorEnabled,
  resolveStoredFinishOutSong,
  resolveStoredVisualizationIndex,
  resolveStoredVolume,
  resolveStoredWubMachineLoop,
  storeAnchorHighlight,
  storeBranchStatsEnabled,
  storeCustomAnchorEnabled,
  storeFinishOutSong,
  storeVisualizationIndex,
  storeVolume,
  storeWubMachineLoop,
} from "./listen/preferences";
import {
  formatTrackTitle,
  playControlIcon,
  playControlText,
  type PreparingAudioMode,
} from "./listen/labels";
import {
  RANDOM_BRANCH_DELTA_PERCENT_SCALE,
  type ExtrasFormState,
  type TuneFormState,
} from "./listen/tuning";
import { deriveBranchStats, nextEdgeIndex } from "./listen/branches";
import { createSessionSeed } from "./listen/browser";
import {
  ShortcutToastStack,
  type ShortcutToastQueue,
} from "./listen/ShortcutToastStack";
import { BranchStatsPopup } from "./listen/BranchStatsPopup";
import {
  CustomAnchorButton,
  CustomAnchorInfo,
  CustomAnchorToolbar,
} from "@forever-jukebox/shared/ui/CustomAnchorEditor";
import { customAnchorLabels, useCustomAnchorEditor } from "./listen/useCustomAnchorEditor";
import { ExportModal } from "./listen/ExportModal";
import { InfoModal } from "./listen/InfoModal";
import { MixQueueModal } from "./listen/MixQueueModal";
import { PanPopover } from "./listen/PanPopover";
import { SongSyncMixerPopover } from "./listen/SongSyncMixerPopover";
import { PlayMenu } from "./listen/PlayMenu";
import { SettingsModal } from "./listen/SettingsModal";
import { StatusPanel, liveLoading, type PreparingPhase } from "./listen/StatusPanel";
import { usePresentedLoading } from "@forever-jukebox/shared/ui/LoadingProgress";
import { TuningModal, type SongSyncTrackUiState } from "./listen/TuningModal";
import { VizInfo } from "./listen/VizInfo";
import { createPlaybackCounters } from "./listen/playbackCounters";
import { VizTop } from "./listen/VizTop";
import { VolumePopover } from "./listen/VolumePopover";
import { useAudioExport } from "./listen/useAudioExport";
import { useFullscreenSession } from "./listen/useFullscreenSession";
import { useListenHotkeys } from "./listen/useListenHotkeys";
import { useSleepTimer } from "./listen/useSleepTimer";
import { useVizPopovers } from "./listen/useVizPopovers";
import {
  BPM_CHANGE_CLEAR_TIMEOUT_MS,
  clearBpmTrackerTrend,
  createBpmTrackerState,
  formatBpmText,
  resolveEffectivePlaybackRate,
  resolveLocalBeatBpm,
  resolveTrackBaseTempoBpm,
  stepBpmTracker,
  type BpmBeatSample,
  type BpmTrackerState,
} from "./listen/liveBpm";
import {
  isBpmBarDownbeat,
  isSmoothBpmBarStyle,
  normalizeBpmBarStyle,
  normalizeBpmBarTimeSignatureMode,
  resolveBpmBarActiveSegment,
  resolveBpmBarSmoothAnimation,
  resolveEffectiveMetronomeConfig,
  resolveStoredBpmBarBeatOffsetForTrack,
  resolveStoredBpmBarDenominator,
  resolveStoredBpmBarNumerator,
  resolveStoredBpmBarStyle,
  resolveStoredBpmBarTimeSignatureMode,
  storeBpmBarBeatOffsetForTrack,
  storeBpmBarDenominator,
  storeBpmBarNumerator,
  storeBpmBarStyle,
  storeBpmBarTimeSignatureMode,
  type BpmBarPulseBeat,
  type BpmBarStyle,
  type BpmBarTimeSignatureInput,
  type BpmBarTimeSignatureMode,
} from "./listen/bpmBarTimeSignature";
import {
  clampBranchLookaheadCount,
  resolveStoredBranchLookaheadCount,
  resolveStoredBranchLookaheadEnabled,
  storeBranchLookaheadCount,
  storeBranchLookaheadEnabled,
} from "./listen/branchLookahead";
import {
  resolveStoredAudioBalance,
  storeAudioBalance,
} from "./listen/audioBalance";
import {
  resolveStoredBpmBarEnabled,
  resolveStoredVisualPreferences,
  storeBpmBarEnabled,
  storeVisualPreferences,
} from "./listen/visualPreferences";
import {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_AUTOCANONIZER_MIX_TRACKS,
  MAX_MIX_TRACKS,
  buildAutocanonizerMix,
  buildJukeboxMix,
  buildSongSyncMix,
  clampMixTrackGainPct,
  resolveLocalMixSources,
  type LoadedLocalMixSource,
} from "./listen/localMix";
import type { AudioFileEntry } from "@/ui/components/DropZone";

const VIZ_CLASS_NAMES: Record<PlayMode, string> = {
  jukebox: "",
  autocanonizer: "is-canonizer",
  songsync: "is-songsync",
  wubmachine: "is-wubmachine",
};

function createDefaultTuneForm(
  volume: number,
  highlightAnchorBranch: boolean,
): TuneFormState {
  return {
    threshold: 0,
    computedThreshold: 0,
    crossThreshold: 0,
    computedCrossThreshold: null,
    maxBranches: DEFAULT_JUKEBOX_CONFIG.maxBranches,
    minProb: Math.round(DEFAULT_JUKEBOX_CONFIG.minRandomBranchChance * 100),
    maxProb: Math.round(DEFAULT_JUKEBOX_CONFIG.maxRandomBranchChance * 100),
    ramp:
      Math.round(
        DEFAULT_JUKEBOX_CONFIG.randomBranchChanceDelta *
          RANDOM_BRANCH_DELTA_PERCENT_SCALE *
          10,
      ) / 10,
    volume,
    highlightAnchorBranch,
    justBackwards: DEFAULT_JUKEBOX_CONFIG.justBackwards,
    minLongBranchPercent: 0,
    maxLongBranchPercent: 100,
    removeSequentialBranches: DEFAULT_JUKEBOX_CONFIG.removeSequentialBranches,
  };
}

export function Listen({ isActive = true }: { isActive?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appState = useAppState();
  const {
    file,
    fileHandle,
    setIsListenLoading,
    isSettingsOpen,
    setIsSettingsOpen,
  } = appState;
  const mixQueue = appState.mixQueue ?? [];
  const activeQueueIndex = appState.activeQueueIndex ?? -1;
  const setMixAddSticky = appState.setMixAddSticky;
  const addFilesToMixQueue = appState.addFilesToMixQueue;
  const removeFromMixQueue = appState.removeFromMixQueue;
  const moveMixQueueItem = appState.moveMixQueueItem;
  const clearMixQueue = appState.clearMixQueue;
  const selectMixQueueIndex = appState.selectMixQueueIndex;
  const updateMixQueueTrackMeta = appState.updateMixQueueTrackMeta;

  const initialAudioMode = React.useMemo(() => resolveAudioModeFromUrl(), []);
  const initialAudioIntensity = React.useMemo(
    () => resolveAudioIntensityFromUrl(),
    [],
  );
  const initialAudioBalance = React.useMemo(
    () => resolveStoredAudioBalance(),
    [],
  );

  const [analysis, setAnalysis] = React.useState<AnalysisOutput | null>(null);
  const [mergedAnalysis, setMergedAnalysis] =
    React.useState<TrackAnalysis | null>(null);
  const [readyFileKey, setReadyFileKey] = React.useState<string | null>(null);
  const [progressStage, setProgressStage] = React.useState<AnalyzeStage>("loading");
  const [stageProgress, setStageProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = React.useState(false);

  const [isRunning, setIsRunning] = React.useState(false);
  const [isPaused, setIsPaused] = React.useState(false);
  const [counters] = React.useState(createPlaybackCounters);
  const [autocanonizerMainPan, setAutocanonizerMainPan] = React.useState(
    initialAudioBalance.mainPan,
  );
  const [autocanonizerOtherPan, setAutocanonizerOtherPan] = React.useState(
    initialAudioBalance.otherPan,
  );
  const [autocanonizerPinkPan, setAutocanonizerPinkPan] = React.useState(
    initialAudioBalance.pinkPan,
  );
  const [autocanonizerGoldPan, setAutocanonizerGoldPan] = React.useState(
    initialAudioBalance.goldPan,
  );
  const [autocanonizerMainGainPct, setAutocanonizerMainGainPct] =
    React.useState(DEFAULT_MIX_TRACK_GAIN_PCT);
  const [autocanonizerOtherGainPct, setAutocanonizerOtherGainPct] =
    React.useState(DEFAULT_MIX_TRACK_GAIN_PCT);
  const [autocanonizerPinkGainPct, setAutocanonizerPinkGainPct] =
    React.useState(DEFAULT_MIX_TRACK_GAIN_PCT);
  const [autocanonizerGoldGainPct, setAutocanonizerGoldGainPct] =
    React.useState(DEFAULT_MIX_TRACK_GAIN_PCT);

  const [wubMachineDurationSeconds, setWubMachineDurationSeconds] =
    React.useState(0);
  const [loopTrack, setLoopTrack] = React.useState<boolean>(() =>
    resolveStoredWubMachineLoop(),
  );
  const [selectedEdge, setSelectedEdge] = React.useState<Edge | null>(null);
  const [isTuningOpen, setIsTuningOpen] = React.useState(false);
  const [isInfoOpen, setIsInfoOpen] = React.useState(false);
  const [isQueueOpen, setIsQueueOpen] = React.useState(false);
  const {
    sleepTimer,
    pendingSleepTimerDurationMs,
    setPendingSleepTimerDurationMs,
    setSleepTimer,
  } = useSleepTimer({ isSettingsOpen, onExpire: stopPlayback });
  const [theme, setTheme] = React.useState<ThemeName>(() =>
    resolveStoredTheme(),
  );
  const [bringItHomeMode, setBringItHomeMode] = React.useState(false);
  const [branchStatsEnabled, setBranchStatsEnabled] = React.useState<boolean>(
    () => resolveStoredBranchStatsEnabled(),
  );
  const [customAnchorEnabled, setCustomAnchorEnabled] = React.useState<boolean>(
    () => resolveStoredCustomAnchorEnabled(),
  );
  const [jukeboxAudioMode, setJukeboxAudioMode] =
    React.useState<JukeboxAudioMode>(initialAudioMode);
  // Mirrors jukeboxAudioMode for async callbacks that outlive their render.
  const jukeboxAudioModeRef = React.useRef<JukeboxAudioMode>(initialAudioMode);
  const [audioIntensity, setAudioIntensity] = React.useState(
    initialAudioIntensity,
  );
  const audioIntensityRef = React.useRef(initialAudioIntensity);
  const [metronomeEnabled, setMetronomeEnabled] = React.useState(false);
  const [metronomeVolumePct, setMetronomeVolumePct] = React.useState(
    DEFAULT_METRONOME_VOLUME_PCT,
  );
  const [detectedBeatsPerBar, setDetectedBeatsPerBar] = React.useState(
    DEFAULT_BEATS_PER_BAR,
  );
  // Swing and Instrumental pre-render their buffers; one render at a time.
  const [preparingMode, setPreparingMode] =
    React.useState<PreparingAudioMode>(null);
  const [preparingPhase, setPreparingPhase] =
    React.useState<PreparingPhase>(null);
  const [preparingProgress, setPreparingProgress] = React.useState(0);
  const [modelDownloaded, setModelDownloaded] = React.useState(false);
  // A failed or cancelled render hides the loading panel instead of playing it out.
  const [prepAborted, setPrepAborted] = React.useState(false);
  const [tuningNonDefault, setTuningNonDefault] = React.useState(false);
  const [activeVizIndex, setActiveVizIndex] = React.useState(() =>
    resolveStoredVisualizationIndex(),
  );
  const [playMode, setPlayMode] = React.useState<PlayMode>("jukebox");
  const [highlightAnchorBranch, setHighlightAnchorBranch] = React.useState<boolean>(
    () => resolveStoredAnchorHighlight(),
  );
  const [finishOutSong, setFinishOutSong] = React.useState<boolean>(() =>
    resolveStoredFinishOutSong(),
  );
  const [initialVolume] = React.useState(resolveStoredVolume);

  // Visual preferences, BPM bar & lookahead state.
  const [visualPreferences, setVisualPreferences] =
    React.useState<VisualPreferences>(() => resolveStoredVisualPreferences());
  const [bpmBarEnabled, setBpmBarEnabled] = React.useState<boolean>(() =>
    resolveStoredBpmBarEnabled(),
  );
  const bpmBarEnabledRef = React.useRef(bpmBarEnabled);
  const [bpmBarStyle, setBpmBarStyle] = React.useState<BpmBarStyle>(() =>
    resolveStoredBpmBarStyle(),
  );
  const [bpmBarTimeSignatureMode, setBpmBarTimeSignatureMode] =
    React.useState<BpmBarTimeSignatureMode>(() =>
      resolveStoredBpmBarTimeSignatureMode(),
    );
  const [bpmBarNumerator, setBpmBarNumerator] = React.useState<number>(() =>
    resolveStoredBpmBarNumerator(),
  );
  const [bpmBarDenominator, setBpmBarDenominator] = React.useState<number>(() =>
    resolveStoredBpmBarDenominator(),
  );
  const [bpmBarBeatOffset, setBpmBarBeatOffset] = React.useState<number>(0);
  const [branchLookaheadEnabled, setBranchLookaheadEnabled] =
    React.useState<boolean>(() => resolveStoredBranchLookaheadEnabled());
  const branchLookaheadEnabledRef = React.useRef(branchLookaheadEnabled);
  const [branchLookaheadCount, setBranchLookaheadCount] = React.useState<number>(
    () => resolveStoredBranchLookaheadCount(),
  );
  const branchLookaheadCountRef = React.useRef(branchLookaheadCount);

  // Multi-track & Autocanonizer mix state.
  const [multiTrackEnabled, setMultiTrackEnabled] = React.useState(false);
  const multiTrackEnabledRef = React.useRef(false);
  const [mixTracksMeta, setMixTracksMeta] = React.useState<
    Array<{ title: string }>
  >([]);
  const [crossTrackOnly, setCrossTrackOnly] = React.useState(false);
  const [coverSyncEnabled, setCoverSyncEnabled] = React.useState(false);
  const [tempoSyncEnabled, setTempoSyncEnabled] = React.useState(true);
  const [normalizeVolumeEnabled, setNormalizeVolumeEnabled] =
    React.useState(false);
  const [postMixNormalizeVolumeEnabled, setPostMixNormalizeVolumeEnabled] =
    React.useState(false);
  const [mixTrackGainsPct, setMixTrackGainsPct] = React.useState<number[]>([]);
  const [timeSignatureBranchingEnabled, setTimeSignatureBranchingEnabled] =
    React.useState(false);
  const [timeSignatureBranchMode, setTimeSignatureBranchMode] =
    React.useState<TimeSignatureBranchMode>(DEFAULT_TIME_SIGNATURE_BRANCH_MODE);
  const [timeSignatureNumerator, setTimeSignatureNumerator] = React.useState(
    DEFAULT_TIME_SIGNATURE_NUMERATOR,
  );
  const [timeSignatureDenominator, setTimeSignatureDenominator] =
    React.useState(DEFAULT_TIME_SIGNATURE_DENOMINATOR);
  const [timeSignatureTrackOffsets, setTimeSignatureTrackOffsets] =
    React.useState<number[]>([]);
  const [
    timeSignatureSimilarityRestrictEnabled,
    setTimeSignatureSimilarityRestrictEnabled,
  ] = React.useState(false);
  const [timeSignatureSimilarityNumerator, setTimeSignatureSimilarityNumerator] =
    React.useState(DEFAULT_TIME_SIGNATURE_NUMERATOR);
  const [
    timeSignatureSimilarityDenominator,
    setTimeSignatureSimilarityDenominator,
  ] = React.useState(DEFAULT_TIME_SIGNATURE_DENOMINATOR);

  const [autocanonizerMixEnabled, setAutocanonizerMixEnabled] =
    React.useState(false);
  const autocanonizerMixEnabledRef = React.useRef(false);
  const [autocanonizerMixAlignment, setAutocanonizerMixAlignment] =
    React.useState<AutocanonizerMixAlignmentMode>("cover-sync");
  const [autocanonizerQuadMode, setAutocanonizerQuadMode] =
    React.useState(false);
  const [autocanonizerQuadBranchMode, setAutocanonizerQuadBranchMode] =
    React.useState<AutocanonizerQuadBranchMode>("synced");
  const [autocanonizerSingleVoiceCount, setAutocanonizerSingleVoiceCount] =
    React.useState<AutocanonizerSingleVoiceCount>(2);
  const [autocanonizerMixTrackTitles, setAutocanonizerMixTrackTitles] =
    React.useState<[string, string] | null>(null);
  const [autocanonizerOtherDurationSec, setAutocanonizerOtherDurationSec] =
    React.useState<number | null>(null);
  const [mixTitleOverride, setMixTitleOverride] = React.useState<string | null>(
    null,
  );
  const [mixDurationOverrideSec, setMixDurationOverrideSec] = React.useState<
    number | null
  >(null);
  const [isMixing, setIsMixing] = React.useState(false);

  // Song Sync & instrumental-only branching state.
  const [songSyncTracks, setSongSyncTracks] = React.useState<
    SongSyncTrackUiState[]
  >([]);
  const [songSyncTrackTimes, setSongSyncTrackTimes] = React.useState<
    Array<{ title: string; color: string; durationSec: number }>
  >([]);
  const [songSyncMasterTrackIndex, setSongSyncMasterTrackIndex] =
    React.useState(0);
  const [songSyncTempoSyncEnabled, setSongSyncTempoSyncEnabled] =
    React.useState(true);
  const [songSyncNormalizeVolumeEnabled, setSongSyncNormalizeVolumeEnabled] =
    React.useState(true);

  const [tuneForm, setTuneForm] = React.useState<TuneFormState>(() =>
    createDefaultTuneForm(initialVolume, highlightAnchorBranch),
  );
  const [extrasForm, setExtrasForm] = React.useState<ExtrasFormState>({
    branchStatsEnabled: resolveStoredBranchStatsEnabled(),
    bringItHomeMode: false,
    customAnchorEnabled: resolveStoredCustomAnchorEnabled(),
    audioMode: initialAudioMode,
    audioIntensity: initialAudioIntensity,
  });

  const vizPanelRef = React.useRef<HTMLDivElement | null>(null);
  const vizLayerRef = React.useRef<HTMLDivElement | null>(null);
  const canonizerLayerRef = React.useRef<HTMLDivElement | null>(null);
  const songSyncLayerRef = React.useRef<HTMLDivElement | null>(null);
  const wubMachineLayerRef = React.useRef<HTMLDivElement | null>(null);
  const vizStatsRef = React.useRef<HTMLDivElement | null>(null);
  const segmentRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const smoothFillRef = React.useRef<HTMLSpanElement | null>(null);
  const bpmBarRuntimeRef = React.useRef<{
    bpmBarConfig: BpmBarTimeSignatureInput | null;
    bpmBarEnabled: boolean;
    bpmBarStyle: BpmBarStyle;
    isSmoothStyle: boolean;
    playMode: PlayMode;
  }>({
    bpmBarConfig: null,
    bpmBarEnabled: true,
    bpmBarStyle: "pulse",
    isSmoothStyle: false,
    playMode: "jukebox",
  });
  const clearBpmBarPulse = React.useCallback(() => {
    const el = vizStatsRef.current;
    if (el) {
      el.classList.remove("pulse");
    }
    for (const segEl of segmentRefs.current) {
      segEl?.classList.remove("is-pulsing");
    }
    const fillEl = smoothFillRef.current;
    if (fillEl) {
      fillEl.classList.remove("is-animating", "is-downbeat");
      fillEl.style.removeProperty("--bpm-bar-from");
      fillEl.style.removeProperty("--bpm-bar-to");
      fillEl.style.removeProperty("--bpm-bar-duration");
    }
  }, []);
  const vizControllerRef = React.useRef<JukeboxController | null>(null);
  const autocanonizerRef = React.useRef<AutocanonizerController | null>(null);
  const songsyncRef = React.useRef<SongSyncController | null>(null);
  const wubmachineRef = React.useRef<WubMachineController | null>(null);
  // The loaded track's remix, kept across mode switches until the track changes.
  const wubMachineRenderRef = React.useRef<WubMachineRender | null>(null);
  const wubMachineAbortRef = React.useRef<AbortController | null>(null);
  const engineRef = React.useRef<JukeboxEngine | null>(null);
  const cachedMixSourcesRef = React.useRef<LoadedLocalMixSource[] | null>(null);
  const cachedAutocanonizerMixSourcesRef = React.useRef<
    [LoadedLocalMixSource, LoadedLocalMixSource] | null
  >(null);
  const cachedSongSyncSourcesRef = React.useRef<LoadedLocalMixSource[] | null>(
    null,
  );
  const loadedSongSyncSignatureRef = React.useRef("");
  const mixLoadGenerationRef = React.useRef(0);

  // Live BPM tracker refs.
  const bpmTrackerRef = React.useRef<BpmTrackerState>(createBpmTrackerState());
  const bpmTrendTimerRef = React.useRef<number | null>(null);
  const trackTempoBpmRef = React.useRef<number | null>(null);

  const clearBpmTrendTimer = React.useCallback(() => {
    if (bpmTrendTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(bpmTrendTimerRef.current);
    }
    bpmTrendTimerRef.current = null;
  }, []);

  const commitBpmToCounters = React.useCallback(() => {
    counters.set({
      bpmText: formatBpmText(bpmTrackerRef.current.currentBpm),
      bpmTrend: bpmTrackerRef.current.trend,
    });
  }, [counters]);

  const scheduleBpmTrendClear = React.useCallback(() => {
    clearBpmTrendTimer();
    if (typeof window === "undefined") {
      return;
    }
    bpmTrendTimerRef.current = window.setTimeout(() => {
      bpmTrendTimerRef.current = null;
      bpmTrackerRef.current = clearBpmTrackerTrend(bpmTrackerRef.current);
      commitBpmToCounters();
    }, BPM_CHANGE_CLEAR_TIMEOUT_MS);
  }, [clearBpmTrendTimer, commitBpmToCounters]);

  const applyLiveBpmSample = React.useCallback(
    (rawBpm: number | null, advanceBeat: boolean) => {
      const prev = bpmTrackerRef.current;
      const next = stepBpmTracker(prev, rawBpm, { advanceBeat });
      bpmTrackerRef.current = next;
      if (next.trend === null) {
        clearBpmTrendTimer();
      } else if (
        next.trend !== prev.trend ||
        (next.currentBpm !== prev.currentBpm && next.beatsSinceChange === 0)
      ) {
        scheduleBpmTrendClear();
      }
      commitBpmToCounters();
    },
    [clearBpmTrendTimer, commitBpmToCounters, scheduleBpmTrendClear],
  );

  const resetLiveBpm = React.useCallback(
    (baseTempoBpm?: number | null) => {
      clearBpmTrendTimer();
      const resolvedBase =
        baseTempoBpm !== undefined ? baseTempoBpm : trackTempoBpmRef.current;
      if (baseTempoBpm !== undefined) {
        trackTempoBpmRef.current = baseTempoBpm;
      }
      const rate = resolveEffectivePlaybackRate(
        playModeRef.current,
        jukeboxAudioModeRef.current,
        audioIntensityRef.current,
      );
      bpmTrackerRef.current = createBpmTrackerState(
        resolvedBase !== null ? resolvedBase * rate : null,
      );
      commitBpmToCounters();
    },
    [clearBpmTrendTimer, commitBpmToCounters],
  );

  const updateLiveBpmForBeat = React.useCallback(
    (
      beat: BpmBeatSample | null | undefined,
      options?: {
        beats?: readonly BpmBeatSample[] | null;
        beatIndex?: number | null;
        playbackRate?: number | null;
      },
    ) => {
      const localBpm =
        resolveLocalBeatBpm(beat, options?.beats, options?.beatIndex) ??
        trackTempoBpmRef.current;
      const rate = resolveEffectivePlaybackRate(
        playModeRef.current,
        jukeboxAudioModeRef.current,
        audioIntensityRef.current,
        options?.playbackRate,
      );
      applyLiveBpmSample(localBpm !== null ? localBpm * rate : null, true);
    },
    [applyLiveBpmSample],
  );

  const syncLiveBpmForPlaybackRate = React.useCallback(
    (playbackRate?: number | null) => {
      const beats = vizDataRef.current?.beats;
      const idx = lastBeatRef.current;
      const activeBeat =
        idx !== null && beats && idx >= 0 && idx < beats.length
          ? beats[idx]
          : undefined;
      const baseBpm =
        resolveLocalBeatBpm(activeBeat, beats, idx) ??
        trackTempoBpmRef.current;
      const rate = resolveEffectivePlaybackRate(
        playModeRef.current,
        jukeboxAudioModeRef.current,
        audioIntensityRef.current,
        playbackRate,
      );
      applyLiveBpmSample(baseBpm !== null ? baseBpm * rate : null, false);
    },
    [applyLiveBpmSample],
  );

  React.useEffect(() => {
    return () => {
      clearBpmTrendTimer();
    };
  }, [clearBpmTrendTimer]);

  const syncPredictedJumps = React.useCallback(() => {
    const controller = vizControllerRef.current;
    const engine = engineRef.current;
    if (!controller || typeof controller.setPredictedJumps !== "function") {
      return;
    }
    if (
      !branchLookaheadEnabledRef.current ||
      playModeRef.current !== "jukebox" ||
      !engine ||
      typeof engine.getPredictedJumps !== "function"
    ) {
      controller.setPredictedJumps([]);
      return;
    }
    controller.setPredictedJumps(
      engine.getPredictedJumps(branchLookaheadCountRef.current),
    );
  }, []);

  const customAnchor = useCustomAnchorEditor({
    engineRef,
    vizControllerRef,
    getBeats: () => vizDataRef.current?.beats ?? [],
    onAnchorChanged: () => {
      syncVizDataFromEngine();
      syncTuneFormFromEngine();
      syncPredictedJumps();
      persistCurrentTuning();
    },
  });
  const playerRef = React.useRef<BufferedAudioPlayer | null>(null);
  const cowbellOverlayRef = React.useRef<CowbellOverlayService | null>(null);
  const metronomeOverlayRef = React.useRef<MetronomeOverlayService | null>(null);
  const isRunningRef = React.useRef(false);
  const isPausedRef = React.useRef(false);
  const playModeRef = React.useRef<PlayMode>("jukebox");
  const bringItHomeModeRef = React.useRef(false);
  // Read by the hotkey handlers, which are registered by an effect that does
  // not re-run when the visualization changes.
  const activeVizIndexRef = React.useRef(activeVizIndex);
  // Last data pushed to the viz controller; every edge mutation funnels
  // through syncVizDataFromEngine, so this is as fresh as the viz itself.
  const vizDataRef = React.useRef<ReturnType<
    JukeboxEngine["getVisualizationData"]
  > | null>(null);
  const lastBeatRef = React.useRef<number | null>(null);
  const lastCowbellBeatsPlayedRef = React.useRef<number | null>(null);
  const autocanonizerMainPanRef = React.useRef(initialAudioBalance.mainPan);
  const autocanonizerOtherPanRef = React.useRef(initialAudioBalance.otherPan);
  const autocanonizerPinkPanRef = React.useRef(initialAudioBalance.pinkPan);
  const autocanonizerGoldPanRef = React.useRef(initialAudioBalance.goldPan);
  const renderTokenRef = React.useRef(0);
  const preparingModeRef = React.useRef<PreparingAudioMode>(null);
  const playTimerMsRef = React.useRef(0);
  const lastPlayStampRef = React.useRef<number | null>(null);
  const analysisRef = React.useRef<AnalysisOutput | null>(null);
  const fingerprintRef = React.useRef<string | null>(null);
  const previousFileKeyRef = React.useRef<string | null>(null);
  const {
    isVolumeOpen,
    isPanOpen,
    toggleVolume,
    togglePan,
    volumeButtonRef,
    volumePanelRef,
    panButtonRef,
    panPanelRef,
  } = useVizPopovers({ playMode });
  const { isFullscreen, onToggleFullscreen, requestWakeLockIfFullscreen } =
    useFullscreenSession({
      vizPanelRef,
      vizControllerRef,
      autocanonizerRef,
      songsyncRef,
      wubmachineRef,
      playModeRef,
    });
  // BPM bar + metronome time-signature config shared by UI, playback, and export.
  const bpmBarConfig: BpmBarTimeSignatureInput = React.useMemo(
    () => ({
      bpmBarTimeSignatureMode,
      bpmBarNumerator,
      bpmBarDenominator,
      bpmBarBeatOffset,
      multiTrackEnabled,
      coverSyncEnabled,
      timeSignatureBranchingEnabled,
      timeSignatureBranchMode,
      timeSignatureNumerator,
      timeSignatureDenominator,
      timeSignatureTrackOffsets,
      timeSignatureSimilarityRestrictEnabled,
      timeSignatureSimilarityNumerator,
      timeSignatureSimilarityDenominator,
      metronomeEnabled,
      metronomeDetectedBeatsPerBar: detectedBeatsPerBar,
    }),
    [
      bpmBarTimeSignatureMode,
      bpmBarNumerator,
      bpmBarDenominator,
      bpmBarBeatOffset,
      multiTrackEnabled,
      coverSyncEnabled,
      timeSignatureBranchingEnabled,
      timeSignatureBranchMode,
      timeSignatureNumerator,
      timeSignatureDenominator,
      timeSignatureTrackOffsets,
      timeSignatureSimilarityRestrictEnabled,
      timeSignatureSimilarityNumerator,
      timeSignatureSimilarityDenominator,
      metronomeEnabled,
      detectedBeatsPerBar,
    ],
  );
  const effectiveMetronomeConfig = React.useMemo(
    () => resolveEffectiveMetronomeConfig(bpmBarConfig),
    [bpmBarConfig],
  );

  const {
    isExportOpen,
    isExporting,
    exportError,
    exportProgress,
    exportForm,
    setExportForm,
    openExport,
    closeExport,
    resetExport,
    handleExportJukeboxAudio,
  } = useAudioExport({
    file,
    analysis,
    activeAnalysis: multiTrackEnabled ? (mergedAnalysis ?? analysis) : analysis,
    analysisRef,
    playerRef,
    engineRef,
    playMode,
    jukeboxAudioMode,
    audioIntensity,
    metronomeEnabled: bpmBarEnabled && metronomeEnabled,
    metronomeVolumePct,
    metronomeBeatsPerBar: effectiveMetronomeConfig.beatsPerBarOverride,
    metronomeBeatOffset: effectiveMetronomeConfig.beatOffset,
    multiTrackEnabled,
    mixTrackGainsPct,
    postMixNormalizeVolumeEnabled,
    exportTitleOverride: mixTitleOverride,
    getSourceIdentity: getCurrentSourceIdentity,
    getRenderedTrackId: () => fingerprintRef.current,
    getCanonizerRenderPlan: () => autocanonizerRef.current?.planRender() ?? null,
    getCanonizerBuffers: () =>
      autocanonizerRef.current?.getAudioBuffers?.() ?? {
        mainBuffer: null,
        otherBuffer: null,
      },
    getWubMachineRender: () => wubMachineRenderRef.current,
    renderWubMachine: renderWubMachineForExport,
    t,
  });

  // The queue owns stacking/dedupe/timers; ShortcutToastStack subscribes to
  // it directly so toast churn does not re-render this route.
  const shortcutToastQueueRef = React.useRef<ShortcutToastQueue | null>(null);
  if (shortcutToastQueueRef.current === null) {
    shortcutToastQueueRef.current = createToastQueue<{ message: string }>();
  }
  const shortcutToastQueue = shortcutToastQueueRef.current;

  const showShortcutToast = React.useCallback(
    (message: string, key?: string) => {
      shortcutToastQueue.show({ message }, key);
    },
    [shortcutToastQueue],
  );

  function setPreparingState(mode: PreparingAudioMode, completed = false) {
    setPrepAborted(mode === null && !completed && preparingModeRef.current !== null);
    preparingModeRef.current = mode;
    setPreparingMode(mode);
    setPreparingPhase(null);
    setPreparingProgress(0);
    setModelDownloaded(false);
  }

  // Invalidates any render in flight; its completion is then ignored.
  function stopPreparing() {
    renderTokenRef.current += 1;
    cancelInstrumentalRender();
    wubMachineAbortRef.current?.abort();
    wubMachineAbortRef.current = null;
    setPreparingState(null);
  }

  // The audio-mode reset shared by track changes and the extras reset:
  // player, mode/intensity state, extras form, and URL all return to "off"
  // at default intensity.
  function resetAudioModeToOff(player: BufferedAudioPlayer) {
    cowbellOverlayRef.current?.disable();
    stopPreparing();
    jukeboxAudioModeRef.current = "off";
    audioIntensityRef.current = DEFAULT_AUDIO_MODE_INTENSITY;
    setJukeboxAudioMode("off");
    setAudioIntensity(DEFAULT_AUDIO_MODE_INTENSITY);
    setExtrasForm((prev) =>
      prev.audioMode === "off" &&
      prev.audioIntensity === DEFAULT_AUDIO_MODE_INTENSITY
        ? prev
        : {
            ...prev,
            audioMode: "off",
            audioIntensity: DEFAULT_AUDIO_MODE_INTENSITY,
          },
    );
    player.setJukeboxAudioMode("off", DEFAULT_AUDIO_MODE_INTENSITY);
    writeAudioModeToUrl("off", DEFAULT_AUDIO_MODE_INTENSITY, true);
    syncLiveBpmForPlaybackRate(player.getPlaybackRate?.());
  }

  function resetPlaybackSessionMetrics() {
    playTimerMsRef.current = 0;
    lastPlayStampRef.current = null;
    lastBeatRef.current = null;
    lastCowbellBeatsPlayedRef.current = null;
    const minProbPct = Math.round(
      (engineRef.current?.getConfig().minRandomBranchChance ??
        DEFAULT_JUKEBOX_CONFIG.minRandomBranchChance) * 100,
    );
    counters.set({
      listenSeconds: 0,
      beatsPlayed: 0,
      jukeboxCurrentSeconds: 0,
      branchChanceText: `${minProbPct}%`,
      autocanonizerMainSeconds: 0,
      autocanonizerOtherSeconds: 0,
      autocanonizerPinkSeconds: 0,
      autocanonizerGoldSeconds: 0,
      songSyncTrackSeconds: [],
      wubMachineSeconds: 0,
    });
  }

  function clearSelectedBranch() {
    setSelectedEdge(null);
    vizControllerRef.current?.setSelectedEdge(null);
  }

  function syncVizDataFromEngine() {
    const data = engineRef.current?.getVisualizationData();
    if (data) {
      vizControllerRef.current?.setData(data);
    }
    vizDataRef.current = data ?? null;
    return data ?? null;
  }

  function rebuildGraphAndSyncViz() {
    const engine = engineRef.current;
    if (!engine) {
      return null;
    }
    engine.rebuildGraph();
    const data = syncVizDataFromEngine();
    syncPredictedJumps();
    return data;
  }

  React.useEffect(() => {
    const player = new BufferedAudioPlayer();
    player.setVolume(initialVolume / 100);
    const cowbellOverlay = new CowbellOverlayService(player.getContext(), {
      getPlaybackRate: () => player.getPlaybackRate(),
    });
    cowbellOverlay.setVolume(player.getVolume());
    const metronomeOverlay = new MetronomeOverlayService(player.getContext());
    metronomeOverlay.setVolume(player.getVolume());
    playerRef.current = player;
    cowbellOverlayRef.current = cowbellOverlay;
    metronomeOverlayRef.current = metronomeOverlay;
    if (jukeboxAudioMode === "cowbell") {
      cowbellOverlay.enable();
      player.setJukeboxAudioMode("cowbell", audioIntensity);
    } else if (
      jukeboxAudioMode !== "swing" &&
      jukeboxAudioMode !== "instrumental"
    ) {
      player.setJukeboxAudioMode(jukeboxAudioMode, audioIntensity);
    }
    return () => {
      cowbellOverlayRef.current?.dispose();
      cowbellOverlayRef.current = null;
      metronomeOverlayRef.current?.dispose();
      metronomeOverlayRef.current = null;
      const activePlayer = playerRef.current;
      if (activePlayer) {
        activePlayer.dispose().catch((err) => {
          console.warn(`Audio player dispose failed: ${String(err)}`);
        });
      }
      playerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const overlay = metronomeOverlayRef.current;
    if (!overlay) {
      return;
    }
    overlay.setMetronomeVolumePct(metronomeVolumePct);
    overlay.setBeatsPerBarOverride(effectiveMetronomeConfig.beatsPerBarOverride);
    overlay.setBeatOffset(effectiveMetronomeConfig.beatOffset);
    if (bpmBarEnabled && metronomeEnabled) {
      overlay.enable();
    } else {
      overlay.disable();
    }
  }, [
    bpmBarEnabled,
    metronomeEnabled,
    metronomeVolumePct,
    effectiveMetronomeConfig,
  ]);

  React.useEffect(() => {
    vizControllerRef.current?.setActiveIndex(activeVizIndex);
  }, [activeVizIndex]);

  React.useEffect(() => {
    storeVisualizationIndex(activeVizIndex);
  }, [activeVizIndex]);

  React.useEffect(() => {
    bpmBarEnabledRef.current = bpmBarEnabled;
  }, [bpmBarEnabled]);

  React.useEffect(() => {
    branchLookaheadEnabledRef.current = branchLookaheadEnabled;
    branchLookaheadCountRef.current = branchLookaheadCount;
    syncPredictedJumps();
  }, [branchLookaheadEnabled, branchLookaheadCount, syncPredictedJumps]);

  React.useEffect(() => {
    multiTrackEnabledRef.current = multiTrackEnabled;
  }, [multiTrackEnabled]);

  React.useEffect(() => {
    autocanonizerMixEnabledRef.current = autocanonizerMixEnabled;
  }, [autocanonizerMixEnabled]);

  React.useEffect(() => {
    if (
      !vizLayerRef.current ||
      !canonizerLayerRef.current ||
      !songSyncLayerRef.current ||
      !wubMachineLayerRef.current
    ) {
      return;
    }
    const controller = new JukeboxController(vizLayerRef.current);
    const autocanonizer = new AutocanonizerController(canonizerLayerRef.current);
    const songsync = new SongSyncController(songSyncLayerRef.current);
    const wubmachine = new WubMachineController(wubMachineLayerRef.current);
    vizControllerRef.current = controller;
    autocanonizerRef.current = autocanonizer;
    songsyncRef.current = songsync;
    wubmachineRef.current = wubmachine;

    controller.setActiveIndex(activeVizIndex);
    controller.setVisible(playModeRef.current === "jukebox");
    controller.setAnchorHighlightEnabled(highlightAnchorBranch);
    controller.setVisualPreferences?.(visualPreferences);
    autocanonizer.setVisible(playModeRef.current === "autocanonizer");
    autocanonizer.setFinishOutSong(finishOutSong);
    autocanonizer.setStreamPans(
      autocanonizerMainPanRef.current / 100,
      autocanonizerOtherPanRef.current / 100,
    );
    autocanonizer.setQuadStreamPans?.(
      autocanonizerPinkPanRef.current / 100,
      autocanonizerGoldPanRef.current / 100,
    );
    autocanonizer.setVolume(playerRef.current?.getVolume() ?? 1);
    autocanonizer.setOnBeat((index, beat, cursorTimes) => {
      lastBeatRef.current = index;
      counters.set({
        beatsPlayed: index + 1,
        autocanonizerMainSeconds: cursorTimes.mainSeconds,
        autocanonizerOtherSeconds: cursorTimes.otherSeconds,
        autocanonizerPinkSeconds:
          cursorTimes.pinkSeconds === undefined ? 0 : cursorTimes.pinkSeconds,
        autocanonizerGoldSeconds:
          cursorTimes.goldSeconds === undefined ? 0 : cursorTimes.goldSeconds,
      });
      updateLiveBpmForBeat(beat);
      const runtimeConfig = bpmBarRuntimeRef.current.bpmBarConfig;
      metronomeOverlayRef.current?.handleBeatEnter(
        index,
        beat ?? undefined,
        runtimeConfig
          ? isBpmBarDownbeat(runtimeConfig, index, beat ?? null, null)
          : undefined,
      );
      triggerBpmBarPulse(index, beat);
    });
    autocanonizer.setOnEnded(() => {
      if (!isRunningRef.current) {
        return;
      }
      stopPlayback();
    });
    autocanonizer.setOnSelect((index) => {
      if (playModeRef.current !== "autocanonizer") {
        return;
      }
      startAutocanonizerPlayback(index, { resetSession: false });
    });

    wubmachine.setVisible(playModeRef.current === "wubmachine");
    wubmachine.setLoop(loopTrack);
    wubmachine.setVolume(playerRef.current?.getVolume() ?? 1);
    wubmachine.setOnTick((seconds) => {
      // Fires every frame; floored so subscribers run once a second.
      counters.set({ wubMachineSeconds: Math.floor(seconds) });
    });
    wubmachine.setOnEnded(() => {
      if (!isRunningRef.current) {
        return;
      }
      stopPlayback();
    });
    wubmachine.setOnSelect((seconds) => {
      if (playModeRef.current !== "wubmachine") {
        return;
      }
      startWubMachinePlayback(seconds, { resetSession: false });
    });

    songsync.setVisible(playModeRef.current === "songsync");
    songsync.setLoop(loopTrack);
    songsync.setVolume(playerRef.current?.getVolume() ?? 1);
    songsync.setOnBeat((snapshot) => {
      lastBeatRef.current = snapshot.masterBeatIndex;
      counters.set({
        beatsPlayed: snapshot.masterBeatIndex + 1,
        songSyncTrackSeconds: snapshot.trackSeconds.map((sec) => sec ?? 0),
      });
      const beat = snapshot.masterBeat as QuantumBase | null;
      updateLiveBpmForBeat(beat);
      const runtimeConfig = bpmBarRuntimeRef.current.bpmBarConfig;
      metronomeOverlayRef.current?.handleBeatEnter(
        snapshot.masterBeatIndex,
        beat ?? undefined,
        runtimeConfig
          ? isBpmBarDownbeat(
              runtimeConfig,
              snapshot.masterBeatIndex,
              beat ?? null,
              null,
            )
          : undefined,
      );
      triggerBpmBarPulse(snapshot.masterBeatIndex, beat);
    });
    songsync.setOnEnded(() => {
      if (!isRunningRef.current) {
        return;
      }
      stopPlayback();
    });
    songsync.setOnSelect((masterBeatIndex) => {
      if (playModeRef.current !== "songsync") {
        return;
      }
      startSongSyncPlayback(masterBeatIndex, { resetSession: false });
    });
    const render = wubMachineRenderRef.current;
    if (render) {
      wubmachine.setRemix(
        render.buffer,
        playerRef.current?.getContext() ?? null,
        render.parts,
      );
    }

    const resizeObserver = new ResizeObserver(() => {
      controller.resizeActive();
      autocanonizer.resizeNow();
      songsync.resizeNow();
      wubmachine.resizeNow();
    });
    resizeObserver.observe(vizPanelRef.current ?? vizLayerRef.current);
    // The viz-top row changes height when the anchor toolbar replaces it.
    resizeObserver.observe(vizLayerRef.current);

    return () => {
      resizeObserver.disconnect();
      controller.destroy();
      autocanonizer.destroy();
      songsync.destroy();
      wubmachine.destroy();
      vizControllerRef.current = null;
      autocanonizerRef.current = null;
      songsyncRef.current = null;
      wubmachineRef.current = null;
    };
  }, [file]);

  React.useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  React.useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  React.useEffect(() => {
    return () => {
      shortcutToastQueue.clear();
    };
  }, [shortcutToastQueue]);

  React.useEffect(() => {
    bringItHomeModeRef.current = bringItHomeMode;
  }, [bringItHomeMode]);

  React.useEffect(() => {
    activeVizIndexRef.current = activeVizIndex;
  }, [activeVizIndex]);

  React.useEffect(() => {
    playModeRef.current = playMode;
    vizControllerRef.current?.setVisible(playMode === "jukebox");
    autocanonizerRef.current?.setVisible(playMode === "autocanonizer");
    songsyncRef.current?.setVisible(playMode === "songsync");
    wubmachineRef.current?.setVisible(playMode === "wubmachine");
    if (playMode === "autocanonizer") {
      autocanonizerRef.current?.resizeNow();
    } else if (playMode === "songsync") {
      songsyncRef.current?.resizeNow();
    } else if (playMode === "wubmachine") {
      wubmachineRef.current?.resizeNow();
    } else {
      vizControllerRef.current?.resizeActive();
    }
    syncPredictedJumps();
    syncLiveBpmForPlaybackRate(playerRef.current?.getPlaybackRate?.());
  }, [playMode, syncLiveBpmForPlaybackRate, syncPredictedJumps]);

  React.useEffect(() => {
    storeWubMachineLoop(loopTrack);
    wubmachineRef.current?.setLoop(loopTrack);
    songsyncRef.current?.setLoop(loopTrack);
  }, [loopTrack]);

  React.useEffect(() => {
    storeFinishOutSong(finishOutSong);
    autocanonizerRef.current?.setFinishOutSong(finishOutSong);
  }, [finishOutSong]);

  React.useEffect(() => {
    if (!file || !playerRef.current) {
      return;
    }
    const currentFileKey = `${file.name}:${file.size}:${file.lastModified}`;
    const previousFileKey = previousFileKeyRef.current;
    const isTrackChange = previousFileKey !== null && previousFileKey !== currentFileKey;
    previousFileKeyRef.current = currentFileKey;
    if (isTrackChange) {
      cowbellOverlayRef.current?.setSectionStartBeatIndices([]);
      metronomeOverlayRef.current?.disable();
      metronomeOverlayRef.current?.setBeatsPerBar(undefined);
      setMetronomeEnabled(false);
      setDetectedBeatsPerBar(DEFAULT_BEATS_PER_BAR);
      resetAudioModeToOff(playerRef.current);
    }

    // Reset any active multi-track, dual-canonizer, or Song Sync state on single-file load.
    mixLoadGenerationRef.current += 1;
    cachedMixSourcesRef.current = null;
    cachedAutocanonizerMixSourcesRef.current = null;
    cachedSongSyncSourcesRef.current = null;
    loadedSongSyncSignatureRef.current = "";
    multiTrackEnabledRef.current = false;
    autocanonizerMixEnabledRef.current = false;
    setMultiTrackEnabled(false);
    setMergedAnalysis(null);
    setMixTracksMeta([]);
    setMixTrackGainsPct([]);
    setAutocanonizerMixEnabled(false);
    setAutocanonizerQuadMode(false);
    setAutocanonizerMixTrackTitles(null);
    setAutocanonizerOtherDurationSec(null);
    setSongSyncTracks([]);
    setSongSyncTrackTimes([]);
    setSongSyncMasterTrackIndex(0);
    setMixTitleOverride(null);
    setMixDurationOverrideSec(null);
    setIsMixing(false);
    autocanonizerRef.current?.setQuadMode?.(false);
    songsyncRef.current?.reset();
    playerRef.current.clearPostMixTrackGains?.();
    playerRef.current.setPostMixNormalization?.(false);

    const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
    let cancelled = false;

    const analysisPort = new AnalysisWorkerClient();
    const cache = createAnalysisCache();
    const decoder = new AudioDecoder(playerRef.current.getContext());
    const usecase = new AnalyzeAudioUseCase(analysisPort, cache, decoder);

    engineRef.current?.stopJukebox();
    engineRef.current?.setFreezeCurrentBeat(false);
    engineRef.current?.setPlayVelocity(1);
    engineRef.current?.setBringItHomeMode(false);
    autocanonizerRef.current?.stop();
    stopPreparing();
    wubMachineRenderRef.current = null;
    wubmachineRef.current?.setRemix(null, null);
    setWubMachineDurationSeconds(0);
    resetPlaybackSessionMetrics();
    setIsRunning(false);
    setIsPaused(false);
    setBringItHomeMode(false);

    setIsAnalyzing(true);
    setPrepAborted(false);
    setError(null);
    setStageProgress(null);
    setAnalysis(null);
    setReadyFileKey(null);
    analysisRef.current = null;
    fingerprintRef.current = null;
    customAnchor.discard();
    clearSelectedBranch();
    resetExport();

    usecase
      .execute({
        file,
        onProgress: (progress) => {
          if (cancelled) {
            return;
          }
          setProgressStage(progress.stage);
          setStageProgress(progress.progress);
        },
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        analysisRef.current = result.analysis;
        fingerprintRef.current = result.fingerprint;
        updateMixQueueTrackMeta?.(file, {
          fingerprint: result.fingerprint,
          title: result.analysis.track?.title,
          artist: result.analysis.track?.artist,
          durationSeconds: result.analysis.track?.duration,
        });
        const storedOffset = resolveStoredBpmBarBeatOffsetForTrack(
          result.fingerprint,
        );
        setBpmBarBeatOffset(storedOffset);
        setTimeSignatureTrackOffsets([storedOffset]);
        trimRenderedTracks(result.fingerprint).catch((err: unknown) => {
          console.warn(`Rendered track trim failed: ${String(err)}`);
        });
        if (fileHandle) {
          setFileHandle(result.fingerprint, fileHandle).catch((err: unknown) => {
            console.warn(`File handle save failed: ${String(err)}`);
          });
        }
        setAnalysis(result.analysis);
        setReadyFileKey(fileKey);
        playerRef.current?.loadBuffer(result.audioBuffer);
        autocanonizerRef.current?.setAudio(
          playerRef.current?.getSourceBuffer() ?? null,
          playerRef.current?.getContext() ?? null,
        );
        initializeEngine(result.analysis);
        restoreSavedTuning(result.fingerprint, storedOffset);
        const audioMode = jukeboxAudioModeRef.current;
        if (audioMode === "cowbell") {
          cowbellOverlayRef.current?.enable();
        }
        if (audioMode === "swing") {
          playerRef.current?.setJukeboxAudioMode("swing");
          maybePrepareSwingMode();
        }
        if (audioMode === "instrumental") {
          playerRef.current?.setJukeboxAudioMode("instrumental");
          maybePrepareInstrumentalMode();
        }
        maybePrepareWubMachine();
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        console.warn(`Audio analysis failed: ${String(err)}`);
        setError(t("analysis.failed"));
      })
      .finally(() => {
        if (!cancelled) {
          setIsAnalyzing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file, fileHandle, t]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      const now = performance.now();
      const totalMs =
        playTimerMsRef.current +
        (lastPlayStampRef.current !== null ? now - lastPlayStampRef.current : 0);
      counters.set({ listenSeconds: totalMs / 1000 });
    }, 200);

    return () => {
      window.clearInterval(id);
    };
  }, []);

  function stopPlayback() {
    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    if (playModeRef.current === "autocanonizer") {
      autocanonizerRef.current?.stop();
      playerRef.current?.stop();
      autocanonizerRef.current?.resetVisualization();
    } else if (playModeRef.current === "songsync") {
      songsyncRef.current?.stop();
      playerRef.current?.stop();
      songsyncRef.current?.resetVisualization();
    }
    wubmachineRef.current?.stop();
    engineRef.current?.stopJukebox();
    engineRef.current?.resetStats();
    resetPlaybackSessionMetrics();
    resetLiveBpm();
    clearBpmBarPulse();
    vizControllerRef.current?.reset();
    if (bringItHomeModeRef.current) {
      bringItHomeModeRef.current = false;
      setBringItHomeMode(false);
      engineRef.current?.setBringItHomeMode(false);
    }
    setIsRunning(false);
    setIsPaused(false);
    isRunningRef.current = false;
    isPausedRef.current = false;
  }

  React.useEffect(() => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    player.setOnEnded(() => {
      if (!isRunningRef.current) {
        return;
      }
      if (playModeRef.current === "jukebox" && !bringItHomeModeRef.current) {
        // Recover if audio reaches buffer end before the scheduled wrap jump.
        startFromBeat(0);
        if (!player.isPlaying()) {
          engineRef.current?.play();
        }
        return;
      }
      stopPlayback();
    });
    return () => {
      player.setOnEnded(null);
    };
  }, []);

  const onSetPlayMode = (mode: PlayMode) => {
    if (playMode === mode) {
      return;
    }
    if (mode === "songsync" && mixQueue.length < 2) {
      setMixAddSticky?.(true);
      showShortcutToast(t("listen.songSyncNeedQueue"));
      return;
    }
    if (isRunningRef.current || isPausedRef.current) {
      stopPlayback();
    }
    if (playModeRef.current === "wubmachine") {
      cancelWubMachineRender();
    }
    if (mode !== "jukebox" && multiTrackEnabledRef.current) {
      void disableMultiTrackMix();
    }
    if (mode !== "autocanonizer" && autocanonizerMixEnabledRef.current) {
      void disableAutocanonizerMix();
    }
    if (playModeRef.current === "songsync" && mode !== "songsync") {
      disableSongSyncMix();
    }
    playModeRef.current = mode;
    setPlayMode(mode);
    counters.set({
      autocanonizerMainSeconds: 0,
      autocanonizerOtherSeconds: 0,
      autocanonizerPinkSeconds: 0,
      autocanonizerGoldSeconds: 0,
      songSyncTrackSeconds: [],
      wubMachineSeconds: 0,
    });
    if (mode !== "jukebox") {
      setIsInfoOpen(false);
      customAnchor.exit();
      clearSelectedBranch();
    }
    if (mode === "wubmachine") {
      setIsTuningOpen(false);
      maybePrepareWubMachine();
    }
    if (mode === "songsync") {
      setMixAddSticky?.(false);
    }
  };

  function wireEngineUpdateListener(
    engine: JukeboxEngine,
    beatsSource: readonly QuantumBase[],
  ) {
    engine.onUpdate((state) => {
      const chancePct = Math.round((state.curRandomBranchChance ?? 0) * 100);
      counters.set({
        beatsPlayed: state.beatsPlayed,
        jukeboxCurrentSeconds: state.currentTime ?? 0,
        branchChanceText: `${chancePct}%`,
      });
      if (state.currentBeatIndex >= 0) {
        const beat = beatsSource[state.currentBeatIndex];
        if (state.beatsPlayed !== lastCowbellBeatsPlayedRef.current) {
          lastCowbellBeatsPlayedRef.current = state.beatsPlayed;
          if (beat) {
            cowbellOverlayRef.current?.handleBeatEnter(
              state.currentBeatIndex,
              beat,
              beatsSource[state.currentBeatIndex + 1],
            );
          }
          const runtimeConfig = bpmBarRuntimeRef.current.bpmBarConfig;
          metronomeOverlayRef.current?.handleBeatEnter(
            state.currentBeatIndex,
            beat,
            runtimeConfig
              ? isBpmBarDownbeat(
                  runtimeConfig,
                  state.currentBeatIndex,
                  beat ?? null,
                  beatsSource,
                )
              : undefined,
          );
          updateLiveBpmForBeat(beat, {
            beats: beatsSource,
            beatIndex: state.currentBeatIndex,
            playbackRate: playerRef.current?.getPlaybackRate?.(),
          });
          triggerBpmBarPulse(state.currentBeatIndex, beat ?? null);
        }
        const highlightJump =
          state.lastJumped && engine.getLastJumpWasBranch();
        const jumpFrom =
          highlightJump && state.lastJumpFromIndex !== null
            ? state.lastJumpFromIndex
            : lastBeatRef.current;
        const jumpTo =
          highlightJump && typeof state.lastJumpToIndex === "number"
            ? state.lastJumpToIndex
            : state.currentBeatIndex;
        vizControllerRef.current?.update(jumpTo, highlightJump, jumpFrom);
        if (jumpTo !== state.currentBeatIndex) {
          vizControllerRef.current?.update(state.currentBeatIndex, false, jumpTo);
        }
        lastBeatRef.current = state.currentBeatIndex;
        syncPredictedJumps();
      }
    });
  }

  const initializeEngine = (
    analysisData: AnalysisOutput | TrackAnalysis,
    options?: { skipAutocanonizer?: boolean },
  ) => {
    if (!playerRef.current) {
      return;
    }
    const engine = new JukeboxEngine(playerRef.current, {
      randomMode: "seeded",
      seed: createSessionSeed(),
    });
    engine.loadAnalysis(analysisData);
    const normalizedBeats = (engine.getVisualizationData()?.beats ??
      analysisData.beats) as unknown as readonly QuantumBase[];
    engine.setBringItHomeMode(bringItHomeModeRef.current);
    cowbellOverlayRef.current?.setSectionStartBeatIndices(
      engine.getSectionStartBeatIndices(),
    );
    const detected = detectTrackBeatsPerBar(
      normalizedBeats,
      analysisData.track?.time_signature,
    );
    setDetectedBeatsPerBar(detected);
    metronomeOverlayRef.current?.setBeatsPerBar(detected);
    wireEngineUpdateListener(engine, normalizedBeats);
    engineRef.current = engine;
    if (!options?.skipAutocanonizer) {
      autocanonizerRef.current?.setAnalysis(
        analysisData,
        analysisData.track?.duration,
      );
    }

    syncVizDataFromEngine();
    syncPredictedJumps();
    const baseTempo = resolveTrackBaseTempoBpm(
      analysisData.track?.tempo,
      normalizedBeats,
    );
    resetLiveBpm(baseTempo);
    const minProbPct = Math.round(engine.getConfig().minRandomBranchChance * 100);
    counters.set({
      jukeboxCurrentSeconds: 0,
      branchChanceText: `${minProbPct}%`,
    });

    vizControllerRef.current?.setOnSelect((index) => {
      if (playModeRef.current !== "jukebox") {
        return;
      }
      startFromBeat(index);
    });
    vizControllerRef.current?.setOnEdgeSelect((edge) => {
      if (playModeRef.current !== "jukebox") {
        return;
      }
      setSelectedEdge(edge);
      vizControllerRef.current?.setSelectedEdgeActive(edge);
    });
    vizControllerRef.current?.setOnAnchorEditChange(customAnchor.dragChanged);
    vizControllerRef.current?.setOnAnchorEditCommit(customAnchor.dragCommitted);
    const count = vizControllerRef.current?.getCount() ?? 1;
    setActiveVizIndex((prev) => Math.max(0, Math.min(prev, count - 1)));

    syncTuneFormFromEngine();
    setTuningNonDefault(hasNonDefaultTuning(engine));
  };

  const syncTuneFormFromEngine = (
    nextHighlightAnchorBranch = highlightAnchorBranch,
  ): TuneFormState | null => {
    const engine = engineRef.current;
    const player = playerRef.current;
    if (!engine || !player) {
      return null;
    }
    const config = engine.getConfig();
    const graph = engine.getGraphState();
    const computedThreshold = Math.round(graph?.computedThreshold ?? 0);
    const currentThreshold =
      config.currentThreshold === 0
        ? Math.round(graph?.currentThreshold ?? computedThreshold)
        : config.currentThreshold;
    const rawCross = config.crossTrackThreshold ?? 0;
    const computedCrossThreshold =
      graph?.computedCrossThreshold !== undefined
        ? Math.round(graph.computedCrossThreshold)
        : null;
    const crossThreshold =
      rawCross === 0 && graph?.currentCrossThreshold !== undefined
        ? Math.round(graph.currentCrossThreshold)
        : rawCross;
    const nextForm: TuneFormState = {
      threshold: currentThreshold,
      computedThreshold,
      crossThreshold,
      computedCrossThreshold,
      maxBranches: config.maxBranches,
      minProb: Math.round(config.minRandomBranchChance * 100),
      maxProb: Math.round(config.maxRandomBranchChance * 100),
      ramp:
        Math.round(
          config.randomBranchChanceDelta *
            RANDOM_BRANCH_DELTA_PERCENT_SCALE *
            10,
        ) / 10,
      volume: Math.round(player.getVolume() * 100),
      highlightAnchorBranch: nextHighlightAnchorBranch,
      justBackwards: config.justBackwards,
      minLongBranchPercent: config.justLongBranches
        ? (config.minLongBranchPercent ?? DEFAULT_MIN_LONG_BRANCH_PERCENT)
        : 0,
      maxLongBranchPercent:
        config.maxLongBranchPercent && config.maxLongBranchPercent > 0
          ? config.maxLongBranchPercent
          : 100,
      removeSequentialBranches: config.removeSequentialBranches,
    };
    setTuneForm(nextForm);
    return nextForm;
  };

  const persistCurrentTuning = () => {
    if (multiTrackEnabledRef.current) {
      return;
    }
    const engine = engineRef.current;
    const fingerprint = fingerprintRef.current;
    if (!engine || !fingerprint) {
      return;
    }
    const config = engine.getConfig();
    const deletedEdgeIds =
      engine
        .getGraphState()
        ?.allEdges.filter((edge) => edge.deleted)
        .map((edge) => edge.id) ?? [];
    saveTuning(fingerprint, {
      v: 1,
      config: {
        currentThreshold: config.currentThreshold,
        justBackwards: config.justBackwards,
        justLongBranches: config.justLongBranches,
        removeSequentialBranches: config.removeSequentialBranches,
        minRandomBranchChance: config.minRandomBranchChance,
        maxRandomBranchChance: config.maxRandomBranchChance,
        randomBranchChanceDelta: config.randomBranchChanceDelta,
        minLongBranchPercent: config.minLongBranchPercent,
        maxBranches: config.maxBranches,
        maxLongBranchPercent: config.maxLongBranchPercent ?? 0,
        timeSignatureSimilarityRestrict:
          Boolean(config.timeSignatureSimilarityRestrict),
        timeSignatureSimilarityNumerator:
          config.timeSignatureSimilarityNumerator ??
          DEFAULT_TIME_SIGNATURE_NUMERATOR,
        timeSignatureSimilarityDenominator:
          config.timeSignatureSimilarityDenominator ??
          DEFAULT_TIME_SIGNATURE_DENOMINATOR,
        timeSignatureTrackOffsets: config.timeSignatureTrackOffsets ?? [],
      },
      deletedEdgeIds,
      anchor: engine.getAnchorParam(),
    });
  };

  const restoreSavedTuning = (fingerprint: string, fallbackOffset = 0) => {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    const fallbackOffsets = fallbackOffset !== 0 ? [fallbackOffset] : [];
    const saved = loadTuning(fingerprint);
    if (!saved) {
      setTimeSignatureSimilarityRestrictEnabled(false);
      setTimeSignatureSimilarityNumerator(DEFAULT_TIME_SIGNATURE_NUMERATOR);
      setTimeSignatureSimilarityDenominator(
        DEFAULT_TIME_SIGNATURE_DENOMINATOR,
      );
      setTimeSignatureTrackOffsets(fallbackOffsets);
      if (fallbackOffsets.length > 0) {
        engine.updateConfig({ timeSignatureTrackOffsets: fallbackOffsets });
      }
      return;
    }
    engine.updateConfig(saved.config);
    const restrictEnabled = Boolean(saved.config.timeSignatureSimilarityRestrict);
    const savedNum =
      saved.config.timeSignatureSimilarityNumerator ??
      DEFAULT_TIME_SIGNATURE_NUMERATOR;
    const savedDen =
      saved.config.timeSignatureSimilarityDenominator ??
      DEFAULT_TIME_SIGNATURE_DENOMINATOR;
    setTimeSignatureSimilarityRestrictEnabled(restrictEnabled);
    setTimeSignatureSimilarityNumerator(savedNum);
    setTimeSignatureSimilarityDenominator(savedDen);
    if (restrictEnabled) {
      storeBpmBarNumerator(savedNum);
      storeBpmBarDenominator(savedDen);
      setBpmBarNumerator(savedNum);
      setBpmBarDenominator(savedDen);
    }
    if (saved.config.timeSignatureTrackOffsets?.length) {
      setTimeSignatureTrackOffsets(saved.config.timeSignatureTrackOffsets);
      setBpmBarBeatOffset(saved.config.timeSignatureTrackOffsets[0] ?? 0);
    } else if (fallbackOffsets.length > 0) {
      setTimeSignatureTrackOffsets(fallbackOffsets);
      engine.updateConfig({ timeSignatureTrackOffsets: fallbackOffsets });
    }
    engine.clearDeletedEdges();
    engine.rebuildGraph();
    const allEdges = engine.getGraphState()?.allEdges ?? [];
    for (const id of saved.deletedEdgeIds) {
      const edge = allEdges.find((candidate) => candidate.id === id);
      if (edge) {
        engine.deleteEdge(edge);
      }
    }
    engine.applyAnchorParam(saved.anchor);
    syncVizDataFromEngine();
    syncPredictedJumps();
    syncTuneFormFromEngine();
    setTuningNonDefault(hasNonDefaultTuning(engine));
  };

  function getCurrentSourceIdentity() {
    return file ? `${file.name}:${file.size}:${file.lastModified}` : null;
  }

  function canPrepareSwingMode() {
    const player = playerRef.current;
    const activeAnalysis = analysisRef.current;
    return (
      playModeRef.current === "jukebox" &&
      player !== null &&
      player.getSourceBuffer() !== null &&
      Boolean(activeAnalysis?.beats.length)
    );
  }

  function isPlaybackBlockedForAudioMode() {
    if (playModeRef.current === "wubmachine") {
      return preparingModeRef.current === "wubmachine";
    }
    return (
      playModeRef.current === "jukebox" &&
      preparingModeRef.current !== null &&
      preparingModeRef.current === jukeboxAudioModeRef.current
    );
  }

  function preparingToastKey() {
    if (playModeRef.current === "wubmachine") {
      return "listen.preparingWubMachineEllipsis" as const;
    }
    return jukeboxAudioModeRef.current === "instrumental"
      ? ("listen.preparingInstrumentalEllipsis" as const)
      : ("listen.preparingSwingEllipsis" as const);
  }

  function showPreparingToast() {
    showShortcutToast(t(preparingToastKey()));
  }

  // Stops a Wub Machine render in flight; a finished remix is kept.
  function cancelWubMachineRender() {
    if (!wubMachineAbortRef.current) {
      return;
    }
    wubMachineAbortRef.current.abort();
    wubMachineAbortRef.current = null;
    if (preparingModeRef.current === "wubmachine") {
      setPreparingState(null);
    }
  }

  // Renders the loaded track's remix once, while Wub Machine mode is selected.
  function maybePrepareWubMachine() {
    const player = playerRef.current;
    const sourceBuffer = player?.getSourceBuffer();
    if (
      playModeRef.current !== "wubmachine" ||
      !player ||
      !sourceBuffer ||
      !analysisRef.current ||
      wubMachineRenderRef.current ||
      wubMachineAbortRef.current
    ) {
      return;
    }
    const abort = new AbortController();
    wubMachineAbortRef.current = abort;
    const renderToken = renderTokenRef.current + 1;
    renderTokenRef.current = renderToken;
    setPreparingState("wubmachine");
    const isStale = () =>
      wubMachineAbortRef.current !== abort ||
      renderTokenRef.current !== renderToken;

    renderWubMachineBuffer(sourceBuffer, player.getContext(), analysisRef.current, {
      trackId: fingerprintRef.current,
      signal: abort.signal,
      onProgress: (progress) => {
        if (!isStale()) {
          setPreparingProgress(
            Math.max(0, Math.min(100, Math.round(progress * 100))),
          );
        }
      },
    })
      .then((render) => {
        if (isStale()) {
          return;
        }
        wubMachineAbortRef.current = null;
        wubMachineRenderRef.current = render;
        wubmachineRef.current?.setRemix(
          render.buffer,
          player.getContext(),
          render.parts,
        );
        counters.set({ wubMachineSeconds: 0 });
        setWubMachineDurationSeconds(render.buffer.duration);
        setPreparingState(null, true);
      })
      .catch((err: unknown) => {
        if (isStale()) {
          return;
        }
        wubMachineAbortRef.current = null;
        console.warn(`Wub Machine render failed: ${String(err)}`);
        setPreparingState(null);
        showShortcutToast(t("listen.wubMachineFailed"));
      });
  }

  // Export renders a fresh copy when it must not reuse the stored one.
  async function renderWubMachineForExport(
    storeCopy: boolean,
    onProgress: (progress: number) => void,
  ) {
    const player = playerRef.current;
    const sourceBuffer = player?.getSourceBuffer();
    if (!player || !sourceBuffer || !analysisRef.current) {
      throw new Error("Wub Machine export needs a loaded track.");
    }
    const render = await renderWubMachineBuffer(
      sourceBuffer,
      player.getContext(),
      analysisRef.current,
      { trackId: storeCopy ? fingerprintRef.current : null, onProgress },
    );
    if (!wubMachineRenderRef.current) {
      wubMachineRenderRef.current = render;
      wubmachineRef.current?.setRemix(
        render.buffer,
        player.getContext(),
        render.parts,
      );
      setWubMachineDurationSeconds(render.buffer.duration);
    }
    return render;
  }

  function maybePrepareSwingMode() {
    if (jukeboxAudioModeRef.current !== "swing" || !canPrepareSwingMode()) {
      return;
    }
    prepareSwingMode();
  }

  function prepareSwingMode() {
    const player = playerRef.current;
    const sourceBuffer = player?.getSourceBuffer();
    const beats = vizDataRef.current?.beats ?? analysisRef.current?.beats;
    if (
      player?.getJukeboxAudioMode() !== "swing" ||
      !sourceBuffer ||
      !beats?.length
    ) {
      return;
    }
    const resumeAfterPrepare = isRunningRef.current;
    if (isRunningRef.current) {
      pausePlayback();
    }
    const renderToken = renderTokenRef.current + 1;
    renderTokenRef.current = renderToken;
    setPreparingState("swing");

    getOrCreateSwingBuffer(
      sourceBuffer,
      multiTrackEnabledRef.current ? null : getCurrentSourceIdentity(),
      () =>
        renderSwingBuffer(sourceBuffer, beats, {
          trackId: multiTrackEnabledRef.current ? null : fingerprintRef.current,
          onProgress: (progress) => {
            if (
              renderTokenRef.current !== renderToken ||
              playerRef.current?.getJukeboxAudioMode() !== "swing"
            ) {
              return;
            }
            setPreparingProgress(
              Math.max(0, Math.min(100, Math.round(progress * 100))),
            );
          },
        }),
    )
      .then((buffer) => {
        if (
          renderTokenRef.current !== renderToken ||
          playerRef.current?.getJukeboxAudioMode() !== "swing"
        ) {
          return;
        }
        setPreparingState(null, true);
        player.setRenderedJukeboxAudioBuffer("swing", buffer);
        player.setJukeboxAudioMode("swing");
        if (
          playModeRef.current === "jukebox" &&
          (isRunningRef.current || isPausedRef.current)
        ) {
          engineRef.current?.syncToPlaybackPosition();
        }
        if (
          resumeAfterPrepare &&
          playModeRef.current === "jukebox" &&
          playerRef.current?.getJukeboxAudioMode() === "swing" &&
          !isRunningRef.current
        ) {
          startJukeboxPlayback(false);
        }
      })
      .catch((err: unknown) => {
        if (renderTokenRef.current !== renderToken) {
          return;
        }
        console.warn(`Swing render failed: ${String(err)}`);
        resetAudioModeToOff(player);
        showShortcutToast(t("listen.swingFailed"));
      });
  }

  function canPrepareInstrumentalMode() {
    const player = playerRef.current;
    return (
      playModeRef.current === "jukebox" &&
      player !== null &&
      player.getSourceBuffer() !== null &&
      analysisRef.current !== null
    );
  }

  function maybePrepareInstrumentalMode() {
    if (jukeboxAudioModeRef.current !== "instrumental" || !canPrepareInstrumentalMode()) {
      return;
    }
    prepareInstrumentalMode();
  }

  function prepareInstrumentalMode() {
    const player = playerRef.current;
    const sourceBuffer = player?.getSourceBuffer();
    if (player?.getJukeboxAudioMode() !== "instrumental" || !sourceBuffer) {
      return;
    }
    const resumeAfterPrepare = isRunningRef.current;
    if (isRunningRef.current) {
      pausePlayback();
    }
    const renderToken = renderTokenRef.current + 1;
    renderTokenRef.current = renderToken;
    setPreparingState("instrumental");
    const isStale = () =>
      renderTokenRef.current !== renderToken ||
      playerRef.current?.getJukeboxAudioMode() !== "instrumental";

    renderInstrumentalBuffer(
      sourceBuffer,
      multiTrackEnabledRef.current ? null : fingerprintRef.current,
      ({ phase, progress }) => {
        if (isStale()) {
          return;
        }
        setPreparingPhase(phase);
        if (phase === "download") {
          setModelDownloaded(true);
        }
        setPreparingProgress(Math.max(0, Math.min(100, Math.round(progress * 100))));
      },
    )
      .then((buffer) => {
        if (isStale()) {
          return;
        }
        setPreparingState(null, true);
        player.setRenderedJukeboxAudioBuffer("instrumental", buffer);
        player.setJukeboxAudioMode("instrumental");
        if (
          playModeRef.current === "jukebox" &&
          (isRunningRef.current || isPausedRef.current)
        ) {
          engineRef.current?.syncToPlaybackPosition();
        }
        if (
          resumeAfterPrepare &&
          playModeRef.current === "jukebox" &&
          !isRunningRef.current
        ) {
          startJukeboxPlayback(false);
        }
      })
      .catch((err: unknown) => {
        if (renderTokenRef.current !== renderToken) {
          return;
        }
        console.warn(`Instrumental render failed: ${String(err)}`);
        resetAudioModeToOff(player);
        showShortcutToast(t("listen.instrumentalFailed"));
      });
  }

  const openTuningModalTab = (tab: TuningModalTab) => {
    if (playModeRef.current === "wubmachine") {
      return;
    }
    if (
      playModeRef.current === "jukebox" &&
      !isTuningOpen &&
      engineRef.current
    ) {
      syncTuneFormFromEngine();
      setTuningNonDefault(hasNonDefaultTuning(engineRef.current));
    }
    if (tab === "extras" && playModeRef.current === "jukebox") {
      setIsTuningOpen((prev) => {
        const next = !prev;
        if (next && typeof window !== "undefined") {
          window.requestAnimationFrame(() => {
            document
              .getElementById("tuning-panel-extras")
              ?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
          });
        }
        return next;
      });
      return;
    }
    setIsTuningOpen((prev) => !prev);
  };

  const pausePlayback = () => {
    const player = playerRef.current;
    const engine = engineRef.current;
    if (!player || !engine || !isRunningRef.current) {
      return;
    }
    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    if (playModeRef.current === "autocanonizer") {
      autocanonizerRef.current?.stop();
      player.stop();
    } else if (playModeRef.current === "songsync") {
      songsyncRef.current?.stop();
      player.stop();
    } else if (playModeRef.current === "wubmachine") {
      wubmachineRef.current?.pause();
    } else {
      engine.pauseJukebox();
      engine.syncToPlaybackPosition();
    }
    if (lastPlayStampRef.current !== null) {
      playTimerMsRef.current += performance.now() - lastPlayStampRef.current;
      lastPlayStampRef.current = null;
    }
    isRunningRef.current = false;
    isPausedRef.current = true;
    setIsRunning(false);
    setIsPaused(true);
  };

  const startJukeboxPlayback = (resetSession: boolean) => {
    const player = playerRef.current;
    const engine = engineRef.current;
    if (!player || !engine || !analysisRef.current) {
      return;
    }
    if (isPlaybackBlockedForAudioMode()) {
      showPreparingToast();
      return;
    }
    if (!player.getBuffer()) {
      console.warn("Audio not loaded");
      stopPlayback();
      return;
    }
    if (resetSession) {
      cowbellOverlayRef.current?.cancelScheduledHits();
      metronomeOverlayRef.current?.cancelScheduledHits();
      engine.stopJukebox();
      engine.resetStats();
      resetPlaybackSessionMetrics();
      vizControllerRef.current?.reset();
    } else {
      engine.syncToPlaybackPosition();
    }
    engine.play();
    engine.startJukebox(resetSession);
    lastPlayStampRef.current = performance.now();
    isRunningRef.current = true;
    isPausedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);
    requestWakeLockIfFullscreen();
  };

  const togglePlayback = () => {
    if (isRunning) {
      pausePlayback();
      return;
    }
    if (playMode === "autocanonizer") {
      const startIndex = isPaused ? (lastBeatRef.current ?? 0) : 0;
      startAutocanonizerPlayback(startIndex, { resetSession: !isPaused });
      return;
    }
    if (playMode === "songsync") {
      const startIndex = isPaused ? (lastBeatRef.current ?? 0) : 0;
      startSongSyncPlayback(startIndex, { resetSession: !isPaused });
      return;
    }
    if (playMode === "wubmachine") {
      startWubMachinePlayback(null, { resetSession: !isPaused });
      return;
    }
    if (isPaused) {
      startJukeboxPlayback(false);
      return;
    }
    startJukeboxPlayback(true);
  };

  // Plays the remix from `seconds`, or from the paused position (the start
  // after a stop) when `seconds` is null.
  const startWubMachinePlayback = (
    seconds: number | null,
    options?: { resetSession?: boolean },
  ) => {
    const wubmachine = wubmachineRef.current;
    const player = playerRef.current;
    if (!wubmachine || !player) {
      return false;
    }
    if (isPlaybackBlockedForAudioMode()) {
      showPreparingToast();
      return false;
    }
    if (!wubmachine.isReady()) {
      maybePrepareWubMachine();
      return false;
    }
    const resetSession = options?.resetSession ?? true;
    player.stop();
    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    engineRef.current?.stopJukebox();
    if (resetSession) {
      resetPlaybackSessionMetrics();
    }
    wubmachine.play(seconds ?? undefined);
    if (resetSession || !isRunningRef.current) {
      lastPlayStampRef.current = performance.now();
    }
    isRunningRef.current = true;
    isPausedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);
    requestWakeLockIfFullscreen();
    return true;
  };

  const startFromBeat = (index: number, analysisData?: AnalysisOutput | null) => {
    if (playMode === "autocanonizer") {
      startAutocanonizerPlayback(index);
      return;
    }
    const player = playerRef.current;
    const engine = engineRef.current;
    const beats =
      vizDataRef.current?.beats ??
      analysisData?.beats ??
      analysisRef.current?.beats;
    if (!beats || !player || !engine) {
      return;
    }
    if (isPlaybackBlockedForAudioMode()) {
      showPreparingToast();
      return;
    }
    const beat = beats[index];
    if (!beat) {
      return;
    }

    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    player.seek(beat.start);
    engine.seekToBeat(index);
    lastBeatRef.current = index;
    vizControllerRef.current?.update(index, true, null);
    syncPredictedJumps();

    if (!isRunningRef.current) {
      engine.play();
      engine.startJukebox(false);
      lastPlayStampRef.current = performance.now();
      isRunningRef.current = true;
      isPausedRef.current = false;
      setIsRunning(true);
      setIsPaused(false);
      requestWakeLockIfFullscreen();
      return;
    }
    if (!player.isPlaying()) {
      engine.play();
    }
  };

  const startAutocanonizerPlayback = (
    index: number,
    options?: { resetSession?: boolean },
  ) => {
    const autocanonizer = autocanonizerRef.current;
    const engine = engineRef.current;
    const player = playerRef.current;
    if (!autocanonizer || !engine || !player || !autocanonizer.isReady()) {
      return false;
    }
    const resetSession = options?.resetSession ?? true;
    player.stop();
    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    engine.stopJukebox();
    if (resetSession) {
      resetPlaybackSessionMetrics();
      autocanonizer.resetVisualization();
    }
    autocanonizer.startAtIndex(index);
    if (resetSession || !isRunningRef.current) {
      lastPlayStampRef.current = performance.now();
    }
    isRunningRef.current = true;
    isPausedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);
    requestWakeLockIfFullscreen();
    return true;
  };

  const startSongSyncPlayback = (
    masterBeatIndex: number,
    options?: { resetSession?: boolean },
  ) => {
    const songsync = songsyncRef.current;
    const engine = engineRef.current;
    const player = playerRef.current;
    if (!songsync || !engine || !player || !songsync.isReady()) {
      return false;
    }
    const resetSession = options?.resetSession ?? true;
    player.stop();
    cowbellOverlayRef.current?.cancelScheduledHits();
    metronomeOverlayRef.current?.cancelScheduledHits();
    engine.stopJukebox();
    if (resetSession) {
      resetPlaybackSessionMetrics();
      songsync.resetVisualization();
    }
    if (masterBeatIndex <= 0 && resetSession) {
      songsync.start();
    } else {
      songsync.startAtIndex(masterBeatIndex);
    }
    if (resetSession || !isRunningRef.current) {
      lastPlayStampRef.current = performance.now();
    }
    isRunningRef.current = true;
    isPausedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);
    requestWakeLockIfFullscreen();
    return true;
  };

  const deleteSelectedBranch = () => {
    const engine = engineRef.current;
    const edge = selectedEdge;
    if (!engine || !edge || edge.deleted) {
      return;
    }
    engine.deleteEdge(edge);
    rebuildGraphAndSyncViz();
    clearSelectedBranch();
    syncTuneFormFromEngine();
    persistCurrentTuning();
    // Deleting the custom anchor's edge resets the anchor; the toast says which.
    showShortcutToast(
      isCustomAnchorEdge(edge) ? t("listen.anchorReset") : t("listen.branchDeleted"),
    );
  };

  const selectAdjacentBranch = (direction: -1 | 1) => {
    if (playModeRef.current !== "jukebox" || !selectedEdge) {
      return;
    }
    const edges =
      engineRef.current
        ?.getVisualizationData()
        ?.edges.filter((edge) => !edge.deleted) ?? [];
    if (edges.length === 0) {
      return;
    }
    const currentIndex = edges.findIndex((edge) => edge.id === selectedEdge.id);
    const nextIndex = nextEdgeIndex(currentIndex, direction, edges.length);
    const nextEdge = edges[nextIndex];
    setSelectedEdge(nextEdge);
    vizControllerRef.current?.setSelectedEdgeActive(nextEdge);
  };

  const toggleSelectedAnchorBranch = () => {
    const engine = engineRef.current;
    let edge = selectedEdge;
    if (!engine || !edge || edge.deleted) {
      return false;
    }
    if (edge.dest.which >= edge.src.which) {
      // In layouts that draw a twin pair as one arc, a click may have
      // grabbed the forward one; in layouts that draw the two directions
      // apart, a forward selection is deliberate and gets no redirect.
      const twin = visualizationSeparatesPairedEdges(activeVizIndexRef.current)
        ? null
        : findBackwardTwin(vizDataRef.current?.edges ?? [], edge);
      if (!twin) {
        showShortcutToast(t("listen.anchorRequiresBackward"));
        return false;
      }
      edge = twin;
      setSelectedEdge(twin);
    }
    const nextAnchor = engine.getUserAnchorEdgeId() === edge.id ? null : edge;
    engine.setUserAnchorEdge(nextAnchor);
    const data = syncVizDataFromEngine();
    // Unpinning a branch the tuning filters out removes it from the viz, so the selection is cleared.
    if (data && !data.edges.includes(edge)) {
      clearSelectedBranch();
    } else {
      vizControllerRef.current?.setSelectedEdgeActive(edge);
    }
    syncPredictedJumps();
    persistCurrentTuning();
    showShortcutToast(
      nextAnchor ? t("listen.anchorSet") : t("listen.anchorReset"),
    );
    return true;
  };

  // Live-applied tuning handler (no Apply button).
  const handleTuneFormChange = (nextForm: TuneFormState) => {
    const engine = engineRef.current;
    const player = playerRef.current;
    if (!engine || !player) {
      setTuneForm(nextForm);
      return;
    }
    let minProb = nextForm.minProb;
    let maxProb = nextForm.maxProb;
    if (minProb > maxProb) {
      [minProb, maxProb] = [maxProb, minProb];
    }
    const useAutoThreshold = nextForm.threshold === nextForm.computedThreshold;
    const crossThreshold = nextForm.crossThreshold ?? 0;
    const computedCross = nextForm.computedCrossThreshold ?? null;
    const useAutoCrossThreshold =
      crossThreshold <= 0 ||
      (computedCross !== null &&
        Number.isFinite(computedCross) &&
        crossThreshold === computedCross);
    const maxBranches = clampMaxBranches(nextForm.maxBranches);
    const sliderMaxPct =
      nextForm.maxLongBranchPercent > 0 && nextForm.maxLongBranchPercent < 100
        ? Math.max(1, Math.round(nextForm.maxLongBranchPercent))
        : 100;
    const maxLongBranchPercent = sliderMaxPct >= 100 ? 0 : sliderMaxPct;

    engine.updateConfig({
      maxBranches,
      currentThreshold: useAutoThreshold ? 0 : nextForm.threshold,
      crossTrackThreshold: useAutoCrossThreshold ? 0 : crossThreshold,
      minRandomBranchChance: minProb / 100,
      maxRandomBranchChance: maxProb / 100,
      randomBranchChanceDelta: nextForm.ramp / RANDOM_BRANCH_DELTA_PERCENT_SCALE,
      justBackwards: nextForm.justBackwards,
      justLongBranches: nextForm.minLongBranchPercent > 0,
      minLongBranchPercent:
        nextForm.minLongBranchPercent > 0
          ? nextForm.minLongBranchPercent
          : DEFAULT_MIN_LONG_BRANCH_PERCENT,
      maxLongBranchPercent,
      removeSequentialBranches: nextForm.removeSequentialBranches,
    });
    setHighlightAnchorBranch(nextForm.highlightAnchorBranch);
    storeAnchorHighlight(nextForm.highlightAnchorBranch);
    vizControllerRef.current?.setAnchorHighlightEnabled(
      nextForm.highlightAnchorBranch,
    );
    rebuildGraphAndSyncViz();
    syncTuneFormFromEngine(nextForm.highlightAnchorBranch);
    setTuningNonDefault(hasNonDefaultTuning(engine));
    if (!isRunningRef.current) {
      counters.set({ branchChanceText: `${Math.round(minProb)}%` });
    }
    persistCurrentTuning();
  };

  // Live-applied extras handler (no Apply button).
  const handleExtrasFormChange = (nextExtras: ExtrasFormState) => {
    setExtrasForm(nextExtras);
    const player = playerRef.current;
    if (!player) {
      return;
    }
    const previousAudioMode = jukeboxAudioModeRef.current;
    const previousAudioIntensity = audioIntensityRef.current;
    const nextBranchStatsEnabled =
      playModeRef.current === "jukebox" && nextExtras.branchStatsEnabled;
    const nextBringItHomeMode =
      playModeRef.current === "jukebox" && nextExtras.bringItHomeMode;
    const nextAudioMode = nextExtras.audioMode;
    const nextAudioIntensity = clampAudioModeIntensity(
      nextExtras.audioIntensity,
    );
    bringItHomeModeRef.current = nextBringItHomeMode;
    setBringItHomeMode(nextBringItHomeMode);
    if (nextBringItHomeMode) {
      engineRef.current?.setForceBranch(false);
    }
    engineRef.current?.setBringItHomeMode(nextBringItHomeMode);
    setBranchStatsEnabled(nextBranchStatsEnabled);
    storeBranchStatsEnabled(nextBranchStatsEnabled);
    setCustomAnchorEnabled(nextExtras.customAnchorEnabled);
    storeCustomAnchorEnabled(nextExtras.customAnchorEnabled);
    if (!nextExtras.customAnchorEnabled) {
      customAnchor.exit();
    }
    jukeboxAudioModeRef.current = nextAudioMode;
    audioIntensityRef.current = nextAudioIntensity;
    setJukeboxAudioMode(nextAudioMode);
    setAudioIntensity(nextAudioIntensity);
    if (nextAudioMode === "cowbell") {
      cowbellOverlayRef.current?.enable();
    } else {
      cowbellOverlayRef.current?.disable();
    }
    if (nextAudioMode !== "instrumental") {
      cancelInstrumentalRender();
    }
    if (nextAudioMode === "swing") {
      player.setJukeboxAudioMode("swing", nextAudioIntensity);
      if (canPrepareSwingMode()) {
        prepareSwingMode();
      } else {
        showShortcutToast(t("listen.swingWhenLoaded"));
      }
    } else if (nextAudioMode === "instrumental") {
      player.setJukeboxAudioMode("instrumental", nextAudioIntensity);
      if (canPrepareInstrumentalMode()) {
        prepareInstrumentalMode();
      } else {
        showShortcutToast(t("listen.instrumentalWhenLoaded"));
      }
    } else {
      stopPreparing();
      player.setJukeboxAudioMode(nextAudioMode, nextAudioIntensity);
    }
    writeAudioModeToUrl(nextAudioMode, nextAudioIntensity, true);
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
        playModeRef.current === "jukebox" &&
        nextAudioMode !== "swing" &&
        nextAudioMode !== "instrumental" &&
        (isRunningRef.current || isPausedRef.current)
      ) {
        engineRef.current?.syncToPlaybackPosition();
      }
    }
    syncPredictedJumps();
  };

  const handleResetTuningAndExtras = () => {
    const engine = engineRef.current;
    const player = playerRef.current;
    if (!engine || !player) {
      return;
    }
    customAnchor.discard();
    engine.clearDeletedEdges();
    const isMulti = multiTrackEnabledRef.current;
    engine.updateConfig({
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: isMulti ? crossTrackOnly : false,
      crossTrackThreshold: 0,
      coverSync: isMulti ? coverSyncEnabled : false,
      timeSignatureBranching: isMulti ? timeSignatureBranchingEnabled : false,
      timeSignatureBranchMode: isMulti
        ? timeSignatureBranchMode
        : DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
      timeSignatureNumerator: isMulti
        ? timeSignatureNumerator
        : DEFAULT_TIME_SIGNATURE_NUMERATOR,
      timeSignatureDenominator: isMulti
        ? timeSignatureDenominator
        : DEFAULT_TIME_SIGNATURE_DENOMINATOR,
      timeSignatureTrackOffsets: isMulti
        ? [...timeSignatureTrackOffsets]
        : [],
      timeSignatureSimilarityRestrict: isMulti
        ? timeSignatureSimilarityRestrictEnabled
        : false,
      timeSignatureSimilarityNumerator: isMulti
        ? timeSignatureSimilarityNumerator
        : DEFAULT_TIME_SIGNATURE_NUMERATOR,
      timeSignatureSimilarityDenominator: isMulti
        ? timeSignatureSimilarityDenominator
        : DEFAULT_TIME_SIGNATURE_DENOMINATOR,
    });
    if (!isMulti) {
      setTimeSignatureSimilarityRestrictEnabled(false);
      setTimeSignatureSimilarityNumerator(DEFAULT_TIME_SIGNATURE_NUMERATOR);
      setTimeSignatureSimilarityDenominator(
        DEFAULT_TIME_SIGNATURE_DENOMINATOR,
      );
      setTimeSignatureTrackOffsets([]);
    }
    rebuildGraphAndSyncViz();
    clearSelectedBranch();
    syncTuneFormFromEngine();
    setTuningNonDefault(hasNonDefaultTuning(engine));

    const previousAudioMode = jukeboxAudioModeRef.current;
    bringItHomeModeRef.current = false;
    setBringItHomeMode(false);
    engine.setBringItHomeMode(false);
    setMetronomeVolumePct(DEFAULT_METRONOME_VOLUME_PCT);
    metronomeOverlayRef.current?.setMetronomeVolumePct(
      DEFAULT_METRONOME_VOLUME_PCT,
    );
    setExtrasForm((prev) => ({
      ...prev,
      bringItHomeMode: false,
    }));
    resetAudioModeToOff(player);
    if (
      previousAudioMode !== "off" &&
      playModeRef.current === "jukebox" &&
      (isRunningRef.current || isPausedRef.current)
    ) {
      engine.syncToPlaybackPosition();
    }
    if (fingerprintRef.current && !isMulti) {
      removeTuning(fingerprintRef.current);
    }
    if (!isRunningRef.current) {
      counters.set({
        branchChanceText: `${Math.round(engine.getConfig().minRandomBranchChance * 100)}%`,
      });
    }
  };

  // Multi-track Jukebox mixing helpers.
  const applyLoadedMixSources = (
    sources: LoadedLocalMixSource[],
    overrides?: {
      tempoSyncEnabled?: boolean;
      normalizeVolumeEnabled?: boolean;
      postMixNormalizeVolumeEnabled?: boolean;
      mixTrackGainsPct?: readonly number[];
      timeSignatureTrackOffsets?: readonly number[];
    },
  ) => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    const nextTempoSync = overrides?.tempoSyncEnabled ?? tempoSyncEnabled;
    const nextNormalize =
      overrides?.normalizeVolumeEnabled ?? normalizeVolumeEnabled;
    const nextPostMixNorm =
      overrides?.postMixNormalizeVolumeEnabled ?? postMixNormalizeVolumeEnabled;
    const nextGainsPct = overrides?.mixTrackGainsPct ?? mixTrackGainsPct;
    const nextOffsets =
      overrides?.timeSignatureTrackOffsets ?? timeSignatureTrackOffsets;

    const built = buildJukeboxMix(player.getContext(), sources, {
      tempoSyncEnabled: nextTempoSync,
      normalizeVolumeEnabled: nextNormalize,
      mixTrackGainsPct: nextGainsPct,
      timeSignatureTrackOffsets: nextOffsets,
    });

    player.loadBuffer(built.combined.buffer);
    player.setPostMixTrackSlices?.(
      built.combined.sliceDurations,
      built.resolvedGainsPct.map((pct) => pct / 100),
    );
    player.setPostMixNormalization?.(nextPostMixNorm);

    const activeAudioMode = jukeboxAudioModeRef.current;
    if (activeAudioMode === "cowbell") {
      cowbellOverlayRef.current?.enable();
      player.setJukeboxAudioMode("cowbell", audioIntensityRef.current);
    } else if (
      activeAudioMode !== "swing" &&
      activeAudioMode !== "instrumental"
    ) {
      player.setJukeboxAudioMode(activeAudioMode, audioIntensityRef.current);
    }

    multiTrackEnabledRef.current = true;
    setMultiTrackEnabled(true);
    setMergedAnalysis(built.mergedAnalysis);
    setMixTracksMeta(sources.map((s) => ({ title: s.title })));
    setMixTrackGainsPct(built.resolvedGainsPct);
    setTimeSignatureTrackOffsets(built.resolvedTrackOffsets);
    setMixTitleOverride(sources.map((s) => s.title).join(" × "));
    setMixDurationOverrideSec(
      built.mergedAnalysis.tracks?.[0]?.duration ??
        built.mergedAnalysis.track?.duration ??
        built.combined.buffer.duration,
    );

    initializeEngine(built.mergedAnalysis, { skipAutocanonizer: true });
    engineRef.current?.updateConfig({
      crossTrackOnly,
      coverSync: coverSyncEnabled,
      timeSignatureBranching: timeSignatureBranchingEnabled,
      timeSignatureBranchMode,
      timeSignatureNumerator,
      timeSignatureDenominator,
      timeSignatureTrackOffsets: built.resolvedTrackOffsets,
      timeSignatureSimilarityRestrict: timeSignatureSimilarityRestrictEnabled,
      timeSignatureSimilarityNumerator,
      timeSignatureSimilarityDenominator,
    });
    rebuildGraphAndSyncViz();
    syncTuneFormFromEngine();
    setTuningNonDefault(
      engineRef.current ? hasNonDefaultTuning(engineRef.current) : false,
    );

    if (activeAudioMode === "swing") {
      player.setJukeboxAudioMode("swing", audioIntensityRef.current);
      prepareSwingMode();
    } else if (activeAudioMode === "instrumental") {
      player.setJukeboxAudioMode("instrumental", audioIntensityRef.current);
      prepareInstrumentalMode();
    }
  };

  const loadMultiTrackMix = async () => {
    const player = playerRef.current;
    if (!player || playModeRef.current !== "jukebox" || mixQueue.length < 2) {
      return false;
    }
    const tracks = mixQueue.slice(0, MAX_MIX_TRACKS);
    stopPlayback();
    const gen = ++mixLoadGenerationRef.current;
    setIsMixing(true);
    try {
      const sources = await resolveLocalMixSources(tracks, player.getContext(), {
        isCancelled: () => mixLoadGenerationRef.current !== gen,
      });
      if (mixLoadGenerationRef.current !== gen || sources.length < 2) {
        return false;
      }
      const restoredOffsets = sources.map((source) =>
        resolveStoredBpmBarBeatOffsetForTrack(source.fingerprint),
      );
      setTimeSignatureTrackOffsets(restoredOffsets);
      if (restoredOffsets.length > 0) {
        setBpmBarBeatOffset(restoredOffsets[0]);
      }
      cachedMixSourcesRef.current = sources;
      applyLoadedMixSources(sources, {
        timeSignatureTrackOffsets: restoredOffsets,
      });
      return true;
    } catch (err) {
      if (mixLoadGenerationRef.current === gen) {
        console.warn(`Multi-track mix failed: ${String(err)}`);
        showShortcutToast(t("mix.loadFailed"));
      }
      return false;
    } finally {
      if (mixLoadGenerationRef.current === gen) {
        setIsMixing(false);
      }
    }
  };

  const disableMultiTrackMix = async () => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    mixLoadGenerationRef.current += 1;
    cachedMixSourcesRef.current = null;
    stopPlayback();
    multiTrackEnabledRef.current = false;
    setMultiTrackEnabled(false);
    setMergedAnalysis(null);
    setMixTracksMeta([]);
    setMixTrackGainsPct([]);
    setMixTitleOverride(null);
    setMixDurationOverrideSec(null);
    player.clearPostMixTrackGains?.();
    player.setPostMixNormalization?.(false);

    if (analysisRef.current && file) {
      const audioMode = jukeboxAudioModeRef.current;
      const decoder = new AudioDecoder(player.getContext());
      try {
        const decoded = await decoder.decode(file);
        await player.loadBuffer(decoded.audioBuffer);
      } catch {
        // Keep buffer if decode fails.
      }
      setCrossTrackOnly(false);
      setCoverSyncEnabled(false);
      setTimeSignatureBranchingEnabled(false);
      setTimeSignatureSimilarityRestrictEnabled(false);
      setTimeSignatureBranchMode(DEFAULT_TIME_SIGNATURE_BRANCH_MODE);
      setTimeSignatureNumerator(DEFAULT_TIME_SIGNATURE_NUMERATOR);
      setTimeSignatureDenominator(DEFAULT_TIME_SIGNATURE_DENOMINATOR);
      setTimeSignatureSimilarityNumerator(DEFAULT_TIME_SIGNATURE_NUMERATOR);
      setTimeSignatureSimilarityDenominator(DEFAULT_TIME_SIGNATURE_DENOMINATOR);
      const restoredOffset = resolveStoredBpmBarBeatOffsetForTrack(
        fingerprintRef.current,
      );
      setBpmBarBeatOffset(restoredOffset);
      setTimeSignatureTrackOffsets([restoredOffset]);
      initializeEngine(analysisRef.current);
      if (fingerprintRef.current) {
        restoreSavedTuning(fingerprintRef.current, restoredOffset);
      } else if (restoredOffset !== 0) {
        engineRef.current?.updateConfig({
          timeSignatureTrackOffsets: [restoredOffset],
        });
      }
      if (audioMode === "swing") {
        player.setJukeboxAudioMode("swing", audioIntensityRef.current);
        maybePrepareSwingMode();
      } else if (audioMode === "instrumental") {
        player.setJukeboxAudioMode("instrumental", audioIntensityRef.current);
        maybePrepareInstrumentalMode();
      } else {
        player.setJukeboxAudioMode(audioMode, audioIntensityRef.current);
      }
    }
  };

  // Autocanonizer 2-song & 4-voice quad mixing helpers.
  const applyLoadedAutocanonizerMixSources = (
    sources: [LoadedLocalMixSource, LoadedLocalMixSource],
    overrides?: {
      alignmentMode?: AutocanonizerMixAlignmentMode;
      quadMode?: boolean;
      quadBranchMode?: AutocanonizerQuadBranchMode;
    },
  ) => {
    const player = playerRef.current;
    const autocanonizer = autocanonizerRef.current;
    if (!player || !autocanonizer) {
      return;
    }
    const [mainSource, otherSource] = sources;
    const built = buildAutocanonizerMix(
      player.getContext(),
      mainSource,
      otherSource,
    );
    const alignmentMode = overrides?.alignmentMode ?? autocanonizerMixAlignment;
    const quadMode = overrides?.quadMode ?? autocanonizerQuadMode;
    const quadBranchMode =
      overrides?.quadBranchMode ?? autocanonizerQuadBranchMode;

    autocanonizer.setDualAudio?.(
      built.prepared.mainBuffer,
      built.prepared.otherBuffer,
      player.getContext(),
    );
    autocanonizer.setDualAnalysis?.(mainSource.analysis, otherSource.analysis, {
      mainDuration: built.prepared.mainDurationSec,
      otherDuration: built.prepared.otherDurationSec,
      otherTempoRatio: built.otherTempoRatio,
      alignmentMode,
      quadMode,
      quadBranchMode,
    });
    autocanonizer.setStreamPans(
      autocanonizerMainPan / 100,
      autocanonizerOtherPan / 100,
    );
    autocanonizer.setStreamGains?.(
      autocanonizerMainGainPct / 100,
      autocanonizerOtherGainPct / 100,
    );
    autocanonizer.setQuadStreamPans?.(
      autocanonizerPinkPan / 100,
      autocanonizerGoldPan / 100,
    );
    autocanonizer.setQuadStreamGains?.(
      autocanonizerPinkGainPct / 100,
      autocanonizerGoldGainPct / 100,
    );

    const title1 = mainSource.title || t("common.untitled");
    const title2 = otherSource.title || t("common.untitled");
    autocanonizerMixEnabledRef.current = true;
    setAutocanonizerMixEnabled(true);
    setAutocanonizerMixTrackTitles([title1, title2]);
    setAutocanonizerOtherDurationSec(built.prepared.otherDurationSec);
    setMixTitleOverride(`${title1} × ${title2}`);
    setMixDurationOverrideSec(built.prepared.mainDurationSec);
    counters.set({
      autocanonizerMainSeconds: 0,
      autocanonizerOtherSeconds: 0,
      autocanonizerPinkSeconds: 0,
      autocanonizerGoldSeconds: 0,
    });
    resetLiveBpm(mainSource.tempo ?? null);
  };

  const loadAutocanonizerMix = async () => {
    const player = playerRef.current;
    if (
      !player ||
      playModeRef.current !== "autocanonizer" ||
      mixQueue.length < 2
    ) {
      return false;
    }
    if (mixQueue.length > MAX_AUTOCANONIZER_MIX_TRACKS) {
      showShortcutToast(t("mix.canonizerFirst2"));
    }
    const tracks = mixQueue.slice(0, MAX_AUTOCANONIZER_MIX_TRACKS);
    stopPlayback();
    const gen = ++mixLoadGenerationRef.current;
    setIsMixing(true);
    try {
      const sources = await resolveLocalMixSources(tracks, player.getContext(), {
        isCancelled: () => mixLoadGenerationRef.current !== gen,
      });
      if (mixLoadGenerationRef.current !== gen || sources.length < 2) {
        return false;
      }
      const pair: [LoadedLocalMixSource, LoadedLocalMixSource] = [
        sources[0],
        sources[1],
      ];
      cachedAutocanonizerMixSourcesRef.current = pair;
      applyLoadedAutocanonizerMixSources(pair);
      return true;
    } catch (err) {
      if (mixLoadGenerationRef.current === gen) {
        console.warn(`Autocanonizer mix failed: ${String(err)}`);
        showShortcutToast(t("mix.loadFailed"));
      }
      return false;
    } finally {
      if (mixLoadGenerationRef.current === gen) {
        setIsMixing(false);
      }
    }
  };

  const disableAutocanonizerMix = async () => {
    mixLoadGenerationRef.current += 1;
    cachedAutocanonizerMixSourcesRef.current = null;
    stopPlayback();
    autocanonizerMixEnabledRef.current = false;
    setAutocanonizerMixEnabled(false);
    setAutocanonizerQuadMode(false);
    setAutocanonizerMixTrackTitles(null);
    setAutocanonizerOtherDurationSec(null);
    setMixTitleOverride(null);
    setMixDurationOverrideSec(null);
    setAutocanonizerMainGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    setAutocanonizerOtherGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    setAutocanonizerPinkGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    setAutocanonizerGoldGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    autocanonizerRef.current?.setQuadMode?.(false);
    autocanonizerRef.current?.setStreamGains?.(1, 1);
    autocanonizerRef.current?.setQuadStreamGains?.(1, 1);

    const player = playerRef.current;
    if (player && analysisRef.current) {
      autocanonizerRef.current?.setAudio(
        player.getSourceBuffer() ?? null,
        player.getContext(),
      );
      autocanonizerRef.current?.setAnalysis(
        analysisRef.current,
        analysisRef.current.track?.duration,
      );
      resetLiveBpm(
        resolveTrackBaseTempoBpm(
          analysisRef.current.track?.tempo,
          analysisRef.current.beats,
        ),
      );
    }
  };

  // Song Sync helpers & instrumental-only feature toggle.
  const syncSongSyncUiFromController = () => {
    const songsync = songsyncRef.current;
    if (!songsync) {
      setSongSyncTracks([]);
      setSongSyncTrackTimes([]);
      return;
    }
    const meta = songsync.getTrackMeta();
    setSongSyncMasterTrackIndex(songsync.getMasterTrackIndex());
    setSongSyncTracks(
      meta.map((track) => ({
        title: track.title,
        color: track.color,
        gainPct: Math.round(track.gain * 100),
        pan: Math.round(track.pan * 100),
        muted: track.muted,
        solo: track.solo,
        beatOffset: track.beatOffset,
      })),
    );
    setSongSyncTrackTimes(
      meta.map((track) => ({
        title: track.title,
        color: track.color,
        durationSec: track.duration,
      })),
    );
  };

  const applyLoadedSongSyncSources = (
    sources: LoadedLocalMixSource[],
    options?: {
      tempoSyncEnabled?: boolean;
      normalizeVolumeEnabled?: boolean;
      masterTrackIndex?: number;
      preservedConfigs?: ReadonlyMap<
        string,
        {
          gain: number;
          pan: number;
          muted: boolean;
          solo: boolean;
          beatOffset: number;
        }
      >;
    },
  ) => {
    const player = playerRef.current;
    const songsync = songsyncRef.current;
    if (!player || !songsync) {
      return;
    }
    const nextTempoSync = options?.tempoSyncEnabled ?? songSyncTempoSyncEnabled;
    const nextNormalize =
      options?.normalizeVolumeEnabled ?? songSyncNormalizeVolumeEnabled;

    // Default master track to the longest source so shorter edits align within it.
    let longestIdx = 0;
    let longestDuration = -1;
    sources.forEach((source, index) => {
      const duration = source.analysis.track?.duration ?? source.audioBuffer.duration;
      if (duration > longestDuration) {
        longestDuration = duration;
        longestIdx = index;
      }
    });
    const nextMasterIdx =
      typeof options?.masterTrackIndex === "number" &&
      options.masterTrackIndex >= 0 &&
      options.masterTrackIndex < sources.length
        ? options.masterTrackIndex
        : longestIdx;

    const built = buildSongSyncMix(player.getContext(), sources, {
      tempoSyncEnabled: nextTempoSync,
      normalizeVolumeEnabled: nextNormalize,
      masterTrackIndex: nextMasterIdx,
    });

    songsync.setTracks(
      sources.map((source, index) => {
        const preserved = options?.preservedConfigs?.get(source.id);
        const storedOffset = resolveStoredBpmBarBeatOffsetForTrack(
          source.fingerprint,
        );
        return {
          title: source.title || t("common.untitled"),
          buffer: built.prepared.buffers[index],
          analysis: source.analysis,
          durationSec: built.prepared.durationsSec[index],
          tempo: source.tempo,
          tempoRatio: built.tempoRatios[index],
          gain: preserved?.gain ?? DEFAULT_MIX_TRACK_GAIN_PCT / 100,
          pan: preserved?.pan ?? 0,
          muted: preserved?.muted ?? false,
          solo: preserved?.solo ?? false,
          beatOffset: preserved?.beatOffset ?? storedOffset,
        };
      }),
      player.getContext(),
      {
        masterTrackIndex: nextMasterIdx,
        loop: loopTrack,
      },
    );

    syncSongSyncUiFromController();
    const masterSource = sources[nextMasterIdx] ?? sources[0];
    const detected = detectTrackBeatsPerBar(
      normalizeAnalysis(masterSource.analysis).beats,
      masterSource.analysis.track?.time_signature,
    );
    setDetectedBeatsPerBar(detected);
    metronomeOverlayRef.current?.setBeatsPerBar(detected);
    setMixTitleOverride(
      sources.map((source) => source.title || t("common.untitled")).join(" + "),
    );
    setMixDurationOverrideSec(
      built.prepared.durationsSec[nextMasterIdx] ??
        built.prepared.durationsSec[0] ??
        null,
    );
    counters.set({
      songSyncTrackSeconds: new Array<number>(sources.length).fill(0),
    });
    resetLiveBpm(masterSource.tempo ?? null);
  };

  const loadSongSyncMix = async () => {
    const player = playerRef.current;
    if (
      !player ||
      playModeRef.current !== "songsync" ||
      mixQueue.length < 2
    ) {
      return false;
    }
    const tracks = mixQueue.slice(0, MAX_MIX_TRACKS);
    const prevSources = cachedSongSyncSourcesRef.current ?? [];
    const prevMeta = songsyncRef.current?.getTrackMeta() ?? [];
    const prevById = new Map<string, LoadedLocalMixSource>();
    const preservedConfigs = new Map<
      string,
      {
        gain: number;
        pan: number;
        muted: boolean;
        solo: boolean;
        beatOffset: number;
      }
    >();
    prevSources.forEach((source, idx) => {
      prevById.set(source.id, source);
      const meta = prevMeta[idx];
      if (meta) {
        preservedConfigs.set(source.id, {
          gain: meta.gain,
          pan: meta.pan,
          muted: meta.muted,
          solo: meta.solo,
          beatOffset: meta.beatOffset,
        });
      }
    });

    const missingTracks = tracks.filter((track) => !prevById.has(track.id));
    stopPlayback();
    const gen = ++mixLoadGenerationRef.current;
    if (missingTracks.length > 0) {
      setIsMixing(true);
    }
    try {
      const resolvedMissing =
        missingTracks.length > 0
          ? await resolveLocalMixSources(missingTracks, player.getContext(), {
              isCancelled: () => mixLoadGenerationRef.current !== gen,
            })
          : [];
      if (mixLoadGenerationRef.current !== gen) {
        return false;
      }
      const missingById = new Map(
        resolvedMissing.map((source) => [source.id, source]),
      );
      const sources = tracks
        .map((track) => prevById.get(track.id) ?? missingById.get(track.id))
        .filter((source): source is LoadedLocalMixSource => Boolean(source));
      if (sources.length < 2) {
        return false;
      }
      cachedSongSyncSourcesRef.current = sources;
      loadedSongSyncSignatureRef.current = tracks.map((t) => t.id).join("|");
      applyLoadedSongSyncSources(sources, { preservedConfigs });
      return true;
    } catch (err) {
      if (mixLoadGenerationRef.current === gen) {
        console.warn(`Song Sync mix failed: ${String(err)}`);
        showShortcutToast(t("mix.loadFailed"));
      }
      return false;
    } finally {
      if (mixLoadGenerationRef.current === gen) {
        setIsMixing(false);
      }
    }
  };

  const disableSongSyncMix = () => {
    mixLoadGenerationRef.current += 1;
    cachedSongSyncSourcesRef.current = null;
    loadedSongSyncSignatureRef.current = "";
    songsyncRef.current?.reset();
    setSongSyncTracks([]);
    setSongSyncTrackTimes([]);
    setSongSyncMasterTrackIndex(0);
    setMixTitleOverride(null);
    setMixDurationOverrideSec(null);
  };

  const songSyncQueueSignature = React.useMemo(
    () =>
      mixQueue
        .slice(0, MAX_MIX_TRACKS)
        .map((track) => track.id)
        .join("|"),
    [mixQueue],
  );

  React.useEffect(() => {
    if (playMode !== "songsync") {
      return;
    }
    if (mixQueue.length < 2) {
      if (
        cachedSongSyncSourcesRef.current ||
        loadedSongSyncSignatureRef.current
      ) {
        stopPlayback();
        disableSongSyncMix();
        showShortcutToast(t("listen.songSyncNeedQueue"));
      }
      return;
    }
    if (songSyncQueueSignature !== loadedSongSyncSignatureRef.current) {
      void loadSongSyncMix();
    }
  }, [playMode, songSyncQueueSignature, mixQueue.length]);

  const onSongSyncMasterTrackChange = (index: number) => {
    const sources = cachedSongSyncSourcesRef.current;
    if (!sources || index < 0 || index >= sources.length) {
      return;
    }
    const wasRunning = isRunningRef.current;
    stopPlayback();
    setSongSyncMasterTrackIndex(index);
    applyLoadedSongSyncSources(sources, { masterTrackIndex: index });
    if (wasRunning) {
      startSongSyncPlayback(0, { resetSession: true });
    }
  };

  const onSongSyncTempoSyncChange = (enabled: boolean) => {
    setSongSyncTempoSyncEnabled(enabled);
    const sources = cachedSongSyncSourcesRef.current;
    if (sources && playModeRef.current === "songsync") {
      const wasRunning = isRunningRef.current;
      stopPlayback();
      applyLoadedSongSyncSources(sources, {
        tempoSyncEnabled: enabled,
        masterTrackIndex: songSyncMasterTrackIndex,
      });
      if (wasRunning) {
        startSongSyncPlayback(0, { resetSession: true });
      }
    }
  };

  const onSongSyncNormalizeVolumeChange = (enabled: boolean) => {
    setSongSyncNormalizeVolumeEnabled(enabled);
    const sources = cachedSongSyncSourcesRef.current;
    if (sources && playModeRef.current === "songsync") {
      const wasRunning = isRunningRef.current;
      stopPlayback();
      applyLoadedSongSyncSources(sources, {
        normalizeVolumeEnabled: enabled,
        masterTrackIndex: songSyncMasterTrackIndex,
      });
      if (wasRunning) {
        startSongSyncPlayback(0, { resetSession: true });
      }
    }
  };

  const onSongSyncTrackGainChange = (index: number, gainPct: number) => {
    const clamped = clampMixTrackGainPct(gainPct);
    songsyncRef.current?.setTrackConfig(index, { gain: clamped / 100 });
    syncSongSyncUiFromController();
  };

  const onSongSyncTrackPanChange = (index: number, pan: number) => {
    const clamped = Math.max(-100, Math.min(100, Math.round(pan)));
    songsyncRef.current?.setTrackConfig(index, { pan: clamped / 100 });
    syncSongSyncUiFromController();
  };

  const onSongSyncTrackMutedChange = (index: number, muted: boolean) => {
    songsyncRef.current?.setTrackConfig(index, { muted });
    syncSongSyncUiFromController();
  };

  const onSongSyncTrackSoloChange = (index: number, solo: boolean) => {
    songsyncRef.current?.setTrackConfig(index, { solo });
    syncSongSyncUiFromController();
  };

  const onSongSyncTrackBeatOffsetChange = (index: number, offset: number) => {
    const clamped = clampTimeSignatureTrackOffset(offset);
    songsyncRef.current?.setTrackConfig(index, { beatOffset: clamped });
    const source = cachedSongSyncSourcesRef.current?.[index];
    if (source?.fingerprint) {
      storeBpmBarBeatOffsetForTrack(source.fingerprint, clamped);
    }
    syncSongSyncUiFromController();
  };

  const onToggleMix = () => {
    const isCanonizer = playModeRef.current === "autocanonizer";
    const active = isCanonizer
      ? autocanonizerMixEnabledRef.current
      : multiTrackEnabledRef.current;
    if (active) {
      void (isCanonizer ? disableAutocanonizerMix() : disableMultiTrackMix());
      return;
    }
    if (mixQueue.length >= 2) {
      setMixAddSticky?.(false);
      void (isCanonizer ? loadAutocanonizerMix() : loadMultiTrackMix());
      return;
    }
    setMixAddSticky?.(true);
    showShortcutToast(
      isCanonizer ? t("mix.pick2Prompt") : t("mix.pickPrompt"),
    );
    navigate("/");
  };

  const onSwapAutocanonizerMix = () => {
    const pair = cachedAutocanonizerMixSourcesRef.current;
    if (!autocanonizerMixEnabledRef.current || !pair) {
      return;
    }
    const wasRunning = isRunningRef.current;
    stopPlayback();
    const swapped: [LoadedLocalMixSource, LoadedLocalMixSource] = [
      pair[1],
      pair[0],
    ];
    cachedAutocanonizerMixSourcesRef.current = swapped;
    applyLoadedAutocanonizerMixSources(swapped);
    if (wasRunning) {
      startAutocanonizerPlayback(0, { resetSession: true });
    }
  };

  const onVolumeChange = (value: number) => {
    setTuneForm((prev) => ({ ...prev, volume: value }));
    storeVolume(value);
    const volume = value / 100;
    playerRef.current?.setVolume(volume);
    autocanonizerRef.current?.setVolume(volume);
    songsyncRef.current?.setVolume(volume);
    wubmachineRef.current?.setVolume(volume);
    cowbellOverlayRef.current?.setVolume(volume);
    metronomeOverlayRef.current?.setVolume(volume);
  };

  const onAutocanonizerStreamPanChange = (
    stream: "main" | "other",
    value: number,
  ) => {
    const nextMain = stream === "main" ? value : autocanonizerMainPan;
    const nextOther = stream === "other" ? value : autocanonizerOtherPan;
    setAutocanonizerMainPan(nextMain);
    setAutocanonizerOtherPan(nextOther);
    autocanonizerMainPanRef.current = nextMain;
    autocanonizerOtherPanRef.current = nextOther;
    autocanonizerRef.current?.setStreamPans(nextMain / 100, nextOther / 100);
    storeAudioBalance(
      nextMain,
      nextOther,
      autocanonizerPinkPan,
      autocanonizerGoldPan,
    );
  };

  const onAutocanonizerQuadPanChange = (
    stream: "pink" | "gold",
    value: number,
  ) => {
    const nextPink = stream === "pink" ? value : autocanonizerPinkPan;
    const nextGold = stream === "gold" ? value : autocanonizerGoldPan;
    setAutocanonizerPinkPan(nextPink);
    setAutocanonizerGoldPan(nextGold);
    autocanonizerPinkPanRef.current = nextPink;
    autocanonizerGoldPanRef.current = nextGold;
    autocanonizerRef.current?.setQuadStreamPans?.(
      nextPink / 100,
      nextGold / 100,
    );
    storeAudioBalance(
      autocanonizerMainPan,
      autocanonizerOtherPan,
      nextPink,
      nextGold,
    );
  };

  const onAutocanonizerStreamGainChange = (
    stream: "main" | "other",
    gainPct: number,
  ) => {
    const clamped = clampMixTrackGainPct(gainPct);
    const nextMain = stream === "main" ? clamped : autocanonizerMainGainPct;
    const nextOther = stream === "other" ? clamped : autocanonizerOtherGainPct;
    setAutocanonizerMainGainPct(nextMain);
    setAutocanonizerOtherGainPct(nextOther);
    autocanonizerRef.current?.setStreamGains?.(nextMain / 100, nextOther / 100);
  };

  const onAutocanonizerQuadGainChange = (
    stream: "pink" | "gold",
    gainPct: number,
  ) => {
    const clamped = clampMixTrackGainPct(gainPct);
    const nextPink = stream === "pink" ? clamped : autocanonizerPinkGainPct;
    const nextGold = stream === "gold" ? clamped : autocanonizerGoldGainPct;
    setAutocanonizerPinkGainPct(nextPink);
    setAutocanonizerGoldGainPct(nextGold);
    autocanonizerRef.current?.setQuadStreamGains?.(
      nextPink / 100,
      nextGold / 100,
    );
  };

  const onResetAutocanonizerBalance = () => {
    setAutocanonizerMainPan(0);
    setAutocanonizerOtherPan(0);
    autocanonizerMainPanRef.current = 0;
    autocanonizerOtherPanRef.current = 0;
    autocanonizerRef.current?.setStreamPans(0, 0);
    setAutocanonizerMainGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    setAutocanonizerOtherGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
    autocanonizerRef.current?.setStreamGains?.(1, 1);
    if (autocanonizerQuadMode) {
      setAutocanonizerPinkPan(0);
      setAutocanonizerGoldPan(0);
      autocanonizerPinkPanRef.current = 0;
      autocanonizerGoldPanRef.current = 0;
      autocanonizerRef.current?.setQuadStreamPans?.(0, 0);
      setAutocanonizerPinkGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
      setAutocanonizerGoldGainPct(DEFAULT_MIX_TRACK_GAIN_PCT);
      autocanonizerRef.current?.setQuadStreamGains?.(1, 1);
      storeAudioBalance(0, 0, 0, 0);
    } else {
      storeAudioBalance(0, 0, autocanonizerPinkPan, autocanonizerGoldPan);
    }
  };

  const onSetActiveViz = (index: number) => {
    if (playMode !== "jukebox") {
      return;
    }
    const count = vizControllerRef.current?.getCount() ?? 1;
    if (!Number.isFinite(index) || index < 0 || index >= count) {
      return;
    }
    vizControllerRef.current?.setActiveIndex(index);
    setActiveVizIndex(index);
  };

  const { forceBranchActive, freezeBeatActive } = useListenHotkeys({
    isActive,
    playMode,
    selectedEdge,
    isRunning,
    isPaused,
    isTuningOpen,
    isInfoOpen,
    isExportOpen,
    isQueueOpen,
    engineRef,
    bringItHomeModeRef,
    setBringItHomeMode,
    showShortcutToast,
    t,
    openTuningModalTab,
    togglePlayback,
    selectAdjacentBranch,
    deleteSelectedBranch,
    toggleSelectedAnchorBranch,
    customAnchor,
  });

  const segmentCount = React.useMemo(
    () =>
      resolveBpmBarActiveSegment(
        bpmBarConfig,
        null,
        null,
        vizDataRef.current?.beats,
      ).segmentCount,
    [bpmBarConfig],
  );

  const isSmoothStyle = isSmoothBpmBarStyle(bpmBarStyle);
  const showSegmentOverlay =
    bpmBarStyle === "smooth-pulse" && segmentCount !== null;

  bpmBarRuntimeRef.current = {
    bpmBarConfig,
    bpmBarEnabled,
    bpmBarStyle,
    isSmoothStyle,
    playMode,
  };

  /**
   * Drives BPM bar pulse classes and smooth-fill CSS properties directly on the DOM
   * so high-frequency beat callbacks never force React component commits.
   */
  function triggerBpmBarPulse(
    beatIndex: number | null,
    beat: BpmBarPulseBeat | null,
  ) {
    const runtime = bpmBarRuntimeRef.current;
    const el = vizStatsRef.current;
    if (!el || !runtime.bpmBarConfig) {
      return;
    }
    if (!runtime.bpmBarEnabled) {
      clearBpmBarPulse();
      return;
    }
    el.classList.remove("pulse");
    const { segmentCount: activeSegCount, activeSegmentIndex } =
      resolveBpmBarActiveSegment(
        runtime.bpmBarConfig,
        beatIndex,
        beat,
        vizDataRef.current?.beats,
      );
    const fillEl = smoothFillRef.current;
    if (runtime.isSmoothStyle) {
      if (!fillEl) {
        return;
      }
      const player = playerRef.current;
      const playbackRate =
        runtime.playMode === "jukebox" ? (player?.getPlaybackRate?.() ?? 1) : 1;
      const currentTimeSec =
        runtime.playMode === "jukebox" && player?.isPlaying?.()
          ? player.getCurrentTime()
          : null;
      const anim = resolveBpmBarSmoothAnimation({
        segmentCount: activeSegCount,
        activeSegmentIndex,
        beatIndex,
        beat,
        playbackRate,
        currentTimeSec,
      });
      fillEl.classList.remove("is-animating", "is-downbeat");
      if (!anim) {
        for (const segEl of segmentRefs.current) {
          segEl?.classList.remove("is-pulsing");
        }
        return;
      }
      fillEl.style.setProperty("--bpm-bar-from", String(anim.fromFraction));
      fillEl.style.setProperty("--bpm-bar-to", String(anim.toFraction));
      fillEl.style.setProperty("--bpm-bar-duration", `${anim.durationMs}ms`);
      void fillEl.offsetWidth;
      if (anim.isDownbeat) {
        fillEl.classList.add("is-downbeat");
      }
      fillEl.classList.add("is-animating");
      if (runtime.bpmBarStyle === "smooth-pulse") {
        if (activeSegCount !== null && activeSegmentIndex !== null) {
          const segEl = segmentRefs.current[activeSegmentIndex];
          if (segEl) {
            segEl.classList.remove("is-pulsing");
            void segEl.offsetWidth;
            segEl.classList.add("is-pulsing");
          }
        } else if (activeSegCount === null) {
          void el.offsetWidth;
          el.classList.add("pulse");
        }
      }
      return;
    }
    if (activeSegCount !== null) {
      if (activeSegmentIndex !== null) {
        const segEl = segmentRefs.current[activeSegmentIndex];
        if (segEl) {
          segEl.classList.remove("is-pulsing");
          void segEl.offsetWidth;
          segEl.classList.add("is-pulsing");
        }
      }
      return;
    }
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  React.useLayoutEffect(() => {
    clearBpmBarPulse();
  }, [bpmBarEnabled, bpmBarStyle, segmentCount, clearBpmBarPulse]);

  const renderBpmBarSegments = (overlay: boolean) => {
    if (segmentCount === null) {
      return null;
    }
    const baseClass =
      segmentCount > 8 ? "bpm-bar-segments is-dense" : "bpm-bar-segments";
    return (
      <div
        id="bpm-bar-segments"
        className={overlay ? `${baseClass} is-overlay` : baseClass}
        aria-hidden="true"
      >
        {Array.from({ length: segmentCount }, (_, idx) => (
          <span
            key={idx}
            ref={(node) => {
              segmentRefs.current[idx] = node;
            }}
            data-bpm-segment={idx + 1}
            className={
              idx === 0 ? "bpm-bar-segment is-downbeat" : "bpm-bar-segment"
            }
          />
        ))}
      </div>
    );
  };

  const graph = engineRef.current?.getGraphState();
  const totalBeats = graph?.totalBeats ?? analysis?.beats.length ?? 0;
  const vizDataForCount = engineRef.current?.getVisualizationData();
  const totalBranches = vizDataForCount ? countTuningBranches(vizDataForCount) : 0;
  const deletedBranches = graph?.allEdges.filter((edge) => edge.deleted).length ?? 0;
  const vizCount = vizControllerRef.current?.getCount() ?? 1;
  const currentFileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : null;
  const loading = usePresentedLoading(
    liveLoading({
      fileKey: currentFileKey ?? "",
      isAnalyzing,
      analysisDone: Boolean(analysis) && !error && !prepAborted,
      stage: progressStage,
      stageProgress,
      preparingMode,
      preparingPhase,
      preparingProgress,
      modelDownloaded,
    }),
  );
  // The tabs stay hidden until the analysis steps have played out.
  const analysisShown = loading.shown?.task === "localAnalysis" || loading.shown?.task === "track";
  React.useEffect(() => {
    setIsListenLoading(isAnalyzing || analysisShown || isMixing);
    return () => {
      setIsListenLoading(false);
    };
  }, [isAnalyzing, analysisShown, isMixing, setIsListenLoading]);
  const showPlaybackUi =
    !loading.shown &&
    !isMixing &&
    Boolean(analysis) &&
    !isAnalyzing &&
    preparingMode === null &&
    readyFileKey === currentFileKey;
  const playControlLabel = playControlText({
    preparingMode,
    isRunning,
    isPaused,
    t,
  });
  const playIcon = playControlIcon(preparingMode !== null, isRunning);
  const beatsLabel =
    jukeboxAudioMode === "cowbell"
      ? t("listen.totalCowbells")
      : t("listen.totalBeats");
  const branchStats =
    branchStatsEnabled && playMode === "jukebox" && selectedEdge
      ? deriveBranchStats(
          selectedEdge,
          Math.max(1, engineRef.current?.getConfig().maxBranchThreshold ?? 80),
          t,
        )
      : null;

  const anchorLabels = customAnchorLabels(t);
  const anchorBeats = customAnchor.edit ? vizDataRef.current?.beats : undefined;
  // Edge selection is off while editing, so a stale selection would only confuse.
  const startCustomAnchorEdit = () => {
    if (playModeRef.current !== "jukebox") {
      return;
    }
    clearSelectedBranch();
    customAnchor.start();
  };

  const closeSettings = () => setIsSettingsOpen(false);
  const settingsModal = isSettingsOpen ? (
    <SettingsModal
      theme={theme}
      onThemeChange={(option) => {
        setTheme(option);
        applyTheme(option);
        vizControllerRef.current?.refresh();
      }}
      sleepTimer={sleepTimer}
      pendingSleepTimerDurationMs={pendingSleepTimerDurationMs}
      onPendingSleepTimerDurationChange={setPendingSleepTimerDurationMs}
      onSetSleepTimer={setSleepTimer}
      onClose={closeSettings}
    />
  ) : null;

  // Computed before the early return (and file-guarded) so the marquee hooks
  // below run unconditionally on every render, keeping hook order stable.
  const baseTitle = mixTitleOverride ?? file?.name ?? "";
  const displayTitle = baseTitle
    ? formatTrackTitle(baseTitle, playMode, jukeboxAudioMode, t)
    : "";
  // The marquee controller owns each title node's text imperatively, so the
  // title <div>s are left empty in JSX (see .play-title / .viz-title) and wired
  // through these ref callbacks.
  const playTitleRef = useMarquee(displayTitle);
  const vizTitleRef = useMarquee(displayTitle);

  const showTuningReset =
    tuningNonDefault ||
    hasNonDefaultExtras({ audioMode: jukeboxAudioMode, bringItHomeMode });

  const resolvedMixTracks =
    multiTrackEnabled && mixTracksMeta.length > 0
      ? mixTracksMeta
      : mixQueue.slice(0, MAX_MIX_TRACKS).map((item, index) => ({
          title: item.title || t("mix.trackNumber", { index: index + 1 }),
        }));

  const multiTuningProps = {
    multiTrackEnabled,
    mixTracks: resolvedMixTracks,
    crossTrackOnly,
    onCrossTrackOnlyChange: (enabled: boolean) => {
      setCrossTrackOnly(enabled);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({ crossTrackOnly: enabled });
      rebuildGraphAndSyncViz();
      syncTuneFormFromEngine();
      if (engineRef.current) {
        setTuningNonDefault(hasNonDefaultTuning(engineRef.current));
      }
    },
    coverSyncEnabled,
    onCoverSyncChange: (enabled: boolean) => {
      setCoverSyncEnabled(enabled);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({ coverSync: enabled });
      rebuildGraphAndSyncViz();
      syncTuneFormFromEngine();
      if (engineRef.current) {
        setTuningNonDefault(hasNonDefaultTuning(engineRef.current));
      }
    },
    tempoSyncEnabled,
    onTempoSyncChange: (enabled: boolean) => {
      setTempoSyncEnabled(enabled);
      if (multiTrackEnabledRef.current && cachedMixSourcesRef.current) {
        stopPlayback();
        applyLoadedMixSources(cachedMixSourcesRef.current, {
          tempoSyncEnabled: enabled,
        });
      }
    },
    normalizeVolumeEnabled,
    onNormalizeVolumeChange: (enabled: boolean) => {
      setNormalizeVolumeEnabled(enabled);
      if (multiTrackEnabledRef.current && cachedMixSourcesRef.current) {
        stopPlayback();
        applyLoadedMixSources(cachedMixSourcesRef.current, {
          normalizeVolumeEnabled: enabled,
        });
      }
    },
    postMixNormalizeVolumeEnabled,
    onPostMixNormalizeVolumeChange: (enabled: boolean) => {
      setPostMixNormalizeVolumeEnabled(enabled);
      if (multiTrackEnabledRef.current) {
        playerRef.current?.setPostMixNormalization?.(enabled);
      }
    },
    mixTrackGainsPct,
    onMixTrackGainChange: (index: number, gainPct: number) => {
      const clamped = clampMixTrackGainPct(gainPct);
      const next = mixTrackGainsPct.slice();
      while (next.length <= index) {
        next.push(DEFAULT_MIX_TRACK_GAIN_PCT);
      }
      next[index] = clamped;
      setMixTrackGainsPct(next);
      if (multiTrackEnabledRef.current) {
        playerRef.current?.setPostMixTrackGains?.(next.map((p) => p / 100));
      }
    },
    timeSignatureBranchingEnabled,
    onTimeSignatureBranchingChange: (enabled: boolean) => {
      const nextMode: TimeSignatureBranchMode =
        enabled &&
        timeSignatureSimilarityRestrictEnabled &&
        timeSignatureBranchMode === "overwrite"
          ? "combine"
          : timeSignatureBranchMode;
      setTimeSignatureBranchingEnabled(enabled);
      setTimeSignatureBranchMode(nextMode);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({
        timeSignatureBranching: enabled,
        timeSignatureBranchMode: nextMode,
        timeSignatureNumerator,
        timeSignatureDenominator,
        timeSignatureTrackOffsets,
      });
      rebuildGraphAndSyncViz();
      syncTuneFormFromEngine();
    },
    timeSignatureBranchMode,
    onTimeSignatureBranchModeChange: (mode: TimeSignatureBranchMode) => {
      const normalized = normalizeTimeSignatureBranchMode(mode);
      setTimeSignatureBranchMode(normalized);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({ timeSignatureBranchMode: normalized });
      if (timeSignatureBranchingEnabled) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
    },
    timeSignatureNumerator,
    onTimeSignatureNumeratorChange: (numerator: number) => {
      const clamped = clampTimeSignatureNumerator(numerator);
      setTimeSignatureNumerator(clamped);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({ timeSignatureNumerator: clamped });
      if (timeSignatureBranchingEnabled) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
    },
    timeSignatureDenominator,
    onTimeSignatureDenominatorChange: (denominator: number) => {
      const clamped = clampTimeSignatureDenominator(denominator);
      setTimeSignatureDenominator(clamped);
      if (!multiTrackEnabledRef.current) {
        return;
      }
      engineRef.current?.updateConfig({ timeSignatureDenominator: clamped });
      if (timeSignatureBranchingEnabled) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
    },
    timeSignatureTrackOffsets,
    onTimeSignatureTrackOffsetChange: (trackIndex: number, offset: number) => {
      const clamped = clampTimeSignatureTrackOffset(offset);
      const next = timeSignatureTrackOffsets.slice();
      while (next.length <= trackIndex) {
        next.push(0);
      }
      next[trackIndex] = clamped;
      setTimeSignatureTrackOffsets(next);
      if (trackIndex === 0) {
        setBpmBarBeatOffset(clamped);
      }
      const targetId = multiTrackEnabledRef.current
        ? cachedMixSourcesRef.current?.[trackIndex]?.fingerprint
        : fingerprintRef.current;
      storeBpmBarBeatOffsetForTrack(targetId, clamped);
      engineRef.current?.updateConfig({ timeSignatureTrackOffsets: next });
      if (
        timeSignatureSimilarityRestrictEnabled ||
        (multiTrackEnabledRef.current && timeSignatureBranchingEnabled)
      ) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
      persistCurrentTuning();
    },
    timeSignatureSimilarityRestrictEnabled,
    onTimeSignatureSimilarityRestrictChange: (enabled: boolean) => {
      const nextMode: TimeSignatureBranchMode =
        enabled &&
        timeSignatureBranchingEnabled &&
        timeSignatureBranchMode === "overwrite"
          ? "combine"
          : timeSignatureBranchMode;
      const clampedBpmOffset = clampTimeSignatureTrackOffset(bpmBarBeatOffset);
      let nextOffsets = timeSignatureTrackOffsets;
      let nextNum = timeSignatureSimilarityNumerator;
      let nextDen = timeSignatureSimilarityDenominator;

      if (enabled) {
        if (!multiTrackEnabledRef.current) {
          nextOffsets = clampedBpmOffset !== 0 ? [clampedBpmOffset] : [];
          if (bpmBarTimeSignatureMode === "custom") {
            nextNum = clampTimeSignatureNumerator(bpmBarNumerator);
            nextDen = clampTimeSignatureDenominator(bpmBarDenominator);
          } else {
            storeBpmBarNumerator(nextNum);
            storeBpmBarDenominator(nextDen);
          }
          setBpmBarNumerator(nextNum);
          setBpmBarDenominator(nextDen);
        } else if (
          timeSignatureTrackOffsets.length === 0 &&
          clampedBpmOffset !== 0
        ) {
          nextOffsets = [clampedBpmOffset];
        }
      }

      setTimeSignatureSimilarityRestrictEnabled(enabled);
      setTimeSignatureBranchMode(nextMode);
      setTimeSignatureTrackOffsets(nextOffsets);
      setTimeSignatureSimilarityNumerator(nextNum);
      setTimeSignatureSimilarityDenominator(nextDen);
      engineRef.current?.updateConfig({
        timeSignatureSimilarityRestrict: enabled,
        timeSignatureSimilarityNumerator: nextNum,
        timeSignatureSimilarityDenominator: nextDen,
        timeSignatureTrackOffsets: nextOffsets,
        ...(multiTrackEnabledRef.current && timeSignatureBranchingEnabled
          ? { timeSignatureBranchMode: nextMode }
          : {}),
      });
      rebuildGraphAndSyncViz();
      syncTuneFormFromEngine();
      persistCurrentTuning();
    },
    timeSignatureSimilarityNumerator,
    onTimeSignatureSimilarityNumeratorChange: (numerator: number) => {
      const clamped = clampTimeSignatureNumerator(numerator);
      setTimeSignatureSimilarityNumerator(clamped);
      if (!multiTrackEnabledRef.current) {
        storeBpmBarNumerator(clamped);
        setBpmBarNumerator(clamped);
      }
      engineRef.current?.updateConfig({
        timeSignatureSimilarityNumerator: clamped,
      });
      const isOverwrite =
        multiTrackEnabledRef.current &&
        timeSignatureBranchingEnabled &&
        timeSignatureBranchMode === "overwrite";
      if (timeSignatureSimilarityRestrictEnabled && !isOverwrite) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
      persistCurrentTuning();
    },
    timeSignatureSimilarityDenominator,
    onTimeSignatureSimilarityDenominatorChange: (denominator: number) => {
      const clamped = clampTimeSignatureDenominator(denominator);
      setTimeSignatureSimilarityDenominator(clamped);
      if (!multiTrackEnabledRef.current) {
        storeBpmBarDenominator(clamped);
        setBpmBarDenominator(clamped);
      }
      engineRef.current?.updateConfig({
        timeSignatureSimilarityDenominator: clamped,
      });
      const isOverwrite =
        multiTrackEnabledRef.current &&
        timeSignatureBranchingEnabled &&
        timeSignatureBranchMode === "overwrite";
      if (timeSignatureSimilarityRestrictEnabled && !isOverwrite) {
        rebuildGraphAndSyncViz();
        syncTuneFormFromEngine();
      }
      persistCurrentTuning();
    },
  };

  const visualsTuningProps = {
    visualPreferences,
    onVisualPreferencesChange: (patch: Partial<VisualPreferences>) => {
      const next = { ...visualPreferences, ...patch };
      storeVisualPreferences(patch);
      setVisualPreferences(next);
      vizControllerRef.current?.setVisualPreferences?.(next);
    },
    bpmBarEnabled,
    onBpmBarEnabledChange: (enabled: boolean) => {
      storeBpmBarEnabled(enabled);
      setBpmBarEnabled(enabled);
      if (!enabled) {
        setMetronomeEnabled(false);
        metronomeOverlayRef.current?.disable();
      }
    },
    metronomeEnabled,
    onMetronomeEnabledChange: (enabled: boolean) => {
      const nextEnabled = bpmBarEnabled && enabled;
      if (nextEnabled && bpmBarTimeSignatureMode === "off") {
        storeBpmBarTimeSignatureMode("auto");
        setBpmBarTimeSignatureMode("auto");
      }
      setMetronomeEnabled(nextEnabled);
      if (nextEnabled) {
        metronomeOverlayRef.current?.enable();
      } else {
        metronomeOverlayRef.current?.disable();
      }
    },
    metronomeVolumePct,
    onMetronomeVolumeChange: (volumePct: number) => {
      const clamped = clampMetronomeVolumePct(volumePct);
      setMetronomeVolumePct(clamped);
      metronomeOverlayRef.current?.setMetronomeVolumePct(clamped);
    },
    bpmBarStyle,
    onBpmBarStyleChange: (style: BpmBarStyle) => {
      const normalized = normalizeBpmBarStyle(style);
      storeBpmBarStyle(normalized);
      setBpmBarStyle(normalized);
    },
    bpmBarTimeSignatureMode,
    onBpmBarTimeSignatureModeChange: (mode: BpmBarTimeSignatureMode) => {
      const normalized = normalizeBpmBarTimeSignatureMode(mode);
      storeBpmBarTimeSignatureMode(normalized);
      setBpmBarTimeSignatureMode(normalized);
    },
    bpmBarNumerator,
    onBpmBarNumeratorChange: (numerator: number) => {
      const clamped = clampTimeSignatureNumerator(numerator);
      storeBpmBarNumerator(clamped);
      setBpmBarNumerator(clamped);
      if (!multiTrackEnabledRef.current) {
        setTimeSignatureSimilarityNumerator(clamped);
        engineRef.current?.updateConfig({
          timeSignatureSimilarityNumerator: clamped,
        });
        if (timeSignatureSimilarityRestrictEnabled) {
          rebuildGraphAndSyncViz();
          syncTuneFormFromEngine();
        }
        persistCurrentTuning();
      }
    },
    bpmBarDenominator,
    onBpmBarDenominatorChange: (denominator: number) => {
      const clamped = clampTimeSignatureDenominator(denominator);
      storeBpmBarDenominator(clamped);
      setBpmBarDenominator(clamped);
      if (!multiTrackEnabledRef.current) {
        setTimeSignatureSimilarityDenominator(clamped);
        engineRef.current?.updateConfig({
          timeSignatureSimilarityDenominator: clamped,
        });
        if (timeSignatureSimilarityRestrictEnabled) {
          rebuildGraphAndSyncViz();
          syncTuneFormFromEngine();
        }
        persistCurrentTuning();
      }
    },
    bpmBarBeatOffset,
    onBpmBarBeatOffsetChange: (offset: number) => {
      multiTuningProps.onTimeSignatureTrackOffsetChange(0, offset);
    },
    branchLookaheadEnabled,
    onBranchLookaheadEnabledChange: (enabled: boolean) => {
      storeBranchLookaheadEnabled(enabled);
      branchLookaheadEnabledRef.current = enabled;
      setBranchLookaheadEnabled(enabled);
      syncPredictedJumps();
    },
    branchLookaheadCount,
    onBranchLookaheadCountChange: (count: number) => {
      const clamped = clampBranchLookaheadCount(count);
      storeBranchLookaheadCount(clamped);
      branchLookaheadCountRef.current = clamped;
      setBranchLookaheadCount(clamped);
      syncPredictedJumps();
    },
  };

  const songSyncTuningProps = {
    tracks: songSyncTracks,
    masterTrackIndex: songSyncMasterTrackIndex,
    tempoSyncEnabled: songSyncTempoSyncEnabled,
    normalizeVolumeEnabled: songSyncNormalizeVolumeEnabled,
    onMasterTrackChange: onSongSyncMasterTrackChange,
    onTempoSyncChange: onSongSyncTempoSyncChange,
    onNormalizeVolumeChange: onSongSyncNormalizeVolumeChange,
    onTrackGainChange: onSongSyncTrackGainChange,
    onTrackPanChange: onSongSyncTrackPanChange,
    onTrackMutedChange: onSongSyncTrackMutedChange,
    onTrackSoloChange: onSongSyncTrackSoloChange,
    onTrackBeatOffsetChange: onSongSyncTrackBeatOffsetChange,
  };

  if (!file) {
    return (
      <>
        <section className="panel panel--center">
          <p>{t("listen.noFile")}</p>
          <Link className="tab-btn" to="/">{t("listen.goBack")}</Link>
        </section>
        {settingsModal}
      </>
    );
  }

  const activeMixEnabled =
    playMode === "autocanonizer" ? autocanonizerMixEnabled : multiTrackEnabled;
  const trackDurationSeconds =
    mixDurationOverrideSec ?? analysis?.track?.duration ?? 0;

  return (
    <>
      <section className="listen-page">
      <StatusPanel
        shown={loading.shown}
        onFinished={loading.done}
      />

      {error ? <div className="error">{error}</div> : null}

      {showPlaybackUi ? (
        <PlayMenu
          playTitleRef={playTitleRef}
          playMode={playMode}
          bringItHomeMode={bringItHomeMode}
          hasAnalysis={Boolean(analysis)}
          isExporting={isExporting}
          onOpenTuning={() => openTuningModalTab("tuning")}
          onOpenInfo={() => setIsInfoOpen(true)}
          onOpenExport={openExport}
        />
      ) : null}

      <div id="viz-panel" ref={vizPanelRef} hidden={!showPlaybackUi}>
        <div id="jukebox-viz" className={`viz ${VIZ_CLASS_NAMES[playMode]}`}>
          {branchStats ? (
            <BranchStatsPopup
              stats={branchStats}
              deleteDisabled={Boolean(selectedEdge?.deleted)}
              onDelete={deleteSelectedBranch}
            />
          ) : null}
          {customAnchor.edit && anchorBeats ? (
            <CustomAnchorInfo edit={customAnchor.edit} beats={anchorBeats} labels={anchorLabels} />
          ) : null}
          {customAnchor.edit && anchorBeats ? (
            <div className="viz-top">
              <CustomAnchorToolbar
                edit={customAnchor.edit}
                beats={anchorBeats}
                labels={anchorLabels}
                onSelectEnd={customAnchor.selectEnd}
                onSnap={customAnchor.snap}
                onReset={customAnchor.reset}
                onDone={customAnchor.exit}
              />
            </div>
          ) : (
            <VizTop
              playMode={playMode}
              onPlayModeChange={onSetPlayMode}
              activeVizIndex={activeVizIndex}
              vizCount={vizCount}
              onActiveVizChange={onSetActiveViz}
              finishOutSong={finishOutSong}
              onFinishOutSongChange={setFinishOutSong}
              loopTrack={loopTrack}
              onLoopTrackChange={setLoopTrack}
              canMix={Boolean(analysis)}
              activeMixEnabled={activeMixEnabled}
              autocanonizerMixEnabled={autocanonizerMixEnabled}
              autocanonizerMixAlignment={autocanonizerMixAlignment}
              autocanonizerQuadMode={autocanonizerQuadMode}
              autocanonizerQuadBranchMode={autocanonizerQuadBranchMode}
              autocanonizerTrioMode={autocanonizerSingleVoiceCount === 3}
              autocanonizerSingleVoiceCount={autocanonizerSingleVoiceCount}
              onToggleMix={onToggleMix}
              onSwapAutocanonizerMix={onSwapAutocanonizerMix}
              onSetAutocanonizerSingleVoiceCount={(count) => {
                setAutocanonizerSingleVoiceCount(count);
                autocanonizerRef.current?.setSingleSongVoiceCount?.(count);
              }}
              onToggleAutocanonizerTrio={() => {
                const next: AutocanonizerSingleVoiceCount =
                  autocanonizerSingleVoiceCount === 3 ? 2 : 3;
                setAutocanonizerSingleVoiceCount(next);
                autocanonizerRef.current?.setSingleSongVoiceCount?.(next);
              }}
              onToggleAutocanonizerQuad={() => {
                const next = !autocanonizerQuadMode;
                setAutocanonizerQuadMode(next);
                if (autocanonizerMixEnabledRef.current) {
                  autocanonizerRef.current?.setQuadMode?.(next);
                }
              }}
              onAutocanonizerQuadBranchModeChange={(mode) => {
                setAutocanonizerQuadBranchMode(mode);
                if (
                  autocanonizerMixEnabledRef.current &&
                  autocanonizerQuadMode
                ) {
                  autocanonizerRef.current?.setQuadBranchMode?.(mode);
                }
              }}
              onAutocanonizerMixAlignmentChange={(mode) => {
                setAutocanonizerMixAlignment(mode);
                if (autocanonizerMixEnabledRef.current) {
                  autocanonizerRef.current?.setDualAlignmentMode?.(mode);
                }
              }}
              action={
                customAnchorEnabled && playMode === "jukebox" ? (
                  <CustomAnchorButton
                    labels={anchorLabels}
                    disabled={!analysis}
                    onStart={startCustomAnchorEdit}
                  />
                ) : null
              }
            />
          )}
          {forceBranchActive || freezeBeatActive ? (
            <div className="modifier-badges" role="status" aria-live="polite">
              {forceBranchActive ? (
                <span className="modifier-badge">
                  {t("listen.forceBranchBadge")}
                </span>
              ) : null}
              {freezeBeatActive ? (
                <span className="modifier-badge">
                  {t("listen.freezeBeatBadge")}
                </span>
              ) : null}
            </div>
          ) : null}
          <div id="viz-layer" className="viz-layer" ref={vizLayerRef} />
          <div id="canonizer-layer" className="canonizer-layer" ref={canonizerLayerRef} />
          <div id="songsync-layer" className="songsync-layer" ref={songSyncLayerRef} />
          <div id="wubmachine-layer" className="wubmachine-layer" ref={wubMachineLayerRef} />
          <div className="viz-bottom" id="viz-stats" ref={vizStatsRef}>
            {bpmBarEnabled && isSmoothStyle ? (
              <div
                id="bpm-bar-smooth"
                className={
                  isPaused ? "bpm-bar-smooth is-paused" : "bpm-bar-smooth"
                }
                aria-hidden="true"
              >
                <span
                  id="bpm-bar-smooth-fill"
                  ref={smoothFillRef}
                  className="bpm-bar-smooth-fill"
                />
                {showSegmentOverlay ? renderBpmBarSegments(true) : null}
                {segmentCount !== null && segmentCount >= 2 ? (
                  <div
                    id="bpm-bar-smooth-ticks"
                    className="bpm-bar-smooth-ticks"
                  >
                    {Array.from({ length: segmentCount - 1 }, (_, idx) => (
                      <span
                        key={idx}
                        data-bpm-tick={idx + 1}
                        className="bpm-bar-smooth-tick"
                        style={{
                          left: `${((idx + 1) / segmentCount) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : bpmBarEnabled && segmentCount !== null ? (
              renderBpmBarSegments(false)
            ) : null}
            <div className="viz-bottom-left">
              <button
                id="viz-play"
                className="play-toggle viz-play-toggle"
                type="button"
                onClick={togglePlayback}
                disabled={!analysis || preparingMode !== null}
                title={playControlLabel}
                aria-label={playControlLabel}
              >
                <SymbolIcon
                  className="play-icon"
                  name={playIcon}
                />
              </button>
              <VizInfo
                vizTitleRef={vizTitleRef}
                playMode={playMode}
                counters={counters}
                wubMachineDurationSeconds={wubMachineDurationSeconds}
                trackDurationSeconds={trackDurationSeconds}
                beatsLabel={beatsLabel}
                bringItHomeMode={bringItHomeMode}
                forceBranchActive={forceBranchActive}
                isQuadMix={autocanonizerMixEnabled && autocanonizerQuadMode}
                isTrioSingle={
                  !autocanonizerMixEnabled &&
                  autocanonizerSingleVoiceCount === 3
                }
                singleVoiceCount={
                  autocanonizerMixEnabled ? 2 : autocanonizerSingleVoiceCount
                }
                autocanonizerOtherDurationSeconds={
                  autocanonizerOtherDurationSec
                }
                songSyncTrackTimes={songSyncTrackTimes}
              />
            </div>
            <div className="viz-bottom-right">
              {mixQueue.length > 0 ? (
                <button
                  id="playlist-open"
                  className="playlist-control playlist-open-control"
                  type="button"
                  aria-label={t("mixQueue.openTitle", {
                    count: mixQueue.length,
                  })}
                  title={t("mixQueue.openTitle", { count: mixQueue.length })}
                  onClick={() => setIsQueueOpen(true)}
                >
                  <svg
                    className="playlist-control-svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                  </svg>
                </button>
              ) : null}
              {playMode === "autocanonizer" ? (
                <PanPopover
                  isOpen={isPanOpen}
                  panelRef={panPanelRef}
                  buttonRef={panButtonRef}
                  mainPan={autocanonizerMainPan}
                  otherPan={autocanonizerOtherPan}
                  pinkPan={autocanonizerPinkPan}
                  goldPan={autocanonizerGoldPan}
                  mainGainPct={autocanonizerMainGainPct}
                  otherGainPct={autocanonizerOtherGainPct}
                  pinkGainPct={autocanonizerPinkGainPct}
                  goldGainPct={autocanonizerGoldGainPct}
                  isDualMix={autocanonizerMixEnabled}
                  isQuadMix={autocanonizerQuadMode}
                  isTrioMode={autocanonizerSingleVoiceCount === 3}
                  singleVoiceCount={
                    autocanonizerMixEnabled ? 2 : autocanonizerSingleVoiceCount
                  }
                  mixTrackTitles={autocanonizerMixTrackTitles}
                  onPanChange={onAutocanonizerStreamPanChange}
                  onQuadPanChange={onAutocanonizerQuadPanChange}
                  onGainChange={onAutocanonizerStreamGainChange}
                  onQuadGainChange={onAutocanonizerQuadGainChange}
                  onResetBalance={onResetAutocanonizerBalance}
                  onToggle={togglePan}
                />
              ) : null}
              {playMode === "songsync" && songSyncTracks.length > 0 ? (
                <SongSyncMixerPopover
                  isOpen={isPanOpen}
                  panelRef={panPanelRef}
                  buttonRef={panButtonRef}
                  tracks={songSyncTracks}
                  onPanChange={onSongSyncTrackPanChange}
                  onGainChange={onSongSyncTrackGainChange}
                  onMutedChange={onSongSyncTrackMutedChange}
                  onBeatOffsetChange={onSongSyncTrackBeatOffsetChange}
                  onToggle={togglePan}
                />
              ) : null}
              <VolumePopover
                isOpen={isVolumeOpen}
                panelRef={volumePanelRef}
                buttonRef={volumeButtonRef}
                volume={tuneForm.volume}
                onVolumeChange={onVolumeChange}
                onToggle={toggleVolume}
              />
              <button
                id="fullscreen"
                className="fullscreen-toggle"
                type="button"
                onClick={onToggleFullscreen}
                title={
                  isFullscreen
                    ? t("listen.exitFullscreen")
                    : t("listen.fullscreen")
                }
                aria-label={
                  isFullscreen
                    ? t("listen.exitFullscreen")
                    : t("listen.fullscreen")
                }
              >
                <SymbolIcon className="fullscreen-icon" name={isFullscreen ? "fullscreen_exit" : "fullscreen"} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {isTuningOpen ? (
        <TuningModal
          open={isTuningOpen}
          playMode={playMode}
          tuneForm={tuneForm}
          onTuneFormChange={handleTuneFormChange}
          extrasForm={extrasForm}
          onExtrasFormChange={handleExtrasFormChange}
          multi={multiTuningProps}
          visuals={visualsTuningProps}
          detectedBeatsPerBar={detectedBeatsPerBar}
          songSync={songSyncTuningProps}
          onClose={() => setIsTuningOpen(false)}
          showReset={showTuningReset}
          onReset={handleResetTuningAndExtras}
        />
      ) : null}

      {isExportOpen ? (
        <ExportModal
          form={exportForm}
          setForm={setExportForm}
          isExporting={isExporting}
          progress={exportProgress}
          error={exportError}
          onClose={closeExport}
          onExport={handleExportJukeboxAudio}
          playMode={playMode}
          remixDurationSeconds={
            playMode === "autocanonizer"
              ? (autocanonizerRef.current?.planRender()?.durationSeconds ?? 0)
              : wubMachineDurationSeconds
          }
        />
      ) : null}

      {isInfoOpen ? (
        <InfoModal
          trackDurationSeconds={trackDurationSeconds}
          totalBeats={totalBeats}
          totalBranches={totalBranches}
          deletedBranches={deletedBranches}
          onClose={() => setIsInfoOpen(false)}
        />
      ) : null}

      <MixQueueModal
        open={isQueueOpen}
        tracks={mixQueue}
        activeIndex={activeQueueIndex}
        playMode={playMode}
        isMixActive={activeMixEnabled}
        onSelectIndex={(index) => {
          selectMixQueueIndex?.(index);
        }}
        onMoveItem={(fromIndex, toIndex) => {
          moveMixQueueItem?.(fromIndex, toIndex);
        }}
        onRemoveItem={(index) => {
          removeFromMixQueue?.(index);
        }}
        onAddFiles={(entries: AudioFileEntry[]) => {
          addFilesToMixQueue?.(entries);
        }}
        onClear={() => {
          clearMixQueue?.();
        }}
        onToggleMix={onToggleMix}
        onClose={() => setIsQueueOpen(false)}
      />

      <ShortcutToastStack queue={shortcutToastQueue} />
      </section>
      {settingsModal}
    </>
  );
}
