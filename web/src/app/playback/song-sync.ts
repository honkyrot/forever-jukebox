import {
  computeTempoSyncRatio,
  clampTimeSignatureTrackOffset,
  normalizeAnalysis,
} from "@forever-jukebox/shared";
import { prepareMultiAudioBuffers } from "@forever-jukebox/shared/audio/multiTrackBuffer";
import { detectTrackBeatsPerBar } from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import { SONG_SYNC_TRACK_COLORS } from "@forever-jukebox/shared/songsync/SongSyncViz";
import type { AppContext } from "../context";
import { formatErrorForDisplay } from "../errorDisplay";
import i18n from "../i18n";
import { TRACK_STEP } from "../job-progress";
import { resolveTrackBaseTempoBpm } from "../liveBpm";
import { resolveStoredBpmBarBeatOffsetForTrack } from "../bpmBarTimeSignature";
import { getPlaybackDeps } from "../runtime";
import { useAppStore } from "../store";
import {
  PENDING_STEP,
  setAnalysisStatus,
  setLoadingStep,
  showToast,
} from "../ui";
import {
  bumpLoadGeneration,
  getLoadGeneration,
  isStaleLoad,
} from "./load-generation";
import {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_MIX_TRACK_GAIN_PCT,
  MIN_MIX_TRACK_GAIN_PCT,
  resolveTrackAnalysis,
  resolveTrackAudioBuffer,
  syncMetronomeOverlayFromStore,
  type LoadedMixTrackSource,
} from "./multi-track-mix";
import {
  resetLiveBpm,
  updateTrackInfo,
  updateVizVisibility,
} from "./status-ui";
import { loadTrackById, loadTrackByJobId } from "./track-load";
import { isLikelyJobId } from "../identity";
import { playlistTrackKey } from "../playlist";
import { startSongSyncPlayback, stopPlayback } from "./transport";

export const MAX_SONG_SYNC_TRACKS = 16;

type PreservedSongSyncConfig = {
  gainPct: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  beatOffset: number;
};

let cachedSongSyncSources: LoadedMixTrackSource[] | null = null;

function clampGainPct(gainPct: number): number {
  if (!Number.isFinite(gainPct)) {
    return DEFAULT_MIX_TRACK_GAIN_PCT;
  }
  return Math.max(
    MIN_MIX_TRACK_GAIN_PCT,
    Math.min(MAX_MIX_TRACK_GAIN_PCT, Math.round(gainPct)),
  );
}

function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.round(pan)));
}

/**
 * Clears cached Song Sync decoded buffers and analysis overrides.
 */
export function clearCachedSongSyncSources(): void {
  cachedSongSyncSources = null;
}

/**
 * Returns the currently cached Song Sync track sources, if loaded.
 */
export function getCachedSongSyncSources(): LoadedMixTrackSource[] | null {
  return cachedSongSyncSources;
}

function syncSongSyncStoreFromController(context: AppContext): void {
  const controller = context.songsync;
  if (!controller) {
    return;
  }
  const meta = controller.getTrackMeta();
  const masterIdx = controller.getMasterTrackIndex();
  const masterMeta = meta[masterIdx];
  useAppStore.setState({
    songSyncMasterTrackIndex: masterIdx,
    songSyncTracks: meta.map((m) => ({
      title: m.title,
      duration: m.duration,
      tempo: m.tempo,
      gainPct: Math.round(m.gain * 100),
      pan: Math.round(m.pan * 100),
      muted: m.muted,
      solo: m.solo,
      beatOffset: m.beatOffset,
      color: m.color,
    })),
    songSyncTrackSeconds: meta.map((_, idx) => (idx === masterIdx ? 0 : null)),
    trackDurationSec: masterMeta?.duration ?? null,
    trackTitle: meta.map((m) => m.title).join(" × "),
    trackArtist: "",
  });
}

function snapshotSongSyncConfigsByKey(
  sources: readonly LoadedMixTrackSource[] | null,
): Map<string, PreservedSongSyncConfig> {
  const configs = new Map<string, PreservedSongSyncConfig>();
  if (!sources) {
    return configs;
  }
  const { songSyncTracks } = useAppStore.getState();
  sources.forEach((source, idx) => {
    const uiTrack = songSyncTracks[idx];
    if (!uiTrack) {
      return;
    }
    configs.set(playlistTrackKey(source.track), {
      gainPct: uiTrack.gainPct,
      pan: uiTrack.pan,
      muted: uiTrack.muted,
      solo: uiTrack.solo,
      beatOffset: uiTrack.beatOffset,
    });
  });
  return configs;
}

function resolveDefaultMasterTrackIndex(
  sources: readonly LoadedMixTrackSource[],
): number {
  let longestIdx = 0;
  let longestDuration = -1;
  sources.forEach((source, index) => {
    const duration =
      source.analysisResult?.track?.duration ?? source.buffer.duration;
    if (duration > longestDuration) {
      longestDuration = duration;
      longestIdx = index;
    }
  });
  return longestIdx;
}

function applyLoadedSongSyncSources(
  context: AppContext,
  sources: LoadedMixTrackSource[],
  options?: {
    masterTrackIndex?: number;
    preservedConfigs?: ReadonlyMap<string, PreservedSongSyncConfig>;
  },
): void {
  const state = useAppStore.getState();
  const resolvedMasterIdx =
    options?.masterTrackIndex !== undefined &&
    options.masterTrackIndex >= 0 &&
    options.masterTrackIndex < sources.length
      ? options.masterTrackIndex
      : resolveDefaultMasterTrackIndex(sources);
  const masterTempo = sources[resolvedMasterIdx]?.tempo;
  const tempoRatios = sources.map((source, index) =>
    index === resolvedMasterIdx
      ? 1
      : computeTempoSyncRatio(
          masterTempo,
          source.tempo,
          state.songSyncTempoSyncEnabled,
        ),
  );
  const prepared = prepareMultiAudioBuffers(
    context.player.getContext(),
    sources.map((source, index) => ({
      buffer: source.buffer,
      tempoRatio: tempoRatios[index],
    })),
    { normalizeVolume: state.songSyncNormalizeVolumeEnabled },
  );

  const existingConfigs =
    options?.preservedConfigs ?? snapshotSongSyncConfigsByKey(cachedSongSyncSources);
  context.songsync?.setTracks(
    sources.map((source, index) => {
      const prev = existingConfigs.get(playlistTrackKey(source.track));
      const storedOffset = resolveStoredBpmBarBeatOffsetForTrack(
        source.jobId || source.track.id,
      );
      return {
        title: source.track.title || i18n.t("common.untitled"),
        buffer: prepared.buffers[index],
        analysis: source.analysisResult,
        durationSec: prepared.durationsSec[index],
        tempo: source.tempo,
        tempoRatio: tempoRatios[index],
        gain: (prev?.gainPct ?? DEFAULT_MIX_TRACK_GAIN_PCT) / 100,
        pan: (prev?.pan ?? 0) / 100,
        muted: prev?.muted ?? false,
        solo: prev?.solo ?? false,
        beatOffset: prev?.beatOffset ?? storedOffset,
      };
    }),
    context.player.getContext(),
    { masterTrackIndex: resolvedMasterIdx, loop: state.songSyncLoop },
  );

  syncSongSyncStoreFromController(context);
  const masterIdx = context.songsync?.getMasterTrackIndex() ?? resolvedMasterIdx;
  const masterSource = sources[masterIdx] ?? sources[0];
  const masterNormalized = masterSource
    ? normalizeAnalysis(masterSource.analysisResult)
    : null;
  const detectedBeatsPerBar = detectTrackBeatsPerBar(
    masterNormalized?.beats,
    masterSource?.analysisResult?.track?.time_signature,
  );
  context.metronomeOverlay.setBeatsPerBar(detectedBeatsPerBar);
  useAppStore.setState({
    songSyncEnabled: true,
    metronomeDetectedBeatsPerBar: detectedBeatsPerBar,
    audioLoaded: true,
    analysisLoaded: true,
    audioLoadInFlight: false,
    loadingStep: null,
  });

  const baseTempo = resolveTrackBaseTempoBpm(
    masterSource?.tempo ?? masterSource?.analysisResult?.track?.tempo,
    masterNormalized?.beats,
  );
  resetLiveBpm(baseTempo);
  syncMetronomeOverlayFromStore(context);
  updateVizVisibility();
  updateTrackInfo(context);
}

/**
 * Loads playlist tracks (or the current track if fewer than 2 playlist tracks
 * exist) into Song Sync mode and prepares synchronized multi-track playback.
 */
export async function loadSongSyncMix(context: AppContext): Promise<boolean> {
  const { playlist, playMode } = useAppStore.getState();
  if (playMode !== "songsync") {
    return false;
  }

  const tracks = playlist.tracks.slice(0, MAX_SONG_SYNC_TRACKS);
  if (tracks.length < 2) {
    showToast(i18n.t("playback.songSyncNeedPlaylist"));
    return false;
  }

  const previousByKey = new Map<string, LoadedMixTrackSource>();
  for (const source of cachedSongSyncSources ?? []) {
    previousByKey.set(playlistTrackKey(source.track), source);
  }
  const preservedConfigs = snapshotSongSyncConfigsByKey(cachedSongSyncSources);

  stopPlayback(context);
  bumpLoadGeneration();
  const generation = getLoadGeneration();

  const missingTracks = tracks.some(
    (track) => !previousByKey.has(playlistTrackKey(track)),
  );
  useAppStore.setState({
    audioLoaded: missingTracks ? false : true,
    analysisLoaded: missingTracks ? false : true,
    audioModePreparing: false,
    songSyncEnabled: true,
  });
  if (missingTracks) {
    setLoadingStep(context, PENDING_STEP);
  }

  try {
    const sources: LoadedMixTrackSource[] = [];
    for (const track of tracks) {
      if (isStaleLoad(generation)) {
        return false;
      }
      const reused = previousByKey.get(playlistTrackKey(track));
      if (reused) {
        sources.push(reused);
        continue;
      }
      setLoadingStep(context, TRACK_STEP);
      const complete = await resolveTrackAnalysis(track, generation);
      if (isStaleLoad(generation)) {
        return false;
      }
      const buffer = await resolveTrackAudioBuffer(context, track, complete.id);
      if (isStaleLoad(generation)) {
        return false;
      }
      const rawTrackMeta = complete.result.track ?? complete.track;
      const tempo =
        typeof rawTrackMeta?.tempo === "number" &&
        Number.isFinite(rawTrackMeta.tempo)
          ? rawTrackMeta.tempo
          : undefined;
      sources.push({
        jobId: complete.id,
        track: {
          ...track,
          title:
            typeof rawTrackMeta?.title === "string" && rawTrackMeta.title.trim()
              ? rawTrackMeta.title
              : track.title,
          artist:
            typeof rawTrackMeta?.artist === "string"
              ? rawTrackMeta.artist
              : track.artist,
        },
        analysisResult: complete.result,
        buffer,
        tempo,
      });
    }

    if (isStaleLoad(generation)) {
      return false;
    }

    cachedSongSyncSources = sources;
    useAppStore.setState({
      songSyncTracks: sources.map((source, idx) => {
        const prev = preservedConfigs.get(playlistTrackKey(source.track));
        return {
          title: source.track.title || `Track ${idx + 1}`,
          duration: source.buffer.duration,
          tempo: source.tempo,
          gainPct: prev?.gainPct ?? DEFAULT_MIX_TRACK_GAIN_PCT,
          pan: prev?.pan ?? 0,
          muted: prev?.muted ?? false,
          solo: prev?.solo ?? false,
          beatOffset:
            prev?.beatOffset ??
            resolveStoredBpmBarBeatOffsetForTrack(
              source.jobId || source.track.id,
            ),
          color: SONG_SYNC_TRACK_COLORS[idx % SONG_SYNC_TRACK_COLORS.length],
        };
      }),
    });
    applyLoadedSongSyncSources(context, sources, { preservedConfigs });
    return true;
  } catch (err) {
    if (!isStaleLoad(generation)) {
      cachedSongSyncSources = null;
      useAppStore.setState({ songSyncEnabled: false });
      const message = formatErrorForDisplay(err, {
        fallback: i18n.t("status.loadingFailed"),
      });
      setAnalysisStatus(context, () => message);
      showToast(message, { tone: "error" });
    }
    return false;
  }
}

/**
 * Exits Song Sync mode and restores single-track playback for the active playlist item.
 */
export async function disableSongSyncMix(
  context: AppContext,
): Promise<boolean> {
  clearCachedSongSyncSources();
  stopPlayback(context);
  context.songsync?.reset();
  useAppStore.setState({
    songSyncEnabled: false,
    songSyncTracks: [],
    songSyncTrackSeconds: [],
    songSyncMasterTrackIndex: 0,
  });

  const { playlist } = useAppStore.getState();
  const activeTrack =
    playlist.tracks[playlist.currentIndex] ?? playlist.tracks[0];
  const deps = getPlaybackDeps();
  if (!activeTrack || !deps) {
    return false;
  }

  if (activeTrack.sourceType === "upload" || isLikelyJobId(activeTrack.id)) {
    return loadTrackByJobId(context, deps, activeTrack.id, {
      playlistLoad: true,
      selectedTrack: activeTrack,
    });
  }
  const trackId =
    activeTrack.sourceType === "youtube"
      ? activeTrack.id
      : `${activeTrack.sourceType}:${activeTrack.id}`;
  return loadTrackById(context, deps, trackId, {
    playlistLoad: true,
    selectedTrack: activeTrack,
  });
}

function reapplySongSyncFromCache(
  context: AppContext,
  masterTrackIndex?: number,
): void {
  if (!cachedSongSyncSources || !useAppStore.getState().songSyncEnabled) {
    return;
  }
  const wasRunning = useAppStore.getState().isRunning;
  const resolvedMasterIdx =
    masterTrackIndex ??
    context.songsync?.getMasterTrackIndex() ??
    useAppStore.getState().songSyncMasterTrackIndex;
  const preservedConfigs = snapshotSongSyncConfigsByKey(cachedSongSyncSources);
  stopPlayback(context);
  applyLoadedSongSyncSources(context, cachedSongSyncSources, {
    masterTrackIndex: resolvedMasterIdx,
    preservedConfigs,
  });
  if (wasRunning) {
    startSongSyncPlayback(context, 0, { resetSession: true });
  }
}

export function setSongSyncTrackGainPct(
  context: AppContext,
  trackIndex: number,
  gainPct: number,
): void {
  const clamped = clampGainPct(gainPct);
  context.songsync?.setTrackConfig(trackIndex, { gain: clamped / 100 });
  useAppStore.setState((state) => ({
    songSyncTracks: state.songSyncTracks.map((t, i) =>
      i === trackIndex ? { ...t, gainPct: clamped } : t,
    ),
  }));
}

export function setSongSyncTrackPan(
  context: AppContext,
  trackIndex: number,
  panPct: number,
): void {
  const clamped = clampPan(panPct);
  context.songsync?.setTrackConfig(trackIndex, { pan: clamped / 100 });
  useAppStore.setState((state) => ({
    songSyncTracks: state.songSyncTracks.map((t, i) =>
      i === trackIndex ? { ...t, pan: clamped } : t,
    ),
  }));
}

export function setSongSyncTrackMuted(
  context: AppContext,
  trackIndex: number,
  muted: boolean,
): void {
  context.songsync?.setTrackConfig(trackIndex, { muted });
  useAppStore.setState((state) => ({
    songSyncTracks: state.songSyncTracks.map((t, i) =>
      i === trackIndex ? { ...t, muted } : t,
    ),
  }));
}

export function setSongSyncTrackSolo(
  context: AppContext,
  trackIndex: number,
  solo: boolean,
): void {
  context.songsync?.setTrackConfig(trackIndex, { solo });
  useAppStore.setState((state) => ({
    songSyncTracks: state.songSyncTracks.map((t, i) =>
      i === trackIndex ? { ...t, solo } : t,
    ),
  }));
}

export function setSongSyncTrackBeatOffset(
  context: AppContext,
  trackIndex: number,
  offset: number,
): void {
  const clamped = clampTimeSignatureTrackOffset(offset);
  context.songsync?.setTrackConfig(trackIndex, { beatOffset: clamped });
  useAppStore.setState((state) => ({
    songSyncTracks: state.songSyncTracks.map((t, i) =>
      i === trackIndex ? { ...t, beatOffset: clamped } : t,
    ),
  }));
}

export function setSongSyncMasterTrack(
  context: AppContext,
  trackIndex: number,
): void {
  if (cachedSongSyncSources && useAppStore.getState().songSyncEnabled) {
    if (trackIndex < 0 || trackIndex >= cachedSongSyncSources.length) {
      return;
    }
    reapplySongSyncFromCache(context, trackIndex);
    return;
  }
  context.songsync?.setMasterTrackIndex(trackIndex);
  syncSongSyncStoreFromController(context);
}

export function setSongSyncLoop(context: AppContext, enabled: boolean): void {
  useAppStore.setState({ songSyncLoop: enabled });
  context.songsync?.setLoop(enabled);
}

export function setSongSyncTempoSync(
  context: AppContext,
  enabled: boolean,
): void {
  useAppStore.setState({ songSyncTempoSyncEnabled: enabled });
  reapplySongSyncFromCache(context);
}

export function setSongSyncNormalizeVolume(
  context: AppContext,
  enabled: boolean,
): void {
  useAppStore.setState({ songSyncNormalizeVolumeEnabled: enabled });
  reapplySongSyncFromCache(context);
}
