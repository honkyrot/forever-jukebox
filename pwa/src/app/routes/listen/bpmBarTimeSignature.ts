import {
  clampTimeSignatureDenominator,
  clampTimeSignatureNumerator,
  clampTimeSignatureTrackOffset,
  DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  DEFAULT_TIME_SIGNATURE_NUMERATOR,
  resolveTimeSignatureBeatPosition,
  resolveTimeSignatureBranchStepBeats,
  type QuantumBase,
  type TimeSignatureBranchMode,
} from "@forever-jukebox/shared";
import {
  DEFAULT_METRONOME_BEAT_OFFSET,
  MAX_REASONABLE_BAR_BEATS,
  isMetronomeDownbeat,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";

const BPM_BAR_MODE_STORAGE_KEY = "fj-bpm-bar-ts-mode";
const BPM_BAR_NUM_STORAGE_KEY = "fj-bpm-bar-ts-num";
const BPM_BAR_DEN_STORAGE_KEY = "fj-bpm-bar-ts-den";
const BPM_BAR_OFFSET_STORAGE_KEY = "fj-bpm-bar-ts-offset";
const BPM_BAR_STYLE_STORAGE_KEY = "fj-bpm-bar-style";

export type BpmBarTimeSignatureMode = "auto" | "off" | "custom";
export type BpmBarStyle = "pulse" | "smooth" | "smooth-pulse";

export const DEFAULT_BPM_BAR_TIME_SIGNATURE_MODE: BpmBarTimeSignatureMode =
  "auto";
export const DEFAULT_BPM_BAR_STYLE: BpmBarStyle = "pulse";
export const DEFAULT_BPM_BAR_SMOOTH_DURATION_MS = 500;
export const MIN_BPM_BAR_SMOOTH_DURATION_MS = 50;
export const MAX_BPM_BAR_SMOOTH_DURATION_MS = 8000;
export const MAX_BPM_BAR_SEGMENTS = 16;
export const MAX_STORED_BPM_BAR_OFFSETS = 500;

export type BpmBarPulseBeat = Pick<
  QuantumBase,
  "which" | "localWhich" | "trackIndex" | "indexInParent" | "parent"
> &
  Partial<Pick<QuantumBase, "start" | "duration">>;

export interface BpmBarSmoothAnimation {
  fromFraction: number;
  toFraction: number;
  durationMs: number;
  isDownbeat: boolean;
}

export interface BpmBarTimeSignatureInput {
  bpmBarTimeSignatureMode: BpmBarTimeSignatureMode;
  bpmBarNumerator: number;
  bpmBarDenominator: number;
  bpmBarBeatOffset: number;
  multiTrackEnabled: boolean;
  coverSyncEnabled: boolean;
  timeSignatureBranchingEnabled: boolean;
  timeSignatureBranchMode: TimeSignatureBranchMode;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  timeSignatureTrackOffsets: readonly number[];
  timeSignatureSimilarityRestrictEnabled: boolean;
  timeSignatureSimilarityNumerator: number;
  timeSignatureSimilarityDenominator: number;
  metronomeEnabled: boolean;
  metronomeDetectedBeatsPerBar: number;
}

export interface BpmBarSegmentState {
  segmentCount: number | null;
  activeSegmentIndex: number | null;
}

export interface EffectiveMetronomeConfig {
  beatsPerBarOverride: number | null;
  beatOffset: number;
}

/**
 * Computes a non-negative remainder modulo `modulus`.
 */
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Normalizes a persisted BPM bar time-signature mode string, defaulting to "auto".
 */
export function normalizeBpmBarTimeSignatureMode(
  raw?: string | null,
): BpmBarTimeSignatureMode {
  if (raw === "off" || raw === "custom") {
    return raw;
  }
  return DEFAULT_BPM_BAR_TIME_SIGNATURE_MODE;
}

/**
 * Reads the persisted BPM bar time-signature mode from localStorage.
 */
export function resolveStoredBpmBarTimeSignatureMode(): BpmBarTimeSignatureMode {
  if (typeof localStorage === "undefined") {
    return DEFAULT_BPM_BAR_TIME_SIGNATURE_MODE;
  }
  return normalizeBpmBarTimeSignatureMode(
    localStorage.getItem(BPM_BAR_MODE_STORAGE_KEY),
  );
}

/**
 * Persists the BPM bar time-signature mode to localStorage.
 */
export function storeBpmBarTimeSignatureMode(
  mode: BpmBarTimeSignatureMode,
): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(
    BPM_BAR_MODE_STORAGE_KEY,
    normalizeBpmBarTimeSignatureMode(mode),
  );
}

/**
 * Normalizes a persisted BPM bar style string, defaulting to "pulse".
 */
export function normalizeBpmBarStyle(raw?: string | null): BpmBarStyle {
  if (raw === "smooth" || raw === "smooth-pulse") {
    return raw;
  }
  return DEFAULT_BPM_BAR_STYLE;
}

/**
 * Returns true when the given BPM bar style renders a continuous smooth fill.
 */
export function isSmoothBpmBarStyle(style: BpmBarStyle): boolean {
  return style === "smooth" || style === "smooth-pulse";
}

/**
 * Returns true when the given BPM bar style triggers beat pulse flashes.
 */
export function isPulseBpmBarStyle(style: BpmBarStyle): boolean {
  return style === "pulse" || style === "smooth-pulse";
}

/**
 * Reads the persisted BPM bar style from localStorage.
 */
export function resolveStoredBpmBarStyle(): BpmBarStyle {
  if (typeof localStorage === "undefined") {
    return DEFAULT_BPM_BAR_STYLE;
  }
  return normalizeBpmBarStyle(localStorage.getItem(BPM_BAR_STYLE_STORAGE_KEY));
}

/**
 * Persists the BPM bar style to localStorage.
 */
export function storeBpmBarStyle(style: BpmBarStyle): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(BPM_BAR_STYLE_STORAGE_KEY, normalizeBpmBarStyle(style));
}

/**
 * Reads and clamps the persisted custom BPM bar numerator from localStorage.
 */
export function resolveStoredBpmBarNumerator(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_TIME_SIGNATURE_NUMERATOR;
  }
  const raw = localStorage.getItem(BPM_BAR_NUM_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_TIME_SIGNATURE_NUMERATOR;
  }
  return clampTimeSignatureNumerator(Number.parseInt(raw, 10));
}

/**
 * Persists the clamped custom BPM bar numerator to localStorage.
 */
export function storeBpmBarNumerator(numerator: number): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(
    BPM_BAR_NUM_STORAGE_KEY,
    String(clampTimeSignatureNumerator(numerator)),
  );
}

/**
 * Reads and clamps the persisted custom BPM bar denominator from localStorage.
 */
export function resolveStoredBpmBarDenominator(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_TIME_SIGNATURE_DENOMINATOR;
  }
  const raw = localStorage.getItem(BPM_BAR_DEN_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_TIME_SIGNATURE_DENOMINATOR;
  }
  return clampTimeSignatureDenominator(Number.parseInt(raw, 10));
}

/**
 * Persists the clamped custom BPM bar denominator to localStorage.
 */
export function storeBpmBarDenominator(denominator: number): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(
    BPM_BAR_DEN_STORAGE_KEY,
    String(clampTimeSignatureDenominator(denominator)),
  );
}

/**
 * Parses the per-song beat-offset map from localStorage, ignoring legacy
 * scalar values or malformed entries.
 */
export function readStoredBpmBarOffsetMap(): Record<string, number> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  const raw = localStorage.getItem(BPM_BAR_OFFSET_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const trimmedKey = key.trim();
      if (
        !trimmedKey ||
        typeof value !== "number" ||
        !Number.isFinite(value)
      ) {
        continue;
      }
      const clamped = clampTimeSignatureTrackOffset(value);
      if (clamped !== 0) {
        result[trimmedKey] = clamped;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Resolves the persisted beat offset for a specific track ID, defaulting to 0.
 */
export function resolveStoredBpmBarBeatOffsetForTrack(
  trackId?: string | null,
): number {
  const id = typeof trackId === "string" ? trackId.trim() : "";
  if (!id) {
    return DEFAULT_METRONOME_BEAT_OFFSET;
  }
  const map = readStoredBpmBarOffsetMap();
  return map[id] ?? DEFAULT_METRONOME_BEAT_OFFSET;
}

/**
 * Persists a clamped per-song beat offset under `fj-bpm-bar-ts-offset` (evicting
 * oldest entries past `MAX_STORED_BPM_BAR_OFFSETS` and removing zero entries).
 */
export function storeBpmBarBeatOffsetForTrack(
  trackId: string | null | undefined,
  offset: number,
): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  const id = typeof trackId === "string" ? trackId.trim() : "";
  if (!id) {
    return;
  }
  const map = readStoredBpmBarOffsetMap();
  delete map[id];
  const clamped = clampTimeSignatureTrackOffset(offset);
  if (clamped !== 0) {
    map[id] = clamped;
  }
  const keys = Object.keys(map);
  if (keys.length > MAX_STORED_BPM_BAR_OFFSETS) {
    for (let i = 0; i < keys.length - MAX_STORED_BPM_BAR_OFFSETS; i += 1) {
      delete map[keys[i]];
    }
  }
  if (Object.keys(map).length === 0) {
    localStorage.removeItem(BPM_BAR_OFFSET_STORAGE_KEY);
    return;
  }
  localStorage.setItem(BPM_BAR_OFFSET_STORAGE_KEY, JSON.stringify(map));
}

/**
 * Resolves the active time signature when auto mode tracks similarity
 * restriction or multi-track time-signature branching.
 */
function resolveAutoTimeSignature(input: BpmBarTimeSignatureInput): {
  numerator: number;
  denominator: number;
} | null {
  if (!input.multiTrackEnabled) {
    if (!input.timeSignatureSimilarityRestrictEnabled) {
      return null;
    }
    return {
      numerator: input.timeSignatureSimilarityNumerator,
      denominator: input.timeSignatureSimilarityDenominator,
    };
  }
  if (
    !input.timeSignatureBranchingEnabled &&
    !input.timeSignatureSimilarityRestrictEnabled
  ) {
    return null;
  }
  if (
    input.timeSignatureBranchingEnabled &&
    input.timeSignatureBranchMode === "overwrite"
  ) {
    return {
      numerator: input.timeSignatureNumerator,
      denominator: input.timeSignatureDenominator,
    };
  }
  if (input.timeSignatureSimilarityRestrictEnabled) {
    return {
      numerator: input.timeSignatureSimilarityNumerator,
      denominator: input.timeSignatureSimilarityDenominator,
    };
  }
  return {
    numerator: input.timeSignatureNumerator,
    denominator: input.timeSignatureDenominator,
  };
}

/**
 * Resolves the beat offset for the given beat's track in BPM-bar-driven modes
 * ("custom" or "auto" metronome), using `bpmBarBeatOffset` for track 0 and
 * `timeSignatureTrackOffsets` for secondary tracks.
 */
function resolveBpmBarBeatTrackOffset(
  input: BpmBarTimeSignatureInput,
  beat: BpmBarPulseBeat | null,
): number {
  if (beat?.trackIndex !== undefined && beat.trackIndex > 0) {
    return clampTimeSignatureTrackOffset(
      input.timeSignatureTrackOffsets[beat.trackIndex] ?? 0,
    );
  }
  return clampTimeSignatureTrackOffset(input.bpmBarBeatOffset);
}

/**
 * Resolves the beat offset for an active branching/restriction time signature,
 * falling back to the track-0 BPM bar offset when per-track offsets are unset.
 */
function resolveBeatTrackOffset(
  input: BpmBarTimeSignatureInput,
  beat: BpmBarPulseBeat | null,
): number {
  if (beat?.trackIndex !== undefined && beat.trackIndex > 0) {
    return clampTimeSignatureTrackOffset(
      input.timeSignatureTrackOffsets[beat.trackIndex] ?? 0,
    );
  }
  return clampTimeSignatureTrackOffset(
    input.timeSignatureTrackOffsets.length > 0
      ? (input.timeSignatureTrackOffsets[0] ?? input.bpmBarBeatOffset)
      : input.bpmBarBeatOffset,
  );
}

/**
 * Resolves the 0-based beat index within an active signature cycle, handling
 * multi-track Cover Sync alignment when enabled.
 */
function resolveActiveSignatureBeatPosition(
  input: BpmBarTimeSignatureInput,
  beatIndex: number,
  localIndex: number,
  beat: BpmBarPulseBeat | null,
  activeSig: { numerator: number; denominator: number },
  vizBeats?: readonly QuantumBase[] | null,
): number {
  if (
    input.multiTrackEnabled &&
    input.coverSyncEnabled &&
    beat?.trackIndex !== undefined &&
    beat.trackIndex > 0 &&
    vizBeats &&
    vizBeats.length > 0
  ) {
    const trackOffsets =
      input.timeSignatureTrackOffsets.length > 0
        ? input.timeSignatureTrackOffsets
        : [input.bpmBarBeatOffset];
    return resolveTimeSignatureBeatPosition(
      vizBeats,
      {
        which: beat.which ?? beatIndex,
        localWhich: beat.localWhich,
        trackIndex: beat.trackIndex,
      },
      {
        numerator: activeSig.numerator,
        denominator: activeSig.denominator,
        trackOffsets,
        useCoverSync: true,
      },
    );
  }
  const step = resolveTimeSignatureBranchStepBeats(
    activeSig.numerator,
    activeSig.denominator,
  );
  return positiveMod(localIndex - resolveBeatTrackOffset(input, beat), step);
}

/**
 * Resolves the effective metronome time-signature override and beat offset
 * driven by the BPM bar configuration.
 */
export function resolveEffectiveMetronomeConfig(
  input: BpmBarTimeSignatureInput,
): EffectiveMetronomeConfig {
  const beatOffset = clampTimeSignatureTrackOffset(input.bpmBarBeatOffset);
  if (input.bpmBarTimeSignatureMode === "custom") {
    return {
      beatsPerBarOverride: resolveTimeSignatureBranchStepBeats(
        input.bpmBarNumerator,
        input.bpmBarDenominator,
      ),
      beatOffset,
    };
  }
  const activeSig = resolveAutoTimeSignature(input);
  if (activeSig) {
    return {
      beatsPerBarOverride: resolveTimeSignatureBranchStepBeats(
        activeSig.numerator,
        activeSig.denominator,
      ),
      beatOffset,
    };
  }
  return {
    beatsPerBarOverride: null,
    beatOffset,
  };
}

/**
 * Resolves how many horizontal bar segments the BPM bar should split into,
 * or null when the BPM bar should flash as a single solid bar.
 */
export function resolveBpmBarSegmentCount(
  input: BpmBarTimeSignatureInput,
): number | null {
  if (input.bpmBarTimeSignatureMode === "off") {
    return null;
  }
  if (input.bpmBarTimeSignatureMode === "custom") {
    const step = resolveTimeSignatureBranchStepBeats(
      input.bpmBarNumerator,
      input.bpmBarDenominator,
    );
    return step >= 2 ? Math.min(MAX_BPM_BAR_SEGMENTS, step) : null;
  }
  const activeSig = resolveAutoTimeSignature(input);
  if (activeSig) {
    const step = resolveTimeSignatureBranchStepBeats(
      activeSig.numerator,
      activeSig.denominator,
    );
    return step >= 2 ? Math.min(MAX_BPM_BAR_SEGMENTS, step) : null;
  }
  if (input.metronomeEnabled) {
    const beatsPerBar = input.metronomeDetectedBeatsPerBar;
    if (typeof beatsPerBar === "number" && Number.isFinite(beatsPerBar)) {
      const rounded = Math.round(beatsPerBar);
      return rounded >= 2 ? Math.min(MAX_BPM_BAR_SEGMENTS, rounded) : null;
    }
  }
  return null;
}

/**
 * Resolves the BPM bar segment count and the 0-based segment index for the
 * currently pulsing beat.
 */
export function resolveBpmBarActiveSegment(
  input: BpmBarTimeSignatureInput,
  beatIndex: number | null,
  beat: BpmBarPulseBeat | null,
  vizBeats?: readonly QuantumBase[] | null,
): BpmBarSegmentState {
  const segmentCount = resolveBpmBarSegmentCount(input);
  if (segmentCount === null) {
    return { segmentCount: null, activeSegmentIndex: null };
  }
  if (beatIndex === null || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return { segmentCount, activeSegmentIndex: null };
  }

  const localIndex =
    typeof beat?.localWhich === "number" && Number.isInteger(beat.localWhich)
      ? beat.localWhich
      : beatIndex;

  if (input.bpmBarTimeSignatureMode === "custom") {
    const offset = resolveBpmBarBeatTrackOffset(input, beat);
    return {
      segmentCount,
      activeSegmentIndex: positiveMod(localIndex - offset, segmentCount),
    };
  }

  const activeSig = resolveAutoTimeSignature(input);
  if (activeSig) {
    const beatPosition = resolveActiveSignatureBeatPosition(
      input,
      beatIndex,
      localIndex,
      beat,
      activeSig,
      vizBeats,
    );
    return {
      segmentCount,
      activeSegmentIndex: beatPosition % segmentCount,
    };
  }

  if (input.metronomeEnabled) {
    const offset = resolveBpmBarBeatTrackOffset(input, beat);
    const barBeatCount = beat?.parent?.children?.length;
    const hasValidBarIndex =
      typeof beat?.indexInParent === "number" &&
      Number.isInteger(beat.indexInParent) &&
      beat.indexInParent >= 0 &&
      (barBeatCount === undefined ||
        (barBeatCount >= 1 && barBeatCount <= MAX_REASONABLE_BAR_BEATS));
    if (hasValidBarIndex) {
      const cycle = barBeatCount ?? segmentCount;
      const barPos = positiveMod((beat?.indexInParent as number) - offset, cycle);
      return {
        segmentCount,
        activeSegmentIndex: barPos % segmentCount,
      };
    }
    return {
      segmentCount,
      activeSegmentIndex: positiveMod(localIndex - offset, segmentCount),
    };
  }

  return { segmentCount, activeSegmentIndex: null };
}

/**
 * Determines whether the given beat is a bar downbeat (accented high tick)
 * under the active BPM bar time signature, per-track offset, or analyzed bars.
 */
export function isBpmBarDownbeat(
  input: BpmBarTimeSignatureInput,
  beatIndex: number | null,
  beat: BpmBarPulseBeat | null,
  vizBeats?: readonly QuantumBase[] | null,
): boolean {
  if (beatIndex === null || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return false;
  }
  const localIndex =
    typeof beat?.localWhich === "number" && Number.isInteger(beat.localWhich)
      ? beat.localWhich
      : beatIndex;

  if (input.bpmBarTimeSignatureMode === "custom") {
    const step = resolveTimeSignatureBranchStepBeats(
      input.bpmBarNumerator,
      input.bpmBarDenominator,
    );
    const offset = resolveBpmBarBeatTrackOffset(input, beat);
    return positiveMod(localIndex - offset, step) === 0;
  }

  const activeSig = resolveAutoTimeSignature(input);
  if (activeSig) {
    return (
      resolveActiveSignatureBeatPosition(
        input,
        beatIndex,
        localIndex,
        beat,
        activeSig,
        vizBeats,
      ) === 0
    );
  }

  return isMetronomeDownbeat(beatIndex, beat ?? undefined, {
    beatsPerBar: input.metronomeDetectedBeatsPerBar,
    beatsPerBarOverride: null,
    beatOffset: resolveBpmBarBeatTrackOffset(input, beat),
  });
}

/**
 * Resolves the fill start/end fractions and duration for the smooth BPM
 * progress bar across either a full measure or a single beat.
 */
export function resolveBpmBarSmoothAnimation(params: {
  segmentCount: number | null;
  activeSegmentIndex: number | null;
  beatIndex: number | null;
  beat: BpmBarPulseBeat | null;
  playbackRate?: number;
  currentTimeSec?: number | null;
}): BpmBarSmoothAnimation | null {
  const {
    segmentCount,
    activeSegmentIndex,
    beatIndex,
    beat,
    playbackRate,
    currentTimeSec,
  } = params;

  let startFraction: number;
  let endFraction: number;
  let isDownbeat: boolean;

  if (segmentCount !== null) {
    if (
      activeSegmentIndex === null ||
      activeSegmentIndex < 0 ||
      activeSegmentIndex >= segmentCount
    ) {
      return null;
    }
    startFraction = activeSegmentIndex / segmentCount;
    endFraction = (activeSegmentIndex + 1) / segmentCount;
    isDownbeat = activeSegmentIndex === 0;
  } else {
    // Skip bare session-reset pulse calls that carry neither a beat index nor beat data.
    if (beatIndex === null && beat === null) {
      return null;
    }
    startFraction = 0;
    endFraction = 1;
    isDownbeat = false;
  }

  const safeRate =
    typeof playbackRate === "number" &&
    Number.isFinite(playbackRate) &&
    playbackRate > 0
      ? playbackRate
      : 1;

  let fromFraction = startFraction;
  let durationMs = DEFAULT_BPM_BAR_SMOOTH_DURATION_MS;

  const beatDuration = beat?.duration;
  if (
    typeof beatDuration === "number" &&
    Number.isFinite(beatDuration) &&
    beatDuration > 0
  ) {
    let remainingSec = beatDuration;
    // Compensate for engine polling delay so the visual sweep lands on the next beat boundary.
    if (
      typeof currentTimeSec === "number" &&
      Number.isFinite(currentTimeSec) &&
      typeof beat?.start === "number" &&
      Number.isFinite(beat.start)
    ) {
      const elapsedSec = currentTimeSec - beat.start;
      if (elapsedSec > 0 && elapsedSec < beatDuration * 0.85) {
        const beatProgress = elapsedSec / beatDuration;
        fromFraction =
          startFraction + (endFraction - startFraction) * beatProgress;
        remainingSec = beatDuration - elapsedSec;
      }
    }
    durationMs = Math.round(
      Math.min(
        MAX_BPM_BAR_SMOOTH_DURATION_MS,
        Math.max(
          MIN_BPM_BAR_SMOOTH_DURATION_MS,
          (remainingSec / safeRate) * 1000,
        ),
      ),
    );
  }

  return {
    fromFraction,
    toFraction: endFraction,
    durationMs,
    isDownbeat,
  };
}
