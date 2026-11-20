import type { QuantumBase } from "../engine/types";
import { clampVolume } from "./volume";

export const BASE_METRONOME_GAIN = 1;
export const HI_TICK_GAIN = 1.0;
export const LO_TICK_GAIN = 0.72;
export const HI_TICK_START_HZ = 1760;
export const HI_TICK_END_HZ = 1500;
export const HI_TICK_DURATION_SECONDS = 0.036;
export const LO_TICK_START_HZ = 1175;
export const LO_TICK_END_HZ = 1000;
export const LO_TICK_DURATION_SECONDS = 0.03;
export const DEFAULT_BEATS_PER_BAR = 4;
export const MAX_REASONABLE_BAR_BEATS = 12;
export const MIN_METRONOME_VOLUME_PCT = 0;
export const MAX_METRONOME_VOLUME_PCT = 200;
export const DEFAULT_METRONOME_VOLUME_PCT = 100;
export const DEFAULT_METRONOME_BEAT_OFFSET = 0;
export const METRONOME_TIME_SIGNATURE_OPTIONS: ReadonlyArray<number | null> = [
  null,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
];

export type MetronomeDownbeatOptions = {
  beatsPerBar?: number;
  beatsPerBarOverride?: number | null;
  beatOffset?: number;
};

export type MetronomeTickBuffers = {
  hi: AudioBuffer;
  lo: AudioBuffer;
};

export type MetronomeOverlayOptions = {
  destination?: AudioNode;
};

/**
 * Resolves a valid beat-per-bar count from a track's time signature metadata,
 * falling back to 4/4 when omitted or outside reasonable bounds.
 */
export function resolveBeatsPerBar(timeSignature?: number): number {
  if (typeof timeSignature !== "number" || !Number.isFinite(timeSignature)) {
    return DEFAULT_BEATS_PER_BAR;
  }
  const rounded = Math.round(timeSignature);
  if (rounded < 1 || rounded > MAX_REASONABLE_BAR_BEATS) {
    return DEFAULT_BEATS_PER_BAR;
  }
  return rounded;
}

/**
 * Clamps a metronome volume percentage to [0, 200], defaulting non-finite
 * inputs to 100%.
 */
export function clampMetronomeVolumePct(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_METRONOME_VOLUME_PCT;
  }
  return Math.max(
    MIN_METRONOME_VOLUME_PCT,
    Math.min(MAX_METRONOME_VOLUME_PCT, Math.round(value)),
  );
}

/**
 * Normalizes an optional explicit time-signature override (beats per bar),
 * returning null for Auto mode or out-of-range inputs.
 */
export function resolveMetronomeTimeSignatureOverride(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > MAX_REASONABLE_BAR_BEATS) {
    return null;
  }
  return rounded;
}

/**
 * Clamps the hi/lo beat offset into [0, beatsPerBar - 1].
 */
export function clampMetronomeBeatOffset(
  value: number,
  beatsPerBar = DEFAULT_BEATS_PER_BAR,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_METRONOME_BEAT_OFFSET;
  }
  const safeBeatsPerBar = resolveBeatsPerBar(beatsPerBar);
  const maxOffset = Math.max(0, safeBeatsPerBar - 1);
  return Math.max(0, Math.min(maxOffset, Math.trunc(value)));
}

/**
 * Detects the dominant beats-per-bar count from a track's analyzed parent bars,
 * falling back to metadata time signature when valid bars are unavailable.
 */
export function detectTrackBeatsPerBar(
  beats?: ReadonlyArray<Pick<QuantumBase, "parent">>,
  fallbackTimeSignature?: number,
): number {
  if (beats && beats.length > 0) {
    const seenBars = new Set<QuantumBase>();
    const counts = new Map<number, number>();
    for (const beat of beats) {
      const parent = beat.parent;
      if (!parent || seenBars.has(parent)) {
        continue;
      }
      seenBars.add(parent);
      const len = parent.children?.length;
      if (
        typeof len === "number" &&
        Number.isInteger(len) &&
        len >= 1 &&
        len <= MAX_REASONABLE_BAR_BEATS
      ) {
        counts.set(len, (counts.get(len) ?? 0) + 1);
      }
    }
    let bestLen: number | null = null;
    let bestCount = 0;
    for (const [len, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestLen = len;
      }
    }
    if (bestLen !== null) {
      return bestLen;
    }
  }
  return resolveBeatsPerBar(fallbackTimeSignature);
}

/**
 * Computes a non-negative remainder modulo `modulus`.
 */
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Determines whether a beat should play the accented high tick (beat 1 of a bar,
 * shifted by any beat offset). Uses the explicit time-signature override when
 * set, otherwise uses analyzed bar structure and falls back to modular counting.
 */
export function isMetronomeDownbeat(
  beatIndex: number,
  beat?: Pick<QuantumBase, "indexInParent" | "parent" | "localWhich">,
  beatsPerBarOrOptions: number | MetronomeDownbeatOptions = DEFAULT_BEATS_PER_BAR,
): boolean {
  const opts: MetronomeDownbeatOptions =
    typeof beatsPerBarOrOptions === "number"
      ? { beatsPerBar: beatsPerBarOrOptions }
      : beatsPerBarOrOptions;
  const beatsPerBar = opts.beatsPerBar ?? DEFAULT_BEATS_PER_BAR;
  const resolvedOverride = resolveMetronomeTimeSignatureOverride(
    opts.beatsPerBarOverride,
  );
  const rawOffset = opts.beatOffset ?? DEFAULT_METRONOME_BEAT_OFFSET;
  const offset = Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;

  if (resolvedOverride !== null) {
    // Prefer localWhich so multi-track mixes restart beat counting per song slice.
    const localIndex =
      typeof beat?.localWhich === "number" && Number.isInteger(beat.localWhich)
        ? beat.localWhich
        : beatIndex;
    if (!Number.isInteger(localIndex)) {
      return false;
    }
    return positiveMod(localIndex - offset, resolvedOverride) === 0;
  }

  const barBeatCount = beat?.parent?.children?.length;
  // Guard against degenerate single-bar analyses that group the entire track
  // into one oversized bar.
  const hasValidBarIndex =
    typeof beat?.indexInParent === "number" &&
    Number.isInteger(beat.indexInParent) &&
    beat.indexInParent >= 0 &&
    (barBeatCount === undefined ||
      (barBeatCount >= 1 && barBeatCount <= MAX_REASONABLE_BAR_BEATS));
  if (hasValidBarIndex) {
    const cycle = barBeatCount ?? resolveBeatsPerBar(beatsPerBar);
    return positiveMod((beat.indexInParent as number) - offset, cycle) === 0;
  }

  const safeBeatsPerBar = resolveBeatsPerBar(beatsPerBar);
  const localIndex =
    typeof beat?.localWhich === "number" && Number.isInteger(beat.localWhich)
      ? beat.localWhich
      : beatIndex;
  if (!Number.isInteger(localIndex)) {
    return false;
  }
  return positiveMod(localIndex - offset, safeBeatsPerBar) === 0;
}

/**
 * Synthesizes a short woody click buffer with a fast pitch drop and crisp
 * exponential decay for metronome ticks.
 */
export function synthesizeMetronomeTickBuffer(
  context: BaseAudioContext,
  options: { startHz: number; endHz: number; durationSeconds: number },
): AudioBuffer | null {
  if (typeof context.createBuffer !== "function") {
    return null;
  }
  const sampleRate = Math.max(8000, Math.round(context.sampleRate || 44100));
  const frameCount = Math.max(1, Math.round(sampleRate * options.durationSeconds));
  const buffer = context.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);

  const attackSeconds = 0.0008;
  const pitchDecayTau = 0.004;
  const envDecayTau = Math.max(1e-4, options.durationSeconds * 0.22);
  const fadeOutSeconds = 0.003;
  const fadeFrames = Math.min(
    frameCount,
    Math.max(1, Math.round(sampleRate * fadeOutSeconds)),
  );
  const fadeStartIndex = frameCount - fadeFrames;

  let phase = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const t = frame / sampleRate;
    // Fast initial pitch drop gives the attack a percussive woody transient.
    const freq =
      options.endHz +
      (options.startHz - options.endHz) * Math.exp(-t / pitchDecayTau);
    phase += (2 * Math.PI * freq) / sampleRate;

    const harmonicBody =
      Math.sin(phase) +
      0.35 * Math.sin(2 * phase) * Math.exp(-t / 0.008) +
      0.15 * Math.sin(3 * phase) * Math.exp(-t / 0.004);

    const attackEnv = t < attackSeconds ? t / attackSeconds : 1;
    const decayEnv = Math.exp(-t / envDecayTau);

    // Apply a raised-cosine tail fade so the final sample lands cleanly on 0.
    let tailFade = 1;
    if (frame >= fadeStartIndex) {
      const progress =
        fadeFrames > 1 ? (frame - fadeStartIndex) / (fadeFrames - 1) : 1;
      tailFade = 0.5 * (1 + Math.cos(Math.PI * progress));
    }

    const sample = harmonicBody * attackEnv * decayEnv * tailFade * 0.65;
    const clamped = Math.max(-1, Math.min(1, sample));
    channel[frame] = clamped === 0 ? 0 : clamped;
  }

  return buffer;
}

/**
 * Generates both high (downbeat) and low (subsequent beat) metronome click
 * buffers on the provided audio context.
 */
export function createMetronomeTickBuffers(
  context: BaseAudioContext,
): MetronomeTickBuffers | null {
  const hi = synthesizeMetronomeTickBuffer(context, {
    startHz: HI_TICK_START_HZ,
    endHz: HI_TICK_END_HZ,
    durationSeconds: HI_TICK_DURATION_SECONDS,
  });
  const lo = synthesizeMetronomeTickBuffer(context, {
    startHz: LO_TICK_START_HZ,
    endHz: LO_TICK_END_HZ,
    durationSeconds: LO_TICK_DURATION_SECONDS,
  });
  if (!hi || !lo) {
    return null;
  }
  return { hi, lo };
}

/**
 * Beat-synchronized Web Audio overlay that plays FL Studio-style high/low
 * metronome ticks aligned to the active track's beats and bar downbeats.
 */
export class MetronomeOverlayService {
  private readonly context: AudioContext;
  private readonly masterGain: GainNode;
  private buffers: MetronomeTickBuffers | null = null;
  private enabled = false;
  private disposed = false;
  private volume = 1;
  private metronomeVolumePct = DEFAULT_METRONOME_VOLUME_PCT;
  private beatsPerBar = DEFAULT_BEATS_PER_BAR;
  private beatsPerBarOverride: number | null = null;
  private beatOffset = DEFAULT_METRONOME_BEAT_OFFSET;
  private readonly activeSources = new Set<AudioBufferSourceNode>();

  /**
   * Initializes the metronome master gain stage and connects it to the output.
   */
  constructor(context: AudioContext, options: MetronomeOverlayOptions = {}) {
    this.context = context;
    this.masterGain = this.context.createGain();
    this.updateMasterGain();
    this.masterGain.connect(options.destination ?? this.context.destination);
  }

  /**
   * Enables the metronome overlay and ensures synthesized tick buffers exist.
   */
  enable(): void {
    if (this.disposed) {
      return;
    }
    this.enabled = true;
    this.ensureBuffers();
  }

  /**
   * Disables the metronome overlay and stops any active tick playback.
   */
  disable(): void {
    this.enabled = false;
    this.cancelScheduledHits();
  }

  /**
   * Returns whether the metronome overlay is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Scales metronome output gain using the shared playback volume (0 to 1).
   */
  setVolume(value: number): void {
    this.volume = clampVolume(value, this.volume);
    this.updateMasterGain();
  }

  /**
   * Sets the dedicated metronome volume trim percentage (0% to 200%).
   */
  setMetronomeVolumePct(volumePct: number): void {
    this.metronomeVolumePct = clampMetronomeVolumePct(volumePct);
    this.updateMasterGain();
  }

  /**
   * Returns the dedicated metronome volume trim percentage (0% to 200%).
   */
  getMetronomeVolumePct(): number {
    return this.metronomeVolumePct;
  }

  /**
   * Sets the fallback beats-per-bar count from the active track's time signature.
   */
  setBeatsPerBar(timeSignature?: number): void {
    this.beatsPerBar = resolveBeatsPerBar(timeSignature);
  }

  /**
   * Sets an explicit time-signature override (beats per bar) or null for Auto.
   */
  setBeatsPerBarOverride(beatsPerBar: number | null): void {
    this.beatsPerBarOverride = resolveMetronomeTimeSignatureOverride(beatsPerBar);
  }

  /**
   * Returns the explicit beats-per-bar override, or null when using Auto.
   */
  getBeatsPerBarOverride(): number | null {
    return this.beatsPerBarOverride;
  }

  /**
   * Sets the zero-based beat offset that shifts which beat receives the Hi tick.
   */
  setBeatOffset(offset: number): void {
    this.beatOffset = Number.isFinite(offset)
      ? Math.max(0, Math.trunc(offset))
      : DEFAULT_METRONOME_BEAT_OFFSET;
  }

  /**
   * Returns the active hi/lo beat offset.
   */
  getBeatOffset(): number {
    return this.beatOffset;
  }

  /**
   * Triggers a high tick on bar downbeats and a lower tick on other beats.
   */
  handleBeatEnter(
    beatIndex: number,
    beat?: Pick<QuantumBase, "indexInParent" | "parent" | "localWhich">,
  ): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    const buffers = this.ensureBuffers();
    if (!buffers) {
      return;
    }

    const downbeat = isMetronomeDownbeat(beatIndex, beat, {
      beatsPerBar: this.beatsPerBar,
      beatsPerBarOverride: this.beatsPerBarOverride,
      beatOffset: this.beatOffset,
    });
    const buffer = downbeat ? buffers.hi : buffers.lo;
    const gainValue = downbeat ? HI_TICK_GAIN : LO_TICK_GAIN;
    this.triggerTick(buffer, gainValue);
  }

  /**
   * Stops and disconnects any currently playing metronome tick sources.
   */
  cancelScheduledHits(): void {
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // Ignore sources that already completed before cancellation.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect errors on torn-down audio nodes.
      }
    }
    this.activeSources.clear();
  }

  /**
   * Releases buffers and disconnects the metronome gain stage permanently.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disable();
    this.disposed = true;
    this.buffers = null;
    try {
      this.masterGain.disconnect();
    } catch {
      // Ignore disconnect errors if destination was already detached.
    }
  }

  private ensureBuffers(): MetronomeTickBuffers | null {
    if (this.disposed) {
      return null;
    }
    this.buffers ??= createMetronomeTickBuffers(this.context);
    return this.buffers;
  }

  private triggerTick(buffer: AudioBuffer, gainValue: number): void {
    const source = this.context.createBufferSource();
    const hitGain = this.context.createGain();
    source.buffer = buffer;
    hitGain.gain.value = gainValue;
    source.connect(hitGain);
    hitGain.connect(this.masterGain);

    source.onended = () => {
      this.removeActiveSource(source);
      try {
        hitGain.disconnect();
      } catch {
        // Ignore disconnect errors on torn-down gain nodes.
      }
    };

    this.activeSources.add(source);
    try {
      source.start(this.context.currentTime);
    } catch {
      this.removeActiveSource(source);
    }
  }

  private removeActiveSource(source: AudioBufferSourceNode): void {
    this.activeSources.delete(source);
    try {
      source.disconnect();
    } catch {
      // Ignore disconnect errors on torn-down source nodes.
    }
  }

  private updateMasterGain(): void {
    this.masterGain.gain.value =
      BASE_METRONOME_GAIN * this.volume * (this.metronomeVolumePct / 100);
  }
}
