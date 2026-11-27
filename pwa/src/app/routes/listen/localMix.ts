import {
  clampTimeSignatureTrackOffset,
  computeTempoSyncRatio,
  mergeTrackAnalyses,
  type TrackAnalysis,
} from "@forever-jukebox/shared";
import {
  combineAudioBuffers,
  prepareDualAudioBuffers,
  prepareMultiAudioBuffers,
  type CombinedAudioResult,
  type DualAudioBufferResult,
  type MultiAudioBufferResult,
} from "@forever-jukebox/shared/audio/multiTrackBuffer";
import {
  AnalyzeAudioUseCase,
  type AnalyzeProgress,
} from "@/core/application/usecases/analyzeAudio";
import { AnalysisWorkerClient } from "@/core/infrastructure/analysis/AnalysisWorkerClient";
import { AudioDecoder } from "@/core/infrastructure/audio/AudioDecoder";
import {
  createAnalysisCache,
  trimRenderedTracks,
} from "@/core/infrastructure/cache/analysisCache";
import {
  readFileFromHandle,
  setFileHandle,
} from "@/core/infrastructure/cache/fileHandleStore";
import type { AnalysisOutput } from "@/shared/analysis-schema/schema";
import type { LocalMixTrack } from "@/app/state/mixQueue";
import { resolveTrackBaseTempoBpm } from "./liveBpm";

export const MAX_MIX_TRACKS = 128;
export const MAX_AUTOCANONIZER_MIX_TRACKS = 2;

export const MIN_MIX_TRACK_GAIN_PCT = 0;
export const MAX_MIX_TRACK_GAIN_PCT = 200;
export const DEFAULT_MIX_TRACK_GAIN_PCT = 100;

export type LoadedLocalMixSource = {
  id: string;
  fingerprint: string;
  title: string;
  artist?: string;
  analysis: AnalysisOutput;
  audioBuffer: AudioBuffer;
  tempo?: number;
  file: File;
  fileHandle: FileSystemFileHandle | null;
};

/**
 * Clamps a per-track volume percentage to [0, 200], defaulting non-finite
 * values to 100%.
 */
export function clampMixTrackGainPct(gainPct: number): number {
  if (!Number.isFinite(gainPct)) {
    return DEFAULT_MIX_TRACK_GAIN_PCT;
  }
  return Math.max(
    MIN_MIX_TRACK_GAIN_PCT,
    Math.min(MAX_MIX_TRACK_GAIN_PCT, Math.round(gainPct)),
  );
}

/**
 * Resolves a readable File for a queued mix track (re-reading from its stored
 * FileSystemFileHandle when needed) and runs or retrieves cached analysis +
 * decoded AudioBuffer via AnalyzeAudioUseCase.
 */
export async function resolveLocalMixSources(
  tracks: readonly LocalMixTrack[],
  audioContext: AudioContext,
  options?: {
    onTrackProgress?: (
      trackIndex: number,
      total: number,
      progress: AnalyzeProgress,
    ) => void;
    isCancelled?: () => boolean;
  },
): Promise<LoadedLocalMixSource[]> {
  const analysisPort = new AnalysisWorkerClient();
  const cache = createAnalysisCache();
  const decoder = new AudioDecoder(audioContext);
  const usecase = new AnalyzeAudioUseCase(analysisPort, cache, decoder);

  const sources: LoadedLocalMixSource[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    if (options?.isCancelled?.()) {
      throw new Error("Mix load cancelled");
    }
    const track = tracks[index];
    let resolvedFile = track.file;
    if (!resolvedFile && track.fileHandle) {
      resolvedFile = await readFileFromHandle(track.fileHandle);
    }
    if (!resolvedFile) {
      throw new Error(`Missing audio file for "${track.title}"`);
    }

    const result = await usecase.execute({
      file: resolvedFile,
      onProgress: (progress) => {
        options?.onTrackProgress?.(index, tracks.length, progress);
      },
    });
    if (options?.isCancelled?.()) {
      throw new Error("Mix load cancelled");
    }

    trimRenderedTracks(result.fingerprint).catch((err: unknown) => {
      console.warn(`Rendered track trim failed: ${String(err)}`);
    });
    if (track.fileHandle) {
      setFileHandle(result.fingerprint, track.fileHandle).catch(
        (err: unknown) => {
          console.warn(`File handle save failed: ${String(err)}`);
        },
      );
    }

    const rawTitle = result.analysis.track?.title?.trim();
    const resolvedTitle = rawTitle || track.title;
    const resolvedArtist = result.analysis.track?.artist ?? track.artist;
    const tempo = resolveTrackBaseTempoBpm(
      result.analysis.track?.tempo,
      result.analysis.beats,
    );

    sources.push({
      id: track.id,
      fingerprint: result.fingerprint,
      title: resolvedTitle,
      artist: resolvedArtist,
      analysis: result.analysis,
      audioBuffer: result.audioBuffer,
      tempo: tempo ?? undefined,
      file: resolvedFile,
      fileHandle: track.fileHandle,
    });
  }
  return sources;
}

export type BuiltJukeboxMix = {
  combined: CombinedAudioResult;
  mergedAnalysis: TrackAnalysis;
  resolvedGainsPct: number[];
  resolvedTrackOffsets: number[];
};

/**
 * Combines decoded AudioBuffers and merges track analyses for a multi-track
 * Jukebox mix session.
 */
export function buildJukeboxMix(
  audioContext: BaseAudioContext,
  sources: readonly LoadedLocalMixSource[],
  options: {
    tempoSyncEnabled: boolean;
    normalizeVolumeEnabled: boolean;
    mixTrackGainsPct: readonly number[];
    timeSignatureTrackOffsets: readonly number[];
  },
): BuiltJukeboxMix {
  const masterTempo = sources[0]?.tempo;
  const tempoRatios = sources.map((source, index) =>
    index === 0
      ? 1
      : computeTempoSyncRatio(masterTempo, source.tempo, options.tempoSyncEnabled),
  );
  const resolvedGainsPct = sources.map((_, index) =>
    clampMixTrackGainPct(
      options.mixTrackGainsPct[index] ?? DEFAULT_MIX_TRACK_GAIN_PCT,
    ),
  );
  const resolvedTrackOffsets = sources.map((_, index) =>
    clampTimeSignatureTrackOffset(
      options.timeSignatureTrackOffsets[index] ?? 0,
    ),
  );

  const combined = combineAudioBuffers(
    audioContext,
    sources.map((source, index) => ({
      buffer: source.audioBuffer,
      tempoRatio: tempoRatios[index],
    })),
    { normalizeVolume: options.normalizeVolumeEnabled },
  );

  const mergedAnalysis = mergeTrackAnalyses(
    sources.map((source, index) => ({
      analysis: source.analysis,
      durationSec: combined.sliceDurations[index],
      title: source.title,
      artist: source.artist,
      tempoRatio: tempoRatios[index],
    })),
    {
      tempoSync: options.tempoSyncEnabled,
      normalizeLoudness: options.normalizeVolumeEnabled,
    },
  );

  return {
    combined,
    mergedAnalysis,
    resolvedGainsPct,
    resolvedTrackOffsets,
  };
}

export type BuiltAutocanonizerMix = {
  prepared: DualAudioBufferResult;
  otherTempoRatio: number;
};

/**
 * Resamples and normalizes two local audio sources for dual/quad Autocanonizer
 * mix playback.
 */
export function buildAutocanonizerMix(
  audioContext: BaseAudioContext,
  mainSource: LoadedLocalMixSource,
  otherSource: LoadedLocalMixSource,
): BuiltAutocanonizerMix {
  const otherTempoRatio = computeTempoSyncRatio(
    mainSource.tempo,
    otherSource.tempo,
    true,
  );
  const prepared = prepareDualAudioBuffers(
    audioContext,
    mainSource.audioBuffer,
    otherSource.audioBuffer,
    {
      tempoRatio: otherTempoRatio,
      normalizeVolume: true,
    },
  );
  return {
    prepared,
    otherTempoRatio,
  };
}

export type BuiltSongSyncMix = {
  prepared: MultiAudioBufferResult;
  tempoRatios: number[];
  masterTempo?: number;
};

/**
 * Resamples and normalizes local audio sources for simultaneous Song Sync playback
 * aligned to the chosen master track tempo.
 */
export function buildSongSyncMix(
  audioContext: BaseAudioContext,
  sources: readonly LoadedLocalMixSource[],
  options: {
    tempoSyncEnabled: boolean;
    normalizeVolumeEnabled: boolean;
    masterTrackIndex?: number;
  },
): BuiltSongSyncMix {
  const safeMasterIdx = Math.max(
    0,
    Math.min(sources.length - 1, options.masterTrackIndex ?? 0),
  );
  const masterTempo = sources[safeMasterIdx]?.tempo;
  const tempoRatios = sources.map((source, index) =>
    index === safeMasterIdx
      ? 1
      : computeTempoSyncRatio(
          masterTempo,
          source.tempo,
          options.tempoSyncEnabled,
        ),
  );
  const prepared = prepareMultiAudioBuffers(
    audioContext,
    sources.map((source, index) => ({
      buffer: source.audioBuffer,
      tempoRatio: tempoRatios[index],
    })),
    { normalizeVolume: options.normalizeVolumeEnabled },
  );
  return {
    prepared,
    tempoRatios,
    masterTempo,
  };
}
