// Barrel preserving the original playback.ts public surface; the
// implementation now lives in per-domain modules.
export {
  addSleepTimerListener,
  isSleepTimerActive,
  setSleepTimer,
  SLEEP_TIMER_OPTIONS,
  type SleepTimerOption,
} from "./sleep-timer";
export {
  closeInfo,
  closeTuning,
  openExtras,
  openInfo,
  openTuning,
  setAutocanonizerStreamPans,
  setMasterVolume,
  syncVolumeUI,
  updateListenTimeDisplay,
  updateTrackInfo,
  updateVizVisibility,
  type TuningModalTab,
} from "./status-ui";
export {
  isPlaybackBlockedForAudioMode,
  startAutocanonizerPlayback,
  startWubMachinePlayback,
  startJukeboxFromBeat,
  startListenTimer,
  stopListenTimer,
  stopPlayback,
  togglePlayback,
} from "./transport";
export {
  applyExtrasChanges,
  applyTuningChanges,
  changedTuningControls,
  getExtrasFormValues,
  getTuningFormValues,
  hasNonDefaultTuning,
  resetExtrasDefaults,
  resetTuningDefaults,
  syncDeletedEdgeState,
  type ExtrasApplyResult,
  type ExtrasFormValues,
  type TuningFormValues,
} from "./tuning-forms";
export {
  applyAnalysisResult,
  cancelPoll,
  delay,
  loadAudioFromJob,
  loadTrackById,
  loadTrackByJobId,
  pollAnalysis,
  resetForNewTrack,
  tryLoadCachedAudio,
  type PlaybackDeps,
  type TrackLoadOptions,
} from "./track-load";
export {
  bumpLoadGeneration,
  getLoadGeneration,
  isStaleLoad,
} from "./load-generation";
export {
  cancelWubMachineRender,
  maybePrepareWubMachine,
} from "./wubmachine";
export { releaseWakeLock, requestWakeLock } from "./wake-lock";
export {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_MIX_TRACK_GAIN_PCT,
  MIN_MIX_TRACK_GAIN_PCT,
  clearCachedMultiTrackSources,
  disableMultiTrackMix,
  loadMultiTrackMix,
  setCoverSyncEnabled,
  setCrossTrackOnly,
  setMixTrackGainPct,
  setNormalizeVolumeEnabled,
  setPostMixNormalizeVolumeEnabled,
  setTempoSyncEnabled,
} from "./multi-track-mix";
