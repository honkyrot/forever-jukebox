import { normalizeAnalysis } from "./analysis";
import type {
  QuantumBase,
  Segment,
  TrackAnalysis,
  TrackSliceMeta,
} from "./types";

export interface MultiTrackEntry {
  analysis: unknown;
  durationSec?: number;
  title?: string;
  artist?: string;
  tempoRatio?: number;
  gain?: number;
}

export interface MergeTrackOptions {
  tempoSync?: boolean;
  normalizeLoudness?: boolean;
}

const MIN_TEMPO_SYNC_RATIO = 0.5;
const MAX_TEMPO_SYNC_RATIO = 2.0;

/**
 * Computes the playback-rate multiplier needed to align a track's BPM with
 * the master track, folding halftime/double-time differences into [sqrt(0.5), sqrt(2)].
 */
export function computeTempoSyncRatio(
  masterTempo?: number,
  trackTempo?: number,
  enabled = true,
): number {
  if (
    !enabled ||
    typeof masterTempo !== "number" ||
    typeof trackTempo !== "number" ||
    !Number.isFinite(masterTempo) ||
    !Number.isFinite(trackTempo) ||
    masterTempo <= 0 ||
    trackTempo <= 0
  ) {
    return 1;
  }

  let ratio = masterTempo / trackTempo;
  // Fold octave-multiple tempos (halftime / double-time) into a natural band
  // around 1.0 before clamping so remixes don't jump by 2x speed.
  while (ratio > Math.SQRT2) {
    ratio /= 2;
  }
  while (ratio < Math.SQRT1_2) {
    ratio *= 2;
  }
  return Math.max(MIN_TEMPO_SYNC_RATIO, Math.min(MAX_TEMPO_SYNC_RATIO, ratio));
}

function linkGlobalTimeline(list: QuantumBase[]) {
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    item.which = i;
    item.prev = i > 0 ? list[i - 1] : null;
    item.next = i < list.length - 1 ? list[i + 1] : null;
  }
}

function resolveNormalizedDuration(analysis: TrackAnalysis): number {
  const trackDuration = analysis.track?.duration;
  if (typeof trackDuration === "number" && Number.isFinite(trackDuration) && trackDuration > 0) {
    return trackDuration;
  }
  const lastBeat = analysis.beats[analysis.beats.length - 1];
  const beatEnd = lastBeat ? lastBeat.start + lastBeat.duration : 0;
  const lastSegment = analysis.segments[analysis.segments.length - 1];
  const segmentEnd = lastSegment ? lastSegment.start + lastSegment.duration : 0;
  return Math.max(beatEnd, segmentEnd);
}

function scaleAndOffsetQuanta(
  list: QuantumBase[],
  trackIndex: number,
  timeScale: number,
  startTimeOffset: number,
  includeTrackBeatCount: boolean,
) {
  const count = list.length;
  for (let i = 0; i < count; i += 1) {
    const q = list[i];
    q.start = startTimeOffset + q.start * timeScale;
    q.duration = q.duration * timeScale;
    q.trackIndex = trackIndex;
    q.localWhich = i;
    if (includeTrackBeatCount) {
      q.trackBeatCount = count;
    }
  }
}

/**
 * Averages finite segment peak loudness values for cross-track loudness alignment.
 */
function computeMeanLoudnessMax(segments: Segment[]): number | null {
  let sum = 0;
  let count = 0;
  for (const seg of segments) {
    if (Number.isFinite(seg.loudness_max)) {
      sum += seg.loudness_max;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function scaleAndOffsetSegments(
  segments: Segment[],
  timeScale: number,
  startTimeOffset: number,
  loudnessDelta = 0,
) {
  for (const seg of segments) {
    seg.start = startTimeOffset + seg.start * timeScale;
    seg.duration = seg.duration * timeScale;
    seg.loudness_max_time = seg.loudness_max_time * timeScale;
    if (loudnessDelta !== 0) {
      seg.loudness_start += loudnessDelta;
      seg.loudness_max += loudnessDelta;
    }
  }
}

/**
 * Normalizes and merges multiple song analyses onto a single contiguous timeline
 * while preserving per-track provenance (`trackIndex`, `localWhich`, `tracks`).
 */
export function mergeTrackAnalyses(
  entries: MultiTrackEntry[],
  options?: MergeTrackOptions,
): TrackAnalysis {
  if (entries.length === 0) {
    return {
      sections: [],
      bars: [],
      beats: [],
      tatums: [],
      segments: [],
      tracks: [],
    };
  }

  const tempoSync = options?.tempoSync ?? true;
  const normalizeLoudness = options?.normalizeLoudness ?? false;
  const normalizedEntries = entries.map((entry) => ({
    entry,
    analysis: normalizeAnalysis(entry.analysis),
  }));
  const masterTempo = normalizedEntries[0].analysis.track?.tempo;
  const masterLoudness = computeMeanLoudnessMax(
    normalizedEntries[0].analysis.segments,
  );

  const sections: QuantumBase[] = [];
  const bars: QuantumBase[] = [];
  const beats: QuantumBase[] = [];
  const tatums: QuantumBase[] = [];
  const segments: Segment[] = [];
  const tracks: TrackSliceMeta[] = [];

  let cumulativeOffset = 0;

  for (let trackIndex = 0; trackIndex < normalizedEntries.length; trackIndex += 1) {
    const { entry, analysis } = normalizedEntries[trackIndex];
    const trackTempo = analysis.track?.tempo;
    const rawRatio =
      entry.tempoRatio !== undefined
        ? entry.tempoRatio
        : trackIndex === 0
          ? 1
          : computeTempoSyncRatio(masterTempo, trackTempo, tempoSync);
    const tempoRatio =
      Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 1;
    const timeScale = 1 / tempoRatio;

    let autoLoudnessDelta = 0;
    if (normalizeLoudness && trackIndex > 0 && masterLoudness !== null) {
      const trackLoudness = computeMeanLoudnessMax(analysis.segments);
      if (trackLoudness !== null) {
        autoLoudnessDelta = Math.max(
          -24,
          Math.min(24, masterLoudness - trackLoudness),
        );
      }
    }
    const gainDb =
      entry.gain !== undefined &&
      Number.isFinite(entry.gain) &&
      entry.gain > 0 &&
      entry.gain !== 1
        ? 20 * Math.log10(entry.gain)
        : 0;
    const loudnessDelta = autoLoudnessDelta + gainDb;

    const startTimeOffset = cumulativeOffset;
    const startBeatIndex = beats.length;
    const beatCount = analysis.beats.length;
    const rawDuration = resolveNormalizedDuration(analysis);

    // Scale and offset each track's quanta/segments in place before concatenating
    // so existing parent/children and overlappingSegments references stay valid.
    scaleAndOffsetQuanta(analysis.sections, trackIndex, timeScale, startTimeOffset, false);
    scaleAndOffsetQuanta(analysis.bars, trackIndex, timeScale, startTimeOffset, false);
    scaleAndOffsetQuanta(analysis.beats, trackIndex, timeScale, startTimeOffset, true);
    scaleAndOffsetQuanta(analysis.tatums, trackIndex, timeScale, startTimeOffset, false);
    scaleAndOffsetSegments(
      analysis.segments,
      timeScale,
      startTimeOffset,
      loudnessDelta,
    );

    sections.push(...analysis.sections);
    bars.push(...analysis.bars);
    beats.push(...analysis.beats);
    tatums.push(...analysis.tatums);
    segments.push(...analysis.segments);

    const scaledDuration =
      typeof entry.durationSec === "number" &&
      Number.isFinite(entry.durationSec) &&
      entry.durationSec > 0
        ? entry.durationSec
        : rawDuration * timeScale;

    tracks.push({
      trackIndex,
      title: entry.title ?? analysis.track?.title,
      artist: entry.artist ?? analysis.track?.artist,
      duration: scaledDuration,
      tempo: trackTempo,
      tempoRatio,
      startTimeOffset,
      startBeatIndex,
      beatCount,
    });

    cumulativeOffset += scaledDuration;
  }

  linkGlobalTimeline(sections);
  linkGlobalTimeline(bars);
  linkGlobalTimeline(beats);
  linkGlobalTimeline(tatums);
  for (let i = 0; i < segments.length; i += 1) {
    segments[i].which = i;
  }

  const combinedTitle = tracks
    .map((t) => t.title)
    .filter((t): t is string => Boolean(t))
    .join(" × ");

  return {
    sections,
    bars,
    beats,
    tatums,
    segments,
    track: {
      title: combinedTitle || undefined,
      duration: cumulativeOffset,
      tempo: masterTempo,
      time_signature: normalizedEntries[0].analysis.track?.time_signature,
    },
    tracks,
  };
}
