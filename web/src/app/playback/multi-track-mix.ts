import {
  computeTempoSyncRatio,
  mergeTrackAnalyses,
  type TrackAnalysis,
} from "@forever-jukebox/shared";
import { combineAudioBuffers } from "@forever-jukebox/shared/audio/multiTrackBuffer";
import {
  isAnalysisComplete,
  isAnalysisFailed,
  isAnalysisInProgress,
} from "../analysisStatus";
import {
  fetchAnalysis,
  fetchAudio,
  fetchJobBySource,
  startYoutubeAnalysis,
  type AnalysisComplete,
  type AnalysisResponse,
} from "../api";
import { readCachedTrack, updateCachedTrack } from "../cache";
import { ANALYSIS_POLL_INTERVAL_MS } from "../constants";
import type { AppContext } from "../context";
import { formatErrorForDisplay } from "../errorDisplay";
import i18n from "../i18n";
import { isLikelyJobId } from "../identity";
import { TRACK_STEP } from "../job-progress";
import type { PlaylistTrack } from "../playlist";
import { getPlaybackDeps } from "../runtime";
import { useAppStore } from "../store";
import { PENDING_STEP, setAnalysisStatus, setLoadingStep, showToast } from "../ui";
import {
  bumpLoadGeneration,
  getLoadGeneration,
  isStaleLoad,
} from "./load-generation";
import { updateTrackInfo, updateVizVisibility } from "./status-ui";
import { delay, loadTrackById, loadTrackByJobId } from "./track-load";
import { stopPlayback } from "./transport";

const MAX_MIX_TRACKS = 128;

type LoadedMixTrackSource = {
  track: PlaylistTrack;
  analysisResult: AnalysisComplete["result"];
  buffer: AudioBuffer;
  tempo?: number;
};

let cachedMixSources: LoadedMixTrackSource[] | null = null;

export function clearCachedMultiTrackSources(): void {
  cachedMixSources = null;
}

async function resolveTrackAnalysis(
  track: PlaylistTrack,
  generation: number,
): Promise<AnalysisComplete> {
  let response: AnalysisResponse | null = null;
  if (track.sourceType === "upload" || isLikelyJobId(track.id)) {
    response = await fetchAnalysis(track.id);
  } else {
    response = await fetchJobBySource(track.sourceType, track.id);
    if (!response && track.sourceType === "youtube") {
      response = await startYoutubeAnalysis({
        youtube_id: track.id,
        title: track.title,
        artist: track.artist,
      });
    }
  }

  while (response && isAnalysisInProgress(response)) {
    if (isStaleLoad(generation)) {
      throw new Error("Load cancelled");
    }
    await delay(ANALYSIS_POLL_INTERVAL_MS);
    if (isStaleLoad(generation)) {
      throw new Error("Load cancelled");
    }
    response = await fetchAnalysis(response.id);
  }

  if (!response) {
    throw new Error(`Track analysis unavailable for ${track.title || track.id}`);
  }
  if (isAnalysisFailed(response)) {
    throw new Error(
      formatErrorForDisplay(response.error, {
        sourceProvider: response.source_provider,
        errorCode: response.error_code,
        fallback: i18n.t("status.loadingFailed"),
      }),
    );
  }
  if (!isAnalysisComplete(response)) {
    throw new Error(`Track analysis incomplete for ${track.title || track.id}`);
  }
  return response;
}

async function resolveTrackAudioBuffer(
  context: AppContext,
  track: PlaylistTrack,
  jobId: string,
): Promise<AudioBuffer> {
  const cacheCandidates = [jobId, track.id];
  let audioBytes: ArrayBuffer | null = null;
  for (const cacheKey of cacheCandidates) {
    try {
      const cached = await readCachedTrack(cacheKey);
      if (cached?.audio) {
        audioBytes = cached.audio;
        break;
      }
    } catch {
      // Ignore cache lookup errors and fall back to network fetch.
    }
  }
  if (!audioBytes) {
    audioBytes = await fetchAudio(jobId);
    updateCachedTrack(jobId, { audio: audioBytes, jobId }).catch((err) => {
      console.warn(`Cache save failed: ${String(err)}`);
    });
  }
  return context.player.getContext().decodeAudioData(audioBytes.slice(0));
}

function applyLoadedMixSources(
  context: AppContext,
  sources: LoadedMixTrackSource[],
): void {
  const {
    crossTrackOnly,
    tempoSyncEnabled,
    normalizeVolumeEnabled,
    mixTrackGainsPct,
  } = useAppStore.getState();
  const masterTempo = sources[0]?.tempo;

  const tempoRatios = sources.map((source, index) =>
    index === 0
      ? 1
      : computeTempoSyncRatio(masterTempo, source.tempo, tempoSyncEnabled),
  );
  const resolvedGainsPct = sources.map((_, index) =>
    Math.max(50, Math.min(150, mixTrackGainsPct[index] ?? 100)),
  );

  const combined = combineAudioBuffers(
    context.player.getContext(),
    sources.map((source, index) => ({
      buffer: source.buffer,
      tempoRatio: tempoRatios[index],
      gain: resolvedGainsPct[index] / 100,
    })),
    { normalizeVolume: normalizeVolumeEnabled },
  );

  const mergedAnalysis: TrackAnalysis = mergeTrackAnalyses(
    sources.map((source, index) => ({
      analysis: source.analysisResult,
      durationSec: combined.sliceDurations[index],
      title: source.track.title,
      artist: source.track.artist,
      tempoRatio: tempoRatios[index],
      gain: resolvedGainsPct[index] / 100,
    })),
    {
      tempoSync: tempoSyncEnabled,
      normalizeLoudness: normalizeVolumeEnabled,
    },
  );

  context.player.loadBuffer(combined.buffer);
  context.engine.updateConfig({ crossTrackOnly });
  context.engine.loadAnalysis(mergedAnalysis);

  const vizData = context.engine.getVisualizationData();
  useAppStore.setState({
    vizData,
    selectedEdge: null,
    branchStats: null,
    multiTrackEnabled: true,
    mixTrackGainsPct: resolvedGainsPct,
    audioLoaded: true,
    analysisLoaded: true,
    audioLoadInFlight: false,
    loadingStep: null,
    trackTitle: sources
      .map((s) => s.track.title || i18n.t("common.untitled"))
      .join(" × "),
    trackArtist: "",
    jukeboxCurrentSeconds: 0,
    trackDurationSec:
      mergedAnalysis.tracks?.[0]?.duration ??
      mergedAnalysis.track?.duration ??
      combined.buffer.duration,
  });

  if (vizData) {
    context.jukebox?.setData(vizData);
  }
  context.jukebox?.setSelectedEdge(null);
  updateVizVisibility();
  updateTrackInfo(context);
}

/**
 * Loads up to 4 tracks from the active playlist, combines their audio buffers
 * (with optional tempo sync), and starts a multi-track cross-branching session.
 */
export async function loadMultiTrackMix(context: AppContext): Promise<boolean> {
  const { playlist, playMode } = useAppStore.getState();
  if (playMode !== "jukebox" || playlist.tracks.length < 2) {
    return false;
  }

  const tracks = playlist.tracks.slice(0, MAX_MIX_TRACKS);
  stopPlayback(context);
  bumpLoadGeneration();
  const generation = getLoadGeneration();

  useAppStore.setState({
    audioLoaded: false,
    analysisLoaded: false,
    audioModePreparing: false,
    selectedEdge: null,
    branchStats: null,
    multiTrackEnabled: true,
  });
  setLoadingStep(context, PENDING_STEP);

  try {
    const sources: LoadedMixTrackSource[] = [];
    for (const track of tracks) {
      if (isStaleLoad(generation)) {
        return false;
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
      const rawTrackMeta =
        complete.result.track ?? complete.track;
      const tempo =
        typeof rawTrackMeta?.tempo === "number" && Number.isFinite(rawTrackMeta.tempo)
          ? rawTrackMeta.tempo
          : undefined;
      sources.push({
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

    cachedMixSources = sources;
    applyLoadedMixSources(context, sources);
    return true;
  } catch (err) {
    if (!isStaleLoad(generation)) {
      cachedMixSources = null;
      useAppStore.setState({ multiTrackEnabled: false });
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
 * Exits multi-track mix mode and restores single-track playback for the active
 * playlist item.
 */
export async function disableMultiTrackMix(
  context: AppContext,
): Promise<boolean> {
  cachedMixSources = null;
  stopPlayback(context);
  useAppStore.setState({ multiTrackEnabled: false });
  context.engine.updateConfig({ crossTrackOnly: false, crossTrackThreshold: 0 });

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

/**
 * Updates whether branches are restricted to cross-song jumps in multi-track mode.
 */
export function setCrossTrackOnly(
  context: AppContext,
  enabled: boolean,
): void {
  useAppStore.setState({ crossTrackOnly: enabled });
  if (!useAppStore.getState().multiTrackEnabled) {
    return;
  }
  context.engine.updateConfig({ crossTrackOnly: enabled });
  context.engine.rebuildGraph();
  const vizData = context.engine.getVisualizationData();
  useAppStore.setState({ vizData, selectedEdge: null, branchStats: null });
  if (vizData) {
    context.jukebox?.setData(vizData);
  }
  context.jukebox?.setSelectedEdge(null);
  updateTrackInfo(context);
}

function reapplyMixFromCacheOrReload(context: AppContext): void {
  if (!useAppStore.getState().multiTrackEnabled) {
    return;
  }
  if (cachedMixSources && cachedMixSources.length >= 2) {
    stopPlayback(context);
    applyLoadedMixSources(context, cachedMixSources);
    return;
  }
  void loadMultiTrackMix(context);
}

/**
 * Updates whether secondary songs in a multi-track mix are time-scaled to the
 * master song's BPM, re-applying the mix immediately when cached sources exist.
 */
export function setTempoSyncEnabled(
  context: AppContext,
  enabled: boolean,
): void {
  useAppStore.setState({ tempoSyncEnabled: enabled });
  reapplyMixFromCacheOrReload(context);
}

/**
 * Toggles automatic RMS audio normalization and analysis loudness alignment for
 * multi-track mixes, re-rendering immediately when a mix is active.
 */
export function setNormalizeVolumeEnabled(
  context: AppContext,
  enabled: boolean,
): void {
  useAppStore.setState({ normalizeVolumeEnabled: enabled });
  reapplyMixFromCacheOrReload(context);
}

/**
 * Sets an individual track's premix volume trim percentage (50–150%) and
 * re-renders an active multi-track mix immediately.
 */
export function setMixTrackGainPct(
  context: AppContext,
  trackIndex: number,
  gainPct: number,
): void {
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    return;
  }
  const clamped = Math.max(50, Math.min(150, Math.round(gainPct)));
  const current = useAppStore.getState().mixTrackGainsPct;
  const next = current.slice();
  while (next.length <= trackIndex) {
    next.push(100);
  }
  next[trackIndex] = clamped;
  useAppStore.setState({ mixTrackGainsPct: next });
  reapplyMixFromCacheOrReload(context);
}
