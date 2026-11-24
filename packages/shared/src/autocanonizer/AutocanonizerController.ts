import type { QuantumBase, Segment, TrackAnalysis } from "../engine/types";
import { normalizeAnalysis } from "../engine/analysis";
import { AutocanonizerViz, type CanonizerBeat } from "./AutocanonizerViz";
import {
  backgroundClearTimeout,
  backgroundSetTimeout,
} from "../background/backgroundTimer";
import {
  CANONIZER_MASTER_BLEND,
  CANONIZER_MAX_SKEW_DELTA,
  planCanonizerRender,
  type CanonizerRenderPlan,
} from "./canonizerRenderPlan";
import { computeBeatColors } from "../engine/beatColors";
import {
  alignTrackPairDtw,
  computeCoverBeatDistance,
  extractTrackBeatFeatures,
} from "../engine/coverSync";
import { clampVolume } from "../audio/volume";

type BeatWithSim = CanonizerBeat & {
  sim?: CanonizerBeat;
  simDistance?: number;
};

export type AutocanonizerMixAlignmentMode = "cover-sync" | "section-fold";

export type AutocanonizerDualAnalysisOptions = {
  mainDuration?: number | null;
  otherDuration?: number | null;
  otherTempoRatio?: number;
  alignmentMode?: AutocanonizerMixAlignmentMode;
};

const TIMBRE_WEIGHT = 1;
const PITCH_WEIGHT = 10;
const LOUD_START_WEIGHT = 1;
const LOUD_MAX_WEIGHT = 1;
const DURATION_WEIGHT = 100;
const CONFIDENCE_WEIGHT = 1;
const VOLUME_WINDOW = 20;
const MIN_STREAM_GAIN = 0;
const MAX_STREAM_GAIN = 2;
const SECTION_FOLD_BAR_MISMATCH_PENALTY = 15;

export type AutocanonizerCursorTimes = {
  mainSeconds: number;
  otherSeconds: number;
};

class AutocanonizerPlayer {
  private readonly context: AudioContext;
  private buffer: AudioBuffer;
  private otherBuffer: AudioBuffer | null = null;
  private readonly mainGain: GainNode;
  private readonly otherGain: GainNode;
  private readonly mainPanner: StereoPannerNode | null;
  private readonly otherPanner: StereoPannerNode | null;
  private readonly masterBlend: number;
  private baseVolume = 1;
  private mainStreamPan = 0;
  private otherStreamPan = 0;
  private mainStreamGain = 1;
  private otherStreamGain = 1;
  private otherBeatGain = 1;

  private currentBeat: CanonizerBeat | null = null;
  private mainSource: AudioBufferSourceNode | null = null;
  private otherSource: AudioBufferSourceNode | null = null;
  private deltaTime = 0;
  private otherDeltaTime = 0;
  private skewDelta = 0;
  private readonly maxSkewDelta = CANONIZER_MAX_SKEW_DELTA;

  constructor(
    context: AudioContext,
    buffer: AudioBuffer,
    masterBlend = CANONIZER_MASTER_BLEND,
  ) {
    this.context = context;
    this.buffer = buffer;
    this.masterBlend = masterBlend;
    this.mainGain = this.context.createGain();
    this.otherGain = this.context.createGain();
    this.mainPanner =
      typeof this.context.createStereoPanner === "function"
        ? this.context.createStereoPanner()
        : null;
    this.otherPanner =
      typeof this.context.createStereoPanner === "function"
        ? this.context.createStereoPanner()
        : null;
    if (this.mainPanner) {
      this.mainPanner.connect(this.mainGain);
    }
    if (this.otherPanner) {
      this.otherPanner.connect(this.otherGain);
    }
    this.mainGain.connect(this.context.destination);
    this.otherGain.connect(this.context.destination);
    this.applyGains();
    this.applyPans();
  }

  setBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
    this.otherBuffer = null;
  }

  /**
   * Assigns distinct main and secondary AudioBuffers for dual-song mix playback.
   */
  setBuffers(mainBuffer: AudioBuffer, otherBuffer: AudioBuffer | null) {
    this.buffer = mainBuffer;
    this.otherBuffer = otherBuffer;
  }

  setVolume(volume: number) {
    this.baseVolume = clampVolume(volume, this.baseVolume);
    this.applyGains();
  }

  setStreamPans(main: number, other: number) {
    this.mainStreamPan = clampPan(main);
    this.otherStreamPan = clampPan(other);
    this.applyPans();
  }

  /**
   * Sets per-stream linear volume trim multipliers (0–2) for the main and
   * secondary autocanonizer voices independently of master volume.
   */
  setStreamGains(main: number, other: number) {
    this.mainStreamGain = clampStreamGain(main, this.mainStreamGain);
    this.otherStreamGain = clampStreamGain(other, this.otherStreamGain);
    this.applyGains();
  }

  reset() {
    this.stop();
    this.currentBeat = null;
    this.deltaTime = 0;
    this.otherDeltaTime = 0;
    this.skewDelta = 0;
  }

  stop() {
    if (this.mainSource) {
      try {
        this.mainSource.stop(0);
      } catch {
        // no-op
      }
      this.mainSource.disconnect();
      this.mainSource = null;
    }
    if (this.otherSource) {
      try {
        this.otherSource.stop(0);
      } catch {
        // no-op
      }
      this.otherSource.disconnect();
      this.otherSource = null;
    }
  }

  stopMain() {
    if (!this.mainSource) {
      return;
    }
    try {
      this.mainSource.stop(0);
    } catch {
      // no-op
    }
    this.mainSource.disconnect();
    this.mainSource = null;
  }

  playBeat(beat: CanonizerBeat) {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    if (this.currentBeat?.next !== beat) {
      if (this.mainSource) {
        this.mainSource.stop();
      }
      const duration = this.buffer.duration - beat.start;
      this.mainSource = this.playBuffer(
        this.buffer,
        beat.start,
        duration,
        this.mainPanner ?? this.mainGain,
      );
      this.deltaTime = this.context.currentTime - beat.start;
    }

    const now = this.context.currentTime - this.deltaTime;
    const delta = now - beat.start;
    const clampedOtherGain = Math.max(0, Math.min(1, beat.otherGain));

    this.otherBeatGain = clampedOtherGain;
    this.applyOtherGain();
    const otherBuf = this.otherBuffer ?? this.buffer;
    if (
      this.currentBeat?.other.next !== beat.other ||
      Math.abs(this.skewDelta) > this.maxSkewDelta
    ) {
      this.skewDelta = 0;
      if (this.otherSource) {
        this.otherSource.stop();
      }
      const duration = otherBuf.duration - beat.other.start;
      this.otherSource = this.playBuffer(
        otherBuf,
        beat.other.start,
        duration,
        this.otherPanner ?? this.otherGain,
      );
      this.otherDeltaTime = this.context.currentTime - beat.other.start;
    }
    this.skewDelta += beat.duration - beat.other.duration;
    this.currentBeat = beat;
    return beat.duration - delta;
  }

  playOtherOnly(beat: CanonizerBeat) {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    const clampedOtherGain = Math.max(0, Math.min(1, beat.otherGain));
    this.otherBeatGain = clampedOtherGain;
    this.applyOtherGain();
    const otherBuf = this.otherBuffer ?? this.buffer;
    if (this.currentBeat?.other.next !== beat) {
      if (this.otherSource) {
        this.otherSource.stop();
      }
      const duration = otherBuf.duration - beat.start;
      this.otherSource = this.playBuffer(
        otherBuf,
        beat.start,
        duration,
        this.otherPanner ?? this.otherGain,
      );
      this.otherDeltaTime = this.context.currentTime - beat.start;
    }
    const now = this.context.currentTime - this.otherDeltaTime;
    const delta = now - beat.start;
    this.currentBeat = beat;
    return beat.duration - delta;
  }

  private playBuffer(
    buffer: AudioBuffer,
    start: number,
    duration: number,
    destination: AudioNode,
  ) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.start(0, start, Math.max(0, duration));
    return source;
  }

  private applyGains() {
    this.mainGain.gain.value =
      this.baseVolume * this.masterBlend * this.mainStreamGain;
    this.applyOtherGain();
  }

  private applyOtherGain() {
    this.otherGain.gain.value =
      this.baseVolume *
      (1 - this.masterBlend) *
      this.otherStreamGain *
      this.otherBeatGain;
  }

  private applyPans() {
    if (this.mainPanner) {
      this.mainPanner.pan.value = this.mainStreamPan;
    }
    if (this.otherPanner) {
      this.otherPanner.pan.value = this.otherStreamPan;
    }
  }
}

export class AutocanonizerController {
  private readonly viz: AutocanonizerViz;
  private beats: BeatWithSim[] = [];
  private otherBeats: BeatWithSim[] = [];
  private mainSections: Array<{ start: number; duration: number }> = [];
  private otherSections: Array<{ start: number; duration: number }> = [];
  private mainDuration = 0;
  private otherDuration = 0;
  private dualAlignmentMode: AutocanonizerMixAlignmentMode = "cover-sync";
  private player: AutocanonizerPlayer | null = null;
  private running = false;
  private timerId: number | null = null;
  private secondaryOnly = false;
  private secondaryIndex = 0;
  private finishOutSong = false;
  private currentIndex = 0;
  private mainStreamPan = 0;
  private otherStreamPan = 0;
  private mainStreamGain = 1;
  private otherStreamGain = 1;
  private volume = 1;
  private onBeat:
    | ((
        index: number,
        beat: CanonizerBeat,
        cursorTimes: AutocanonizerCursorTimes,
      ) => void)
    | null = null;
  private onEnded: (() => void) | null = null;
  private onSelect: ((index: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.viz = new AutocanonizerViz(container);
    this.viz.setOnSelect((index) => {
      this.onSelect?.(index);
      this.selectIndex(index, true);
    });
  }

  setVisible(visible: boolean) {
    this.viz.setVisible(visible);
  }

  resizeNow() {
    this.viz.resizeNow();
  }

  setOnBeat(
    handler:
      | ((
          index: number,
          beat: CanonizerBeat,
          cursorTimes: AutocanonizerCursorTimes,
        ) => void)
      | null,
  ) {
    this.onBeat = handler;
  }

  setOnEnded(handler: (() => void) | null) {
    this.onEnded = handler;
  }

  setOnSelect(handler: ((index: number) => void) | null) {
    this.onSelect = handler;
  }

  // When enabled, the main cursor stops at the final beat and the trailing
  // other cursor plays out to the end. When disabled (the default), the track
  // loops back to the first beat and repeats.
  setFinishOutSong(enabled: boolean) {
    this.finishOutSong = enabled;
  }

  setVolume(volume: number) {
    this.volume = clampVolume(volume, this.volume);
    this.player?.setVolume(this.volume);
  }

  setStreamPans(main: number, other: number) {
    this.mainStreamPan = clampPan(main);
    this.otherStreamPan = clampPan(other);
    this.player?.setStreamPans(this.mainStreamPan, this.otherStreamPan);
  }

  /**
   * Sets per-stream linear volume trim multipliers (0–2) for the main and
   * secondary voices, persisting across subsequent audio attachments.
   */
  setStreamGains(main: number, other: number) {
    this.mainStreamGain = clampStreamGain(main, this.mainStreamGain);
    this.otherStreamGain = clampStreamGain(other, this.otherStreamGain);
    this.player?.setStreamGains(this.mainStreamGain, this.otherStreamGain);
  }

  setAudio(buffer: AudioBuffer | null, context: AudioContext | null) {
    if (buffer && context) {
      if (!this.player) {
        this.player = new AutocanonizerPlayer(context, buffer);
        this.player.setStreamPans(this.mainStreamPan, this.otherStreamPan);
        this.player.setStreamGains(this.mainStreamGain, this.otherStreamGain);
        this.player.setVolume(this.volume);
      } else {
        this.player.setBuffers(buffer, null);
      }
    } else {
      this.player = null;
    }
  }

  /**
   * Attaches two separate AudioBuffers (Song 1 main and Song 2 secondary) for
   * dual-song Autocanonizer mix playback.
   */
  setDualAudio(
    mainBuffer: AudioBuffer | null,
    otherBuffer: AudioBuffer | null,
    context: AudioContext | null,
  ) {
    if (mainBuffer && otherBuffer && context) {
      if (!this.player) {
        this.player = new AutocanonizerPlayer(context, mainBuffer);
        this.player.setBuffers(mainBuffer, otherBuffer);
        this.player.setStreamPans(this.mainStreamPan, this.otherStreamPan);
        this.player.setStreamGains(this.mainStreamGain, this.otherStreamGain);
        this.player.setVolume(this.volume);
      } else {
        this.player.setBuffers(mainBuffer, otherBuffer);
      }
    } else {
      this.player = null;
    }
  }

  setAnalysis(raw: unknown, durationOverride?: number | null) {
    const analysis = normalizeAnalysis(raw);
    const beats = prepareCanonizerBeats(analysis);
    this.otherBeats = [];
    this.otherSections = [];
    this.otherDuration = 0;
    if (!beats.length) {
      this.beats = [];
      this.mainSections = [];
      this.mainDuration = 0;
      return;
    }
    const trackDuration =
      durationOverride ??
      analysis.track?.duration ??
      beats[beats.length - 1].start + beats[beats.length - 1].duration;
    calculateNearestNeighbors(beats);
    foldBySection(beats);
    this.beats = beats;
    this.mainDuration = trackDuration;
    this.mainSections = analysis.sections.map((section) => ({
      start: section.start,
      duration: section.duration,
    }));
    this.viz.setData(beats, trackDuration, this.mainSections);
  }

  /**
   * Configures a 2-song Autocanonizer mix using Song 1 as the main timeline
   * and Song 2 (scaled by `otherTempoRatio`) as the secondary voice.
   */
  setDualAnalysis(
    mainRaw: unknown,
    otherRaw: unknown,
    options?: AutocanonizerDualAnalysisOptions,
  ) {
    const mainAnalysis = normalizeAnalysis(mainRaw);
    const otherAnalysis = normalizeAnalysis(otherRaw);
    const tempoRatio =
      options?.otherTempoRatio !== undefined &&
      Number.isFinite(options.otherTempoRatio) &&
      options.otherTempoRatio > 0
        ? options.otherTempoRatio
        : 1;
    if (tempoRatio !== 1) {
      scaleAnalysisTiming(otherAnalysis, 1 / tempoRatio);
    }

    const mainBeats = prepareCanonizerBeats(mainAnalysis);
    const otherBeats = prepareCanonizerBeats(otherAnalysis);
    if (!mainBeats.length || !otherBeats.length) {
      this.beats = [];
      this.otherBeats = [];
      this.mainSections = [];
      this.otherSections = [];
      this.mainDuration = 0;
      this.otherDuration = 0;
      return;
    }

    const mainDuration =
      options?.mainDuration ??
      mainAnalysis.track?.duration ??
      mainBeats[mainBeats.length - 1].start +
        mainBeats[mainBeats.length - 1].duration;
    const otherDuration =
      options?.otherDuration ??
      (otherAnalysis.track?.duration !== undefined
        ? otherAnalysis.track.duration / tempoRatio
        : otherBeats[otherBeats.length - 1].start +
          otherBeats[otherBeats.length - 1].duration);

    this.dualAlignmentMode = options?.alignmentMode ?? this.dualAlignmentMode;
    applyDualAlignment(mainBeats, otherBeats, this.dualAlignmentMode);

    this.beats = mainBeats;
    this.otherBeats = otherBeats;
    this.mainDuration = mainDuration;
    this.otherDuration = otherDuration;
    this.mainSections = mainAnalysis.sections.map((section) => ({
      start: section.start,
      duration: section.duration,
    }));
    this.otherSections = otherAnalysis.sections.map((section) => ({
      start: section.start,
      duration: section.duration,
    }));

    this.viz.setDualData(
      this.beats,
      this.mainDuration,
      this.mainSections,
      this.otherBeats,
      this.otherDuration,
      this.otherSections,
    );
  }

  /**
   * Switches the 2-song cross-alignment strategy ("cover-sync" vs
   * "section-fold") and updates the visualization and live playback in place.
   */
  setDualAlignmentMode(mode: AutocanonizerMixAlignmentMode) {
    this.dualAlignmentMode = mode;
    if (!this.beats.length || !this.otherBeats.length) {
      return;
    }
    applyDualAlignment(this.beats, this.otherBeats, mode);
    this.viz.setDualData(
      this.beats,
      this.mainDuration,
      this.mainSections,
      this.otherBeats,
      this.otherDuration,
      this.otherSections,
    );
    if (this.running && !this.secondaryOnly) {
      if (this.timerId !== null) {
        backgroundClearTimeout(this.timerId);
        this.timerId = null;
      }
      this.player?.reset();
      this.tick();
    } else if (
      this.currentIndex >= 0 &&
      this.currentIndex < this.beats.length
    ) {
      this.viz.update(this.currentIndex);
    }
  }

  reset() {
    this.stop();
    this.beats = [];
    this.otherBeats = [];
    this.mainSections = [];
    this.otherSections = [];
    this.mainDuration = 0;
    this.otherDuration = 0;
    this.viz.reset();
  }

  resetVisualization() {
    this.viz.reset();
  }

  destroy() {
    this.stop();
    this.beats = [];
    this.otherBeats = [];
    this.mainSections = [];
    this.otherSections = [];
    this.mainDuration = 0;
    this.otherDuration = 0;
    this.viz.destroy();
    this.player = null;
  }

  selectIndex(index: number, autoStart: boolean) {
    if (!this.beats.length) {
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.beats.length - 1));
    this.currentIndex = clamped;
    if (this.running) {
      if (this.timerId !== null) {
        backgroundClearTimeout(this.timerId);
        this.timerId = null;
      }
      this.tick();
      return;
    }
    this.viz.update(this.currentIndex);
    if (autoStart) {
      this.start();
    }
  }

  isReady() {
    return Boolean(this.player && this.beats.length);
  }

  // The canon as a timed plan for offline rendering, with the current
  // finish-out setting and stream pans. Null until an analysis is set.
  planRender(): CanonizerRenderPlan | null {
    return planCanonizerRender(this.beats, {
      finishOutSong: this.finishOutSong,
      mainPan: this.mainStreamPan,
      otherPan: this.otherStreamPan,
    });
  }

  start() {
    this.startAtIndex(0);
  }

  startAtIndex(index: number) {
    if (!this.isReady() || !this.player) {
      return;
    }
    this.stop();
    this.running = true;
    this.secondaryOnly = false;
    this.currentIndex = Math.max(0, Math.min(index, this.beats.length - 1));
    this.player.reset();
    this.tick();
  }

  stop() {
    if (!this.running) {
      if (this.player) {
        this.player.stop();
      }
      return;
    }
    this.running = false;
    this.secondaryOnly = false;
    if (this.timerId !== null) {
      backgroundClearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.player) {
      this.player.stop();
    }
  }

  private tick() {
    if (!this.running) {
      return;
    }
    if (!this.player || !this.beats.length) {
      this.running = false;
      this.onEnded?.();
      return;
    }
    if (this.currentIndex >= this.beats.length) {
      this.running = false;
      this.onEnded?.();
      return;
    }
    const beat = this.beats[this.currentIndex];
    const isFinal = this.currentIndex === this.beats.length - 1;
    const delay = this.player.playBeat(beat);
    this.viz.update(this.currentIndex);
    this.onBeat?.(this.currentIndex, beat, {
      mainSeconds: beat.start,
      otherSeconds: beat.other.start,
    });
    if (isFinal) {
      if (this.finishOutSong) {
        this.secondaryOnly = true;
        this.secondaryIndex = beat.other.which;
        this.player.stopMain();
        this.tickSecondary();
        return;
      }
      // Default: loop back to the top of the track.
      this.currentIndex = 0;
    } else {
      this.currentIndex += 1;
    }
    const nextDelayMs = Math.max(0, delay * 1000);
    this.timerId = backgroundSetTimeout(() => this.tick(), nextDelayMs);
  }

  private tickSecondary() {
    if (!this.running || !this.secondaryOnly) {
      return;
    }
    const secondaryBeats = this.otherBeats.length ? this.otherBeats : this.beats;
    if (!this.player || !secondaryBeats.length) {
      this.stop();
      this.onEnded?.();
      return;
    }
    if (this.secondaryIndex >= secondaryBeats.length) {
      this.stop();
      this.onEnded?.();
      return;
    }
    const beat = secondaryBeats[this.secondaryIndex];
    const delay = this.player.playOtherOnly(beat);
    this.viz.setOtherIndex(this.secondaryIndex);
    this.onBeat?.(this.secondaryIndex, beat, {
      mainSeconds: this.beats[this.beats.length - 1]?.start ?? 0,
      otherSeconds: beat.start,
    });
    this.secondaryIndex += 1;
    const nextDelayMs = Math.max(0, delay * 1000);
    this.timerId = backgroundSetTimeout(() => this.tickSecondary(), nextDelayMs);
  }
}

function clampPan(pan: number) {
  if (!Number.isFinite(pan)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, pan));
}

function clampStreamGain(gain: number, fallback: number) {
  if (!Number.isFinite(gain)) {
    return fallback;
  }
  return Math.max(MIN_STREAM_GAIN, Math.min(MAX_STREAM_GAIN, gain));
}

/**
 * Prepares normalized canonizer beats with section indices, normalized volumes,
 * and segment-based beat colors.
 */
function prepareCanonizerBeats(analysis: TrackAnalysis): BeatWithSim[] {
  const beats = analysis.beats as BeatWithSim[];
  if (!beats.length) {
    return [];
  }
  beats.forEach((beat) => {
    beat.section = getSectionIndex(beat);
  });
  assignNormalizedVolumes(beats);
  computeBeatColors(beats, analysis.segments).forEach((color, index) => {
    beats[index].color = color;
  });
  return beats;
}

/**
 * Scales all timestamps and durations in a normalized TrackAnalysis in place so
 * a tempo-synced secondary cover aligns with the primary song's timeline.
 */
function scaleAnalysisTiming(analysis: TrackAnalysis, timeScale: number) {
  if (timeScale === 1) {
    return;
  }
  const scaleList = (items: QuantumBase[]) => {
    for (const item of items) {
      item.start *= timeScale;
      item.duration *= timeScale;
    }
  };
  scaleList(analysis.sections);
  scaleList(analysis.bars);
  scaleList(analysis.beats);
  scaleList(analysis.tatums);
  for (const seg of analysis.segments) {
    seg.start *= timeScale;
    seg.duration *= timeScale;
    seg.loudness_max_time *= timeScale;
  }
}

/**
 * Builds a beat-index lookup mapping each beat of Song 1 to the structurally
 * aligned beat index in Song 2 via Semi-Global DTW, linearly extrapolating any
 * unaligned intro/outro beats and clamping to valid indices.
 */
function buildCoverSyncIndexMap(
  featuresA: ReturnType<typeof extractTrackBeatFeatures>,
  featuresB: ReturnType<typeof extractTrackBeatFeatures>,
  mainLength: number,
  otherLength: number,
): number[] {
  const aligned = alignTrackPairDtw(featuresA, featuresB);
  const bestByA = new Map<number, { indexB: number; distance: number }>();
  for (const pair of aligned) {
    const existing = bestByA.get(pair.indexA);
    if (!existing || pair.distance < existing.distance) {
      bestByA.set(pair.indexA, {
        indexB: pair.indexB,
        distance: pair.distance,
      });
    }
  }
  const coveredIndices = [...bestByA.keys()].sort((a, b) => a - b);
  const firstA = coveredIndices[0] ?? 0;
  const lastA = coveredIndices[coveredIndices.length - 1] ?? 0;
  const firstB = bestByA.get(firstA)?.indexB ?? 0;
  const lastB = bestByA.get(lastA)?.indexB ?? 0;
  const maxOtherIndex = Math.max(0, otherLength - 1);

  const map = new Array<number>(mainLength);
  for (let i = 0; i < mainLength; i += 1) {
    let targetIdx: number;
    const mapped = bestByA.get(i);
    if (mapped) {
      targetIdx = mapped.indexB;
    } else if (coveredIndices.length === 0) {
      targetIdx = Math.min(i, maxOtherIndex);
    } else if (i < firstA) {
      // Extrapolate backward linearly before the DTW-aligned span begins.
      targetIdx = firstB - (firstA - i);
    } else if (i > lastA) {
      // Extrapolate forward linearly after the DTW-aligned span ends.
      targetIdx = lastB + (i - lastA);
    } else {
      targetIdx = firstB;
    }
    map[i] = Math.max(0, Math.min(maxOtherIndex, targetIdx));
  }
  return map;
}

/**
 * Picks the highest-count in-bounds beat offset `delta` for a section,
 * optionally filtering to deltas whose median distance from `syncedOtherIndices`
 * exceeds `minSyncSeparation`.
 */
function pickSectionDelta(
  list: BeatWithSim[],
  counter: Map<number, number>,
  maxOtherIndex: number,
  syncedOtherIndices: number[],
  minSyncSeparation: number,
): number {
  const pickFrom = (requireSeparation: boolean): number | null => {
    let bestDelta: number | null = null;
    let bestCount = -1;
    for (const [delta, count] of counter) {
      const hasInBoundsBeat = list.some((beat) => {
        const target = beat.which - delta;
        return target >= 0 && target <= maxOtherIndex;
      });
      if (!hasInBoundsBeat) {
        continue;
      }
      if (requireSeparation) {
        const offsets = list
          .map((beat) => {
            const clampedTarget = Math.max(
              0,
              Math.min(maxOtherIndex, beat.which - delta),
            );
            return Math.abs(clampedTarget - (syncedOtherIndices[beat.which] ?? 0));
          })
          .sort((a, b) => a - b);
        const medianOffset = offsets[Math.floor(offsets.length / 2)] ?? 0;
        if (medianOffset <= minSyncSeparation) {
          continue;
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestDelta = delta;
      }
    }
    return bestDelta;
  };

  if (minSyncSeparation >= 0) {
    const separated = pickFrom(true);
    if (separated !== null) {
      return separated;
    }
  }
  return pickFrom(false) ?? 0;
}

/**
 * Pairs every beat of `mainBeats` with a beat in `otherBeats` according to the
 * selected alignment mode and applies seam ducking across discontinuous jumps.
 */
function applyDualAlignment(
  mainBeats: BeatWithSim[],
  otherBeats: BeatWithSim[],
  mode: AutocanonizerMixAlignmentMode,
) {
  const featuresA = extractTrackBeatFeatures(mainBeats);
  const featuresB = extractTrackBeatFeatures(otherBeats);
  const syncedOtherIndices = buildCoverSyncIndexMap(
    featuresA,
    featuresB,
    mainBeats.length,
    otherBeats.length,
  );
  const maxOtherIndex = otherBeats.length - 1;
  const sections = new Map<number, BeatWithSim[]>();
  for (const beat of mainBeats) {
    const list = sections.get(beat.section) ?? [];
    list.push(beat);
    sections.set(beat.section, list);
  }

  if (mode === "cover-sync") {
    // Compute Song 1's self-similarity canon first, then project those canon
    // targets onto Song 2 through the DTW cover-sync map so covers canonize
    // across sections rather than playing in unison.
    calculateNearestNeighbors(mainBeats);
    foldBySection(mainBeats);

    for (const [, list] of sections) {
      if (!list.length) {
        continue;
      }
      const counter = new Map<number, number>();
      for (const beat of list) {
        const syncedTarget = syncedOtherIndices[beat.other.which] ?? 0;
        const delta = beat.which - syncedTarget;
        counter.set(delta, (counter.get(delta) ?? 0) + 1);
      }
      const bestDelta = pickSectionDelta(
        list,
        counter,
        maxOtherIndex,
        syncedOtherIndices,
        -1,
      );
      for (const beat of list) {
        const clampedIdx = Math.max(
          0,
          Math.min(maxOtherIndex, beat.which - bestDelta),
        );
        beat.other = otherBeats[clampedIdx];
        beat.otherGain = 1;
      }
    }
    applyOtherSeamDucking(mainBeats);
    return;
  }

  // Section Fold mode: match each beat in Song 1 to its closest non-unison
  // beat in Song 2 using cover-normalized features, then fold by section.
  const exclusionRadius = Math.min(4, Math.floor((otherBeats.length - 1) / 4));
  for (let i = 0; i < mainBeats.length; i += 1) {
    const beat = mainBeats[i];
    const featA = featuresA[i];
    const syncedIndex = syncedOtherIndices[i] ?? 0;
    const findBest = (enforceExclusion: boolean) => {
      let best: BeatWithSim | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let j = 0; j < otherBeats.length; j += 1) {
        if (enforceExclusion && Math.abs(j - syncedIndex) <= exclusionRadius) {
          continue;
        }
        const other = otherBeats[j];
        const barPenalty =
          beat.indexInParent === other.indexInParent
            ? 0
            : SECTION_FOLD_BAR_MISMATCH_PENALTY;
        const dist = computeCoverBeatDistance(featA, featuresB[j]) + barPenalty;
        if (dist < bestDist) {
          bestDist = dist;
          best = other;
        }
      }
      return { best, bestDist };
    };

    let result = findBest(true);
    if (!result.best) {
      result = findBest(false);
    }
    beat.sim = result.best ?? undefined;
    beat.simDistance = Number.isFinite(result.bestDist)
      ? result.bestDist
      : undefined;
  }

  for (const [, list] of sections) {
    if (!list.length) {
      continue;
    }
    const counter = new Map<number, number>();
    for (const beat of list) {
      if (!beat.sim) {
        continue;
      }
      const delta = beat.which - beat.sim.which;
      counter.set(delta, (counter.get(delta) ?? 0) + 1);
    }
    const bestDelta = pickSectionDelta(
      list,
      counter,
      maxOtherIndex,
      syncedOtherIndices,
      exclusionRadius,
    );
    for (const beat of list) {
      const clampedIdx = Math.max(
        0,
        Math.min(maxOtherIndex, beat.which - bestDelta),
      );
      beat.other = otherBeats[clampedIdx];
      beat.otherGain = 1;
    }
  }
  applyOtherSeamDucking(mainBeats);
}

/**
 * Ducks the secondary voice gain at discontinuous jumps so transitions between
 * non-consecutive beats cross-fade smoothly.
 */
function applyOtherSeamDucking(beats: BeatWithSim[]) {
  for (const beat of beats) {
    const prev = beat.prev as BeatWithSim | null;
    const next = beat.next as BeatWithSim | null;
    if (prev?.other && prev.other.which + 1 !== beat.other.which) {
      prev.otherGain = 0.5;
      beat.otherGain = 0.5;
    }
    if (next?.other && next.other.which - 1 !== beat.other.which) {
      next.otherGain = 0.5;
      beat.otherGain = 0.5;
    }
  }
}

function getSectionIndex(beat: QuantumBase) {
  let current: QuantumBase | undefined = beat;
  while (current?.parent) {
    current = current.parent;
  }
  return current?.which ?? 0;
}

function calculateNearestNeighbors(beats: BeatWithSim[]) {
  for (const beat of beats) {
    let best: BeatWithSim | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const other of beats) {
      if (beat === other) {
        continue;
      }
      const distance = compareBeats(beat, other);
      if (distance > 0 && distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    beat.sim = best ?? undefined;
    beat.simDistance = Number.isFinite(bestDistance) ? bestDistance : undefined;
  }
}

function compareBeats(a: BeatWithSim, b: BeatWithSim) {
  if (!a.overlappingSegments.length || !b.overlappingSegments.length) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < a.overlappingSegments.length; i += 1) {
    const seg1 = a.overlappingSegments[i];
    const seg2 = b.overlappingSegments[i];
    const distance = seg2 ? segmentDistance(seg1, seg2) : 100;
    sum += distance;
  }
  const parentDistance = a.indexInParent === b.indexInParent ? 0 : 100;
  return sum / a.overlappingSegments.length + parentDistance;
}

function segmentDistance(a: Segment, b: Segment) {
  const timbre = euclideanDistance(a.timbre, b.timbre) * TIMBRE_WEIGHT;
  const pitch = euclideanDistance(a.pitches, b.pitches) * PITCH_WEIGHT;
  const loudStart = Math.abs(a.loudness_start - b.loudness_start) * LOUD_START_WEIGHT;
  const loudMax = Math.abs(a.loudness_max - b.loudness_max) * LOUD_MAX_WEIGHT;
  const duration = Math.abs(a.duration - b.duration) * DURATION_WEIGHT;
  const confidence = Math.abs(a.confidence - b.confidence) * CONFIDENCE_WEIGHT;
  return timbre + pitch + loudStart + loudMax + duration + confidence;
}

function euclideanDistance(v1: number[], v2: number[]) {
  let sum = 0;
  const len = Math.min(v1.length, v2.length);
  for (let i = 0; i < len; i += 1) {
    const delta = v2[i] - v1[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function foldBySection(beats: BeatWithSim[]) {
  const sections = new Map<number, BeatWithSim[]>();
  for (const beat of beats) {
    const list = sections.get(beat.section) ?? [];
    list.push(beat);
    sections.set(beat.section, list);
  }
  for (const [, list] of sections) {
    if (!list.length) {
      continue;
    }
    const counter = new Map<number, number>();
    for (const beat of list) {
      if (!beat.sim) {
        continue;
      }
      const delta = beat.which - beat.sim.which;
      counter.set(delta, (counter.get(delta) ?? 0) + 1);
    }
    let bestDelta = 0;
    let bestCount = -1;
    for (const [delta, count] of counter) {
      if (count > bestCount) {
        bestCount = count;
        bestDelta = delta;
      }
    }
    for (const beat of list) {
      const otherIndex = beat.which - bestDelta;
      if (otherIndex >= 0 && otherIndex < beats.length) {
        beat.other = beats[otherIndex];
      } else {
        beat.other = beat;
      }
      beat.otherGain = 1;
    }
  }
  applyOtherSeamDucking(beats);
}

function assignNormalizedVolumes(beats: BeatWithSim[]) {
  let min = 0;
  let max = -60;
  for (const beat of beats) {
    const volume = averageVolume(beat);
    beat.volume = volume;
    if (volume > max) {
      max = volume;
    }
    if (volume < min) {
      min = volume;
    }
  }
  for (const beat of beats) {
    beat.volume = interpolate(beat.volume, min, max);
  }
  calcWindowMedian(beats, VOLUME_WINDOW);
}

function averageVolume(beat: BeatWithSim) {
  if (beat.overlappingSegments.length) {
    let sum = 0;
    for (const seg of beat.overlappingSegments) {
      sum += seg.loudness_max;
    }
    return sum / beat.overlappingSegments.length;
  }
  return -60;
}

function interpolate(value: number, min: number, max: number) {
  if (min === max) {
    return min;
  }
  return (value - min) / (max - min);
}

function calcWindowMedian(beats: BeatWithSim[], windowSize: number) {
  for (const beat of beats) {
    const vals: number[] = [];
    for (let i = 0; i < windowSize; i += 1) {
      const offset = i - Math.floor(windowSize / 2);
      const idx = beat.which - offset;
      if (idx >= 0 && idx < beats.length) {
        vals.push(beats[idx].volume);
      }
    }
    vals.sort((a, b) => a - b);
    beat.median_volume = vals[Math.floor(vals.length / 2)] ?? beat.volume;
  }
}
