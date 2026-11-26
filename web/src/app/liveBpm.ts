import { getAudioModeSettings } from "@forever-jukebox/shared/audio/audioModes";
import type { JukeboxAudioMode } from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import type { QuantumBase } from "@forever-jukebox/shared/types";

export type BpmTrend = "up" | "down" | null;

export interface BpmBeatSample {
  duration: number;
  trackIndex?: number;
  prev?: BpmBeatSample | null;
  next?: BpmBeatSample | null;
}

export interface BpmTrackerState {
  currentBpm: number | null;
  referenceBpm: number | null;
  trend: BpmTrend;
  beatsSinceChange: number;
}

/**
 * Minimum BPM shift (strictly greater than 10 BPM) required to display a
 * tempo-change arrow and highlight.
 */
export const BPM_CHANGE_THRESHOLD = 10;

/**
 * Number of stable beats before a detected tempo-change arrow clears.
 */
export const BPM_CHANGE_HOLD_BEATS = 6;

/**
 * Fallback timeout in milliseconds to clear a tempo-change arrow when playback
 * pauses or beat updates stop arriving.
 */
export const BPM_CHANGE_CLEAR_TIMEOUT_MS = 3500;

/**
 * Exponential smoothing factor applied to the settled reference BPM so gradual
 * tempo drifts still trigger a change if they accumulate past 10 BPM.
 */
export const BPM_REFERENCE_DRIFT_ALPHA = 0.05;

/**
 * Lower bound for valid beat duration in seconds (1200 BPM).
 */
export const MIN_VALID_BEAT_DURATION_SEC = 0.05;

/**
 * Upper bound for valid beat duration in seconds (15 BPM).
 */
export const MAX_VALID_BEAT_DURATION_SEC = 4.0;

/**
 * Computes the median of a non-empty array of finite numbers.
 */
function computeMedian(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Converts a beat duration into BPM when it falls within sane musical bounds.
 */
function beatDurationToBpm(duration: unknown): number | null {
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < MIN_VALID_BEAT_DURATION_SEC ||
    duration > MAX_VALID_BEAT_DURATION_SEC
  ) {
    return null;
  }
  return 60 / duration;
}

/**
 * Resolves the baseline track BPM from `track.tempo`, falling back to the
 * median beat duration when explicit tempo metadata is missing or invalid.
 */
export function resolveTrackBaseTempoBpm(
  trackTempo?: number | null,
  beats?: readonly Pick<QuantumBase, "duration">[] | null,
): number | null {
  if (
    typeof trackTempo === "number" &&
    Number.isFinite(trackTempo) &&
    trackTempo > 0
  ) {
    return trackTempo;
  }
  if (!beats || beats.length === 0) {
    return null;
  }
  const bpms: number[] = [];
  for (const beat of beats) {
    const bpm = beatDurationToBpm(beat.duration);
    if (bpm !== null) {
      bpms.push(bpm);
    }
  }
  return computeMedian(bpms);
}

/**
 * Resolves a smoothed local BPM around the active beat using a centered 5-beat
 * median window constrained to the same `trackIndex` in multi-track mixes.
 */
export function resolveLocalBeatBpm(
  beat: BpmBeatSample | null | undefined,
  beats?: readonly BpmBeatSample[] | null,
  beatIndex?: number | null,
): number | null {
  if (!beat) {
    return null;
  }
  const targetTrackIndex = beat.trackIndex;
  const matchesTrack = (candidate: BpmBeatSample | null | undefined): boolean =>
    Boolean(
      candidate &&
        (targetTrackIndex === undefined ||
          candidate.trackIndex === undefined ||
          candidate.trackIndex === targetTrackIndex),
    );

  const windowSamples: BpmBeatSample[] = [];
  if (
    beats &&
    typeof beatIndex === "number" &&
    Number.isInteger(beatIndex) &&
    beatIndex >= 0 &&
    beatIndex < beats.length
  ) {
    // Prefer direct array indexing when the caller provides the beat list.
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = beats[beatIndex + offset];
      if (matchesTrack(candidate)) {
        windowSamples.push(candidate);
      }
    }
  } else {
    // Fall back to linked-list traversal for controllers (e.g., Autocanonizer)
    // that pass individual beat nodes.
    windowSamples.push(beat);
    let cursor: BpmBeatSample | null | undefined = beat.prev;
    for (let step = 0; step < 2 && cursor; step += 1) {
      if (matchesTrack(cursor)) {
        windowSamples.push(cursor);
      } else {
        break;
      }
      cursor = cursor.prev;
    }
    cursor = beat.next;
    for (let step = 0; step < 2 && cursor; step += 1) {
      if (matchesTrack(cursor)) {
        windowSamples.push(cursor);
      } else {
        break;
      }
      cursor = cursor.next;
    }
  }

  const bpms: number[] = [];
  for (const sample of windowSamples) {
    const bpm = beatDurationToBpm(sample.duration);
    if (bpm !== null) {
      bpms.push(bpm);
    }
  }
  return computeMedian(bpms);
}

/**
 * Resolves the effective playback speed multiplier applied to the audio stream
 * (accounting for Nightcore/Daycore/Vaporwave in jukebox mode).
 */
export function resolveEffectivePlaybackRate(
  playMode: PlayMode,
  jukeboxAudioMode: JukeboxAudioMode,
  audioIntensity: number,
  playerRate?: number | null,
): number {
  if (playMode !== "jukebox") {
    return 1;
  }
  if (
    typeof playerRate === "number" &&
    Number.isFinite(playerRate) &&
    playerRate > 0
  ) {
    return playerRate;
  }
  return getAudioModeSettings(jukeboxAudioMode, audioIntensity).rate;
}

/**
 * Creates an initial BPM tracker state seeded with an optional baseline BPM.
 */
export function createBpmTrackerState(
  initialBpm?: number | null,
): BpmTrackerState {
  const rounded =
    typeof initialBpm === "number" &&
    Number.isFinite(initialBpm) &&
    initialBpm > 0
      ? Math.round(initialBpm)
      : null;
  return {
    currentBpm: rounded,
    referenceBpm: rounded,
    trend: null,
    beatsSinceChange: 0,
  };
}

/**
 * Advances the BPM tracker for a new effective BPM reading, flagging `"up"` or
 * `"down"` when the tempo shifts by strictly more than 10 BPM and clearing the
 * indicator after `BPM_CHANGE_HOLD_BEATS` settled beats.
 */
export function stepBpmTracker(
  state: BpmTrackerState,
  rawBpm: number | null,
  options?: { advanceBeat?: boolean },
): BpmTrackerState {
  const advanceBeat = options?.advanceBeat ?? true;
  if (rawBpm === null || !Number.isFinite(rawBpm) || rawBpm <= 0) {
    return state;
  }
  const nextBpm = Math.round(rawBpm);
  if (state.referenceBpm === null) {
    // Seed the initial reference without emitting an arrow on the first reading.
    return {
      currentBpm: nextBpm,
      referenceBpm: nextBpm,
      trend: null,
      beatsSinceChange: 0,
    };
  }

  const delta = nextBpm - state.referenceBpm;
  if (delta > BPM_CHANGE_THRESHOLD) {
    return {
      currentBpm: nextBpm,
      referenceBpm: nextBpm,
      trend: "up",
      beatsSinceChange: 0,
    };
  }
  if (delta < -BPM_CHANGE_THRESHOLD) {
    return {
      currentBpm: nextBpm,
      referenceBpm: nextBpm,
      trend: "down",
      beatsSinceChange: 0,
    };
  }

  if (state.trend !== null) {
    const nextBeats = advanceBeat
      ? state.beatsSinceChange + 1
      : state.beatsSinceChange;
    if (nextBeats >= BPM_CHANGE_HOLD_BEATS) {
      // Tempo has held steady within +-10 BPM; settle the new reference.
      return {
        currentBpm: nextBpm,
        referenceBpm: nextBpm,
        trend: null,
        beatsSinceChange: 0,
      };
    }
    return {
      currentBpm: nextBpm,
      referenceBpm: state.referenceBpm,
      trend: state.trend,
      beatsSinceChange: nextBeats,
    };
  }

  // Gently follow small fluctuations so gradual ramps past 10 BPM still register
  // while minor quantization wobble stays muted.
  const nextRef = advanceBeat
    ? state.referenceBpm + (nextBpm - state.referenceBpm) * BPM_REFERENCE_DRIFT_ALPHA
    : state.referenceBpm;
  return {
    currentBpm: nextBpm,
    referenceBpm: nextRef,
    trend: null,
    beatsSinceChange: 0,
  };
}

/**
 * Clears an active BPM trend arrow while preserving the current BPM as the new
 * baseline reference.
 */
export function clearBpmTrackerTrend(state: BpmTrackerState): BpmTrackerState {
  return {
    currentBpm: state.currentBpm,
    referenceBpm: state.currentBpm ?? state.referenceBpm,
    trend: null,
    beatsSinceChange: 0,
  };
}

/**
 * Formats a numeric BPM value for display, returning `"--"` when unavailable.
 */
export function formatBpmText(bpm: number | null): string {
  return bpm !== null && Number.isFinite(bpm) && bpm > 0
    ? String(Math.round(bpm))
    : "--";
}
