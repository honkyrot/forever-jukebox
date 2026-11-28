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
  QUAD_BRANCH_BLEND,
  QUAD_MAIN_BLEND,
  QUAD_SYNC_MAX_SKEW_DELTA,
  SINGLE_QUAD_BRANCH_BLEND,
  SINGLE_QUAD_MAIN_BLEND,
  TRIO_BRANCH_BLEND,
  TRIO_MAIN_BLEND,
  planCanonizerRender,
  type CanonizerRenderPlan,
} from "./canonizerRenderPlan";
import { computeBeatColors } from "../engine/beatColors";
import {
  alignTrackPairMultiSectionDtw,
  computeCoverBeatDistance,
  extractTrackBeatFeatures,
} from "../engine/coverSync";
import { clampVolume } from "../audio/volume";

type BeatWithSim = CanonizerBeat & {
  sim?: CanonizerBeat;
  simDistance?: number;
};

export type AutocanonizerMixAlignmentMode = "cover-sync" | "section-fold";
export type AutocanonizerQuadBranchMode = "synced" | "independent";
export type AutocanonizerSingleVoiceCount = 2 | 3 | 4;

export type AutocanonizerDualAnalysisOptions = {
  mainDuration?: number | null;
  otherDuration?: number | null;
  otherTempoRatio?: number;
  alignmentMode?: AutocanonizerMixAlignmentMode;
  quadMode?: boolean;
  quadBranchMode?: AutocanonizerQuadBranchMode;
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
  pinkSeconds?: number | null;
  goldSeconds?: number | null;
};

export type AutocanonizerLiveCursorTimes = {
  mainSeconds: number | null;
  otherSeconds: number | null;
  pinkSeconds?: number | null;
  goldSeconds?: number | null;
  inUnison: boolean;
};

class AutocanonizerPlayer {
  private readonly context: AudioContext;
  private buffer: AudioBuffer;
  private otherBuffer: AudioBuffer | null = null;
  private readonly mainGain: GainNode;
  private readonly otherGain: GainNode;
  private readonly pinkGain: GainNode;
  private readonly goldGain: GainNode;
  private readonly mainPanner: StereoPannerNode | null;
  private readonly otherPanner: StereoPannerNode | null;
  private readonly pinkPanner: StereoPannerNode | null;
  private readonly goldPanner: StereoPannerNode | null;
  private readonly masterBlend: number;
  private quadMode = false;
  private singleVoiceCount: AutocanonizerSingleVoiceCount = 2;
  private baseVolume = 1;
  private mainStreamPan = 0;
  private otherStreamPan = 0;
  private pinkStreamPan = 0;
  private goldStreamPan = 0;
  private mainStreamGain = 1;
  private otherStreamGain = 1;
  private pinkStreamGain = 1;
  private goldStreamGain = 1;
  private otherBeatGain = 1;
  private pinkBeatGain = 1;
  private goldBeatGain = 1;

  private currentBeat: CanonizerBeat | null = null;
  private lastFinishOutOther: CanonizerBeat | null = null;
  private lastFinishOutGold: CanonizerBeat | null = null;
  private lastFinishOutPink: CanonizerBeat | null = null;
  private mainSource: AudioBufferSourceNode | null = null;
  private otherSource: AudioBufferSourceNode | null = null;
  private pinkSource: AudioBufferSourceNode | null = null;
  private goldSource: AudioBufferSourceNode | null = null;
  private deltaTime = 0;
  private otherDeltaTime = 0;
  private pinkDeltaTime = 0;
  private goldDeltaTime = 0;
  private skewDelta = 0;
  private pinkSkewDelta = 0;
  private goldSkewDelta = 0;
  private readonly maxSkewDelta = CANONIZER_MAX_SKEW_DELTA;

  constructor(
    context: AudioContext,
    buffer: AudioBuffer,
    masterBlend = CANONIZER_MASTER_BLEND,
  ) {
    this.context = context;
    this.buffer = buffer;
    this.masterBlend = masterBlend;
    // Keep mainGain and otherGain first so single-song callers/tests see indices 0 and 1.
    this.mainGain = this.context.createGain();
    this.otherGain = this.context.createGain();
    this.pinkGain = this.context.createGain();
    this.goldGain = this.context.createGain();
    const createPanner = () =>
      typeof this.context.createStereoPanner === "function"
        ? this.context.createStereoPanner()
        : null;
    this.mainPanner = createPanner();
    this.otherPanner = createPanner();
    this.pinkPanner = createPanner();
    this.goldPanner = createPanner();
    this.mainPanner?.connect(this.mainGain);
    this.otherPanner?.connect(this.otherGain);
    this.pinkPanner?.connect(this.pinkGain);
    this.goldPanner?.connect(this.goldGain);
    this.mainGain.connect(this.context.destination);
    this.otherGain.connect(this.context.destination);
    this.pinkGain.connect(this.context.destination);
    this.goldGain.connect(this.context.destination);
    this.applyGains();
    this.applyPans();
  }

  /**
   * Enables or disables 4-voice quad playback, stopping secondary Song 2
   * sources when returning to 2-voice mode.
   */
  setQuadMode(enabled: boolean) {
    this.quadMode = enabled;
    if (!enabled) {
      if (this.singleVoiceCount < 4) {
        this.stopSource(this.pinkSource);
        this.pinkSource = null;
        this.pinkSkewDelta = 0;
      }
      if (this.singleVoiceCount < 3) {
        this.stopSource(this.goldSource);
        this.goldSource = null;
        this.goldSkewDelta = 0;
      }
    }
    this.applyGains();
  }

  /**
   * Sets the single-song Autocanonizer voice count (2, 3, or 4), stopping Gold
   * or Pink sources when voices are disabled (unless dual quad mode owns them).
   */
  setSingleSongVoiceCount(count: AutocanonizerSingleVoiceCount) {
    this.singleVoiceCount = count;
    if (!this.quadMode) {
      if (count < 3) {
        this.stopSource(this.goldSource);
        this.goldSource = null;
        this.goldSkewDelta = 0;
      }
      if (count < 4) {
        this.stopSource(this.pinkSource);
        this.pinkSource = null;
        this.pinkSkewDelta = 0;
      }
    }
    this.applyGains();
  }

  /**
   * Enables or disables 3-voice single-song trio playback, stopping Gold when
   * returning to 2-voice mode (unless 4-voice quad mode owns Gold).
   */
  setTrioMode(enabled: boolean) {
    this.setSingleSongVoiceCount(enabled ? 3 : 2);
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

  /**
   * Returns the main and optional secondary AudioBuffers currently assigned to the player.
   */
  getBuffers(): { mainBuffer: AudioBuffer; otherBuffer: AudioBuffer | null } {
    return {
      mainBuffer: this.buffer,
      otherBuffer: this.otherBuffer,
    };
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
   * Sets L/R stereo pans (-1 to 1) for Song 2's Pink and Gold voices in quad mode.
   */
  setQuadStreamPans(pink: number, gold: number) {
    this.pinkStreamPan = clampPan(pink);
    this.goldStreamPan = clampPan(gold);
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

  /**
   * Sets per-stream linear volume trim multipliers (0–2) for Song 2's Pink and
   * Gold voices in quad mode.
   */
  setQuadStreamGains(pink: number, gold: number) {
    this.pinkStreamGain = clampStreamGain(pink, this.pinkStreamGain);
    this.goldStreamGain = clampStreamGain(gold, this.goldStreamGain);
    this.applyGains();
  }

  reset() {
    this.stop();
    this.currentBeat = null;
    this.lastFinishOutOther = null;
    this.lastFinishOutGold = null;
    this.lastFinishOutPink = null;
    this.deltaTime = 0;
    this.otherDeltaTime = 0;
    this.pinkDeltaTime = 0;
    this.goldDeltaTime = 0;
    this.skewDelta = 0;
    this.pinkSkewDelta = 0;
    this.goldSkewDelta = 0;
  }

  private stopSource(source: AudioBufferSourceNode | null) {
    if (!source) {
      return;
    }
    try {
      source.stop(0);
    } catch {
      // no-op
    }
    source.disconnect();
  }

  stop() {
    this.lastFinishOutOther = null;
    this.lastFinishOutGold = null;
    this.lastFinishOutPink = null;
    this.stopSource(this.mainSource);
    this.mainSource = null;
    this.stopSource(this.otherSource);
    this.otherSource = null;
    this.stopSource(this.pinkSource);
    this.pinkSource = null;
    this.stopSource(this.goldSource);
    this.goldSource = null;
  }

  stopMain(keepGold = false, keepPink = false) {
    this.stopSource(this.mainSource);
    this.mainSource = null;
    if (!keepPink) {
      this.stopSource(this.pinkSource);
      this.pinkSource = null;
    }
    if (!keepGold) {
      this.stopSource(this.goldSource);
      this.goldSource = null;
    }
  }

  /**
   * Computes continuous AudioContext-anchored playback times (seconds) for the
   * Blue (main), Green (canon/other), Gold, and optional Pink voices.
   */
  getLiveCursorTimes(secondaryOnly: boolean): AutocanonizerLiveCursorTimes {
    if (!this.currentBeat) {
      return { mainSeconds: null, otherSeconds: null, inUnison: false };
    }
    const now = this.context.currentTime;
    const clampTime = (val: number, maxDur: number) =>
      Math.max(0, Number.isFinite(maxDur) && maxDur > 0 ? Math.min(maxDur, val) : val);
    const otherBuf = this.quadMode
      ? this.buffer
      : (this.otherBuffer ?? this.buffer);
    const mainSeconds =
      !secondaryOnly && this.mainSource
        ? clampTime(now - this.deltaTime, this.buffer.duration)
        : null;
    const otherSeconds =
      this.otherSource && this.otherBeatGain > 0
        ? clampTime(now - this.otherDeltaTime, otherBuf.duration)
        : null;
    const inUnison =
      !secondaryOnly &&
      this.currentBeat.other === this.currentBeat &&
      otherSeconds !== null;
    if (!this.quadMode && this.singleVoiceCount >= 3) {
      const goldSeconds =
        this.goldSource && this.goldBeatGain > 0
          ? clampTime(now - this.goldDeltaTime, this.buffer.duration)
          : null;
      if (this.singleVoiceCount >= 4) {
        const pinkSeconds =
          this.pinkSource && this.pinkBeatGain > 0
            ? clampTime(now - this.pinkDeltaTime, this.buffer.duration)
            : null;
        return {
          mainSeconds,
          otherSeconds,
          goldSeconds,
          pinkSeconds,
          inUnison,
        };
      }
      return { mainSeconds, otherSeconds, goldSeconds, inUnison };
    }
    return { mainSeconds, otherSeconds, inUnison };
  }

  playBeat(beat: CanonizerBeat) {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    this.lastFinishOutOther = null;
    this.lastFinishOutGold = null;
    this.lastFinishOutPink = null;
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
    // In quad mode, Green (other) is Song 1's own canon branch; otherwise it plays Song 2.
    const otherBuf = this.quadMode
      ? this.buffer
      : (this.otherBuffer ?? this.buffer);
    if (clampedOtherGain === 0) {
      // Stop silent voice during unmatched solo sections so its last beat does not repeat.
      this.stopSource(this.otherSource);
      this.otherSource = null;
      this.skewDelta = 0;
    } else if (
      !this.otherSource ||
      this.currentBeat?.otherGain === 0 ||
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
    if (clampedOtherGain > 0) {
      this.skewDelta += beat.duration - beat.other.duration;
    }

    if (this.quadMode && beat.pink && beat.gold) {
      const song2Buf = this.otherBuffer ?? this.buffer;
      this.stepPinkVoice(
        beat,
        song2Buf,
        beat.pinkGain ?? 1,
        QUAD_SYNC_MAX_SKEW_DELTA,
      );
      this.stepGoldVoice(beat, song2Buf, beat.goldGain ?? 1);
    } else if (!this.quadMode && this.singleVoiceCount >= 3) {
      this.stepGoldVoice(beat, this.buffer, beat.goldGain ?? 0);
      if (this.singleVoiceCount >= 4) {
        this.stepPinkVoice(
          beat,
          this.buffer,
          beat.pinkGain ?? 0,
          this.maxSkewDelta,
        );
      }
    }

    this.currentBeat = beat;
    return beat.duration - delta;
  }

  private stepPinkVoice(
    beat: CanonizerBeat,
    pinkBuf: AudioBuffer,
    rawPinkGain: number,
    maxSkew: number,
  ) {
    if (!beat.pink) {
      this.pinkBeatGain = 0;
      this.applyPinkGain();
      this.stopSource(this.pinkSource);
      this.pinkSource = null;
      this.pinkSkewDelta = 0;
      return;
    }
    this.pinkBeatGain = Math.max(0, Math.min(1, rawPinkGain));
    this.applyPinkGain();
    if (this.pinkBeatGain === 0) {
      this.stopSource(this.pinkSource);
      this.pinkSource = null;
      this.pinkSkewDelta = 0;
      return;
    }
    if (
      !this.pinkSource ||
      (this.currentBeat?.pinkGain ?? 0) === 0 ||
      this.currentBeat?.pink?.next !== beat.pink ||
      Math.abs(this.pinkSkewDelta) > maxSkew
    ) {
      this.pinkSkewDelta = 0;
      if (this.pinkSource) {
        this.pinkSource.stop();
      }
      const pinkDur = pinkBuf.duration - beat.pink.start;
      this.pinkSource = this.playBuffer(
        pinkBuf,
        beat.pink.start,
        pinkDur,
        this.pinkPanner ?? this.pinkGain,
      );
      this.pinkDeltaTime = this.context.currentTime - beat.pink.start;
    }
    this.pinkSkewDelta += beat.duration - beat.pink.duration;
  }

  private stepGoldVoice(
    beat: CanonizerBeat,
    goldBuf: AudioBuffer,
    rawGoldGain: number,
  ) {
    if (!beat.gold) {
      this.goldBeatGain = 0;
      this.applyGoldGain();
      this.stopSource(this.goldSource);
      this.goldSource = null;
      this.goldSkewDelta = 0;
      return;
    }
    this.goldBeatGain = Math.max(0, Math.min(1, rawGoldGain));
    this.applyGoldGain();
    if (this.goldBeatGain === 0) {
      this.stopSource(this.goldSource);
      this.goldSource = null;
      this.goldSkewDelta = 0;
      return;
    }
    if (
      !this.goldSource ||
      (this.currentBeat?.goldGain ?? 0) === 0 ||
      this.currentBeat?.gold?.next !== beat.gold ||
      Math.abs(this.goldSkewDelta) > this.maxSkewDelta
    ) {
      this.goldSkewDelta = 0;
      if (this.goldSource) {
        this.goldSource.stop();
      }
      const goldDur = goldBuf.duration - beat.gold.start;
      this.goldSource = this.playBuffer(
        goldBuf,
        beat.gold.start,
        goldDur,
        this.goldPanner ?? this.goldGain,
      );
      this.goldDeltaTime = this.context.currentTime - beat.gold.start;
    }
    this.goldSkewDelta += beat.duration - beat.gold.duration;
  }

  playOtherOnly(beat: CanonizerBeat) {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    const clampedOtherGain = Math.max(0, Math.min(1, beat.otherGain));
    this.otherBeatGain = clampedOtherGain;
    this.applyOtherGain();
    const otherBuf = this.quadMode
      ? this.buffer
      : (this.otherBuffer ?? this.buffer);
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

  /**
   * Advances active canon branches (Green, Gold, and Pink) during single-song
   * multi-voice finish-out until all active streams reach the end of the track.
   */
  playFinishOutBeat(
    otherBeat: CanonizerBeat | null,
    goldBeat: CanonizerBeat | null,
    pinkBeat: CanonizerBeat | null = null,
  ): number {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    const clockBeat = otherBeat ?? goldBeat ?? pinkBeat;
    if (otherBeat) {
      this.otherBeatGain = Math.max(0, Math.min(1, otherBeat.otherGain));
      this.applyOtherGain();
      if (!this.otherSource || this.lastFinishOutOther?.next !== otherBeat) {
        if (this.otherSource) {
          this.otherSource.stop();
        }
        const duration = this.buffer.duration - otherBeat.start;
        this.otherSource = this.playBuffer(
          this.buffer,
          otherBeat.start,
          duration,
          this.otherPanner ?? this.otherGain,
        );
        this.otherDeltaTime = this.context.currentTime - otherBeat.start;
      }
    } else {
      this.stopSource(this.otherSource);
      this.otherSource = null;
      this.otherBeatGain = 0;
      this.applyOtherGain();
    }

    if (goldBeat) {
      this.goldBeatGain = 1;
      this.applyGoldGain();
      const isClock = !otherBeat;
      const needsResync = isClock
        ? !this.goldSource || this.lastFinishOutGold?.next !== goldBeat
        : !this.goldSource ||
          this.lastFinishOutGold?.next !== goldBeat ||
          Math.abs(this.goldSkewDelta) > this.maxSkewDelta;
      if (needsResync) {
        this.goldSkewDelta = 0;
        if (this.goldSource) {
          this.goldSource.stop();
        }
        const goldDur = this.buffer.duration - goldBeat.start;
        this.goldSource = this.playBuffer(
          this.buffer,
          goldBeat.start,
          goldDur,
          this.goldPanner ?? this.goldGain,
        );
        this.goldDeltaTime = this.context.currentTime - goldBeat.start;
      }
      if (!isClock && clockBeat) {
        this.goldSkewDelta += clockBeat.duration - goldBeat.duration;
      }
    } else {
      this.stopSource(this.goldSource);
      this.goldSource = null;
      this.goldBeatGain = 0;
      this.goldSkewDelta = 0;
      this.applyGoldGain();
    }

    if (pinkBeat) {
      this.pinkBeatGain = 1;
      this.applyPinkGain();
      const isClock = !otherBeat && !goldBeat;
      const needsResync = isClock
        ? !this.pinkSource || this.lastFinishOutPink?.next !== pinkBeat
        : !this.pinkSource ||
          this.lastFinishOutPink?.next !== pinkBeat ||
          Math.abs(this.pinkSkewDelta) > this.maxSkewDelta;
      if (needsResync) {
        this.pinkSkewDelta = 0;
        if (this.pinkSource) {
          this.pinkSource.stop();
        }
        const pinkDur = this.buffer.duration - pinkBeat.start;
        this.pinkSource = this.playBuffer(
          this.buffer,
          pinkBeat.start,
          pinkDur,
          this.pinkPanner ?? this.pinkGain,
        );
        this.pinkDeltaTime = this.context.currentTime - pinkBeat.start;
      }
      if (!isClock && clockBeat) {
        this.pinkSkewDelta += clockBeat.duration - pinkBeat.duration;
      }
    } else {
      this.stopSource(this.pinkSource);
      this.pinkSource = null;
      this.pinkBeatGain = 0;
      this.pinkSkewDelta = 0;
      this.applyPinkGain();
    }

    this.lastFinishOutOther = otherBeat;
    this.lastFinishOutGold = goldBeat;
    this.lastFinishOutPink = pinkBeat;

    if (otherBeat) {
      const now = this.context.currentTime - this.otherDeltaTime;
      const delta = now - otherBeat.start;
      return otherBeat.duration - delta;
    }
    if (goldBeat) {
      const now = this.context.currentTime - this.goldDeltaTime;
      const delta = now - goldBeat.start;
      return goldBeat.duration - delta;
    }
    if (pinkBeat) {
      const now = this.context.currentTime - this.pinkDeltaTime;
      const delta = now - pinkBeat.start;
      return pinkBeat.duration - delta;
    }
    return 0;
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
    const mainWeight = this.quadMode
      ? QUAD_MAIN_BLEND
      : this.singleVoiceCount === 4
        ? SINGLE_QUAD_MAIN_BLEND
        : this.singleVoiceCount === 3
          ? TRIO_MAIN_BLEND
          : this.masterBlend;
    this.mainGain.gain.value =
      this.baseVolume * mainWeight * this.mainStreamGain;
    this.applyOtherGain();
    this.applyPinkGain();
    this.applyGoldGain();
  }

  private applyOtherGain() {
    const otherWeight = this.quadMode
      ? QUAD_BRANCH_BLEND
      : this.singleVoiceCount === 4
        ? SINGLE_QUAD_BRANCH_BLEND
        : this.singleVoiceCount === 3
          ? TRIO_BRANCH_BLEND
          : 1 - this.masterBlend;
    this.otherGain.gain.value =
      this.baseVolume * otherWeight * this.otherStreamGain * this.otherBeatGain;
  }

  private applyPinkGain() {
    const pinkWeight = this.quadMode
      ? QUAD_MAIN_BLEND
      : this.singleVoiceCount === 4
        ? SINGLE_QUAD_BRANCH_BLEND
        : 0;
    this.pinkGain.gain.value =
      pinkWeight > 0
        ? this.baseVolume * pinkWeight * this.pinkStreamGain * this.pinkBeatGain
        : 0;
  }

  private applyGoldGain() {
    const goldWeight = this.quadMode
      ? QUAD_BRANCH_BLEND
      : this.singleVoiceCount === 4
        ? SINGLE_QUAD_BRANCH_BLEND
        : this.singleVoiceCount === 3
          ? TRIO_BRANCH_BLEND
          : 0;
    this.goldGain.gain.value =
      goldWeight > 0
        ? this.baseVolume * goldWeight * this.goldStreamGain * this.goldBeatGain
        : 0;
  }

  private applyPans() {
    if (this.mainPanner) {
      this.mainPanner.pan.value = this.mainStreamPan;
    }
    if (this.otherPanner) {
      this.otherPanner.pan.value = this.otherStreamPan;
    }
    if (this.pinkPanner) {
      this.pinkPanner.pan.value = this.pinkStreamPan;
    }
    if (this.goldPanner) {
      this.goldPanner.pan.value = this.goldStreamPan;
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
  private quadMode = false;
  private quadBranchMode: AutocanonizerQuadBranchMode = "synced";
  private singleVoiceCount: AutocanonizerSingleVoiceCount = 2;
  private player: AutocanonizerPlayer | null = null;
  private running = false;
  private timerId: number | null = null;
  private secondaryOnly = false;
  private secondaryIndex = 0;
  private tertiaryIndex: number | null = null;
  private quaternaryIndex: number | null = null;
  private finishOutSong = false;
  private currentIndex = 0;
  private mainStreamPan = 0;
  private otherStreamPan = 0;
  private pinkStreamPan = 0;
  private goldStreamPan = 0;
  private mainStreamGain = 1;
  private otherStreamGain = 1;
  private pinkStreamGain = 1;
  private goldStreamGain = 1;
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

  /**
   * Sets L/R stereo pans (-1 to 1) for Song 2's Pink and Gold voices in quad mode.
   */
  setQuadStreamPans(pink: number, gold: number) {
    this.pinkStreamPan = clampPan(pink);
    this.goldStreamPan = clampPan(gold);
    this.player?.setQuadStreamPans(this.pinkStreamPan, this.goldStreamPan);
  }

  /**
   * Sets per-stream linear volume trim multipliers (0–2) for Song 2's Pink and
   * Gold voices in quad mode.
   */
  setQuadStreamGains(pink: number, gold: number) {
    this.pinkStreamGain = clampStreamGain(pink, this.pinkStreamGain);
    this.goldStreamGain = clampStreamGain(gold, this.goldStreamGain);
    this.player?.setQuadStreamGains(this.pinkStreamGain, this.goldStreamGain);
  }

  /**
   * Toggles 4-voice quad mode (Song 1 on Blue+Green, Song 2 on Pink+Gold) for
   * an active 2-song Autocanonizer mix and updates playback and visuals live.
   */
  setQuadMode(enabled: boolean) {
    this.quadMode = enabled;
    this.player?.setQuadMode(enabled);
    if (!this.beats.length || !this.otherBeats.length) {
      return;
    }
    this.applyActiveDualOrQuadAlignment();
    this.refreshDualVizAndPlayback();
  }

  /**
   * Switches whether Gold mirrors Green ("synced") or follows Song 2's own
   * canon ("independent") when 4-voice quad mode is active.
   */
  setQuadBranchMode(mode: AutocanonizerQuadBranchMode) {
    this.quadBranchMode = mode;
    if (!this.quadMode || !this.beats.length || !this.otherBeats.length) {
      return;
    }
    this.applyActiveDualOrQuadAlignment();
    this.refreshDualVizAndPlayback();
  }

  /**
   * Sets the single-song Autocanonizer voice count (2 = Blue+Green, 3 = +Gold,
   * 4 = +Gold+Pink) and updates playback and visuals live without affecting
   * 2-song mix sessions.
   */
  setSingleSongVoiceCount(count: AutocanonizerSingleVoiceCount) {
    this.singleVoiceCount = count;
    const isSingleSong = this.otherBeats.length === 0;
    this.player?.setSingleSongVoiceCount(isSingleSong ? count : 2);
    if (!this.beats.length || !isSingleSong) {
      return;
    }
    if (count === 3 || count === 4) {
      applyMultiVoiceAlignment(this.beats, count);
    } else {
      for (const beat of this.beats) {
        beat.gold = undefined;
        beat.goldGain = undefined;
        beat.pink = undefined;
        beat.pinkGain = undefined;
      }
    }
    this.viz.setData(this.beats, this.mainDuration, this.mainSections, count);
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

  /**
   * Toggles 3-voice single-song trio mode (Blue + Green + runner-up Gold) and
   * updates playback and visuals live without affecting 2-song mix sessions.
   */
  setTrioMode(enabled: boolean) {
    this.setSingleSongVoiceCount(enabled ? 3 : 2);
  }

  setAudio(buffer: AudioBuffer | null, context: AudioContext | null) {
    if (buffer && context) {
      if (!this.player) {
        this.player = new AutocanonizerPlayer(context, buffer);
        this.player.setStreamPans(this.mainStreamPan, this.otherStreamPan);
        this.player.setStreamGains(this.mainStreamGain, this.otherStreamGain);
        this.player.setQuadStreamPans(this.pinkStreamPan, this.goldStreamPan);
        this.player.setQuadStreamGains(this.pinkStreamGain, this.goldStreamGain);
        this.player.setQuadMode(false);
        this.player.setSingleSongVoiceCount(this.singleVoiceCount);
        this.player.setVolume(this.volume);
      } else {
        this.player.setBuffers(buffer, null);
        this.player.setQuadMode(false);
        this.player.setSingleSongVoiceCount(this.singleVoiceCount);
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
        this.player.setQuadStreamPans(this.pinkStreamPan, this.goldStreamPan);
        this.player.setQuadStreamGains(this.pinkStreamGain, this.goldStreamGain);
        this.player.setQuadMode(this.quadMode);
        this.player.setSingleSongVoiceCount(2);
        this.player.setVolume(this.volume);
      } else {
        this.player.setBuffers(mainBuffer, otherBuffer);
        this.player.setQuadMode(this.quadMode);
        this.player.setSingleSongVoiceCount(2);
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
    this.quadMode = false;
    this.player?.setQuadMode(false);
    this.player?.setSingleSongVoiceCount(this.singleVoiceCount);
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
    if (this.singleVoiceCount === 3 || this.singleVoiceCount === 4) {
      applyMultiVoiceAlignment(beats, this.singleVoiceCount);
    }
    this.beats = beats;
    this.mainDuration = trackDuration;
    this.mainSections = analysis.sections.map((section) => ({
      start: section.start,
      duration: section.duration,
    }));
    this.viz.setData(
      beats,
      trackDuration,
      this.mainSections,
      this.singleVoiceCount,
    );
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
    this.quadMode = options?.quadMode ?? this.quadMode;
    this.quadBranchMode = options?.quadBranchMode ?? this.quadBranchMode;
    this.player?.setQuadMode(this.quadMode);
    this.player?.setSingleSongVoiceCount(2);

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

    this.applyActiveDualOrQuadAlignment();
    this.viz.setDualData(
      this.beats,
      this.mainDuration,
      this.mainSections,
      this.otherBeats,
      this.otherDuration,
      this.otherSections,
      this.quadMode,
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
    this.applyActiveDualOrQuadAlignment();
    this.refreshDualVizAndPlayback();
  }

  private applyActiveDualOrQuadAlignment() {
    if (this.quadMode) {
      applyQuadAlignment(this.beats, this.otherBeats, this.quadBranchMode);
    } else {
      applyDualAlignment(this.beats, this.otherBeats, this.dualAlignmentMode);
    }
  }

  private refreshDualVizAndPlayback() {
    this.viz.setDualData(
      this.beats,
      this.mainDuration,
      this.mainSections,
      this.otherBeats,
      this.otherDuration,
      this.otherSections,
      this.quadMode,
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

  /**
   * Returns continuous live playback times for Blue (main) and Green (other)
   * while Autocanonizer playback is running, or null when stopped.
   */
  getLiveCursorTimes(): AutocanonizerLiveCursorTimes | null {
    if (!this.running || !this.player) {
      return null;
    }
    return this.player.getLiveCursorTimes(this.secondaryOnly);
  }

  /**
   * Binary-searches prepared Autocanonizer beats for the beat containing `timeSec`.
   */
  findBeatIndexByTime(timeSec: number): number {
    if (this.beats.length === 0) {
      return -1;
    }
    if (!Number.isFinite(timeSec) || timeSec <= this.beats[0].start) {
      return 0;
    }
    let low = 0;
    let high = this.beats.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.beats[mid].start <= timeSec) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return Math.max(0, Math.min(this.beats.length - 1, best));
  }

  // The canon as a timed plan for offline rendering, with the current
  // finish-out setting, stream pans/gains, and dual/quad mix state. Null until an analysis is set.
  planRender(): CanonizerRenderPlan | null {
    const isSingleSong = this.otherBeats.length === 0;
    return planCanonizerRender(this.beats, {
      finishOutSong: this.finishOutSong,
      mainPan: this.mainStreamPan,
      otherPan: this.otherStreamPan,
      mainGain: this.mainStreamGain,
      otherGain: this.otherStreamGain,
      pinkPan: this.pinkStreamPan,
      pinkGain: this.pinkStreamGain,
      goldPan: this.goldStreamPan,
      goldGain: this.goldStreamGain,
      isDual: !isSingleSong,
      quadMode: this.quadMode,
      trioMode: this.singleVoiceCount === 3 && isSingleSong,
      singleVoiceCount: isSingleSong ? this.singleVoiceCount : 2,
      otherBeats: this.otherBeats,
    });
  }

  /**
   * Returns the active main and optional secondary AudioBuffers for offline rendering.
   */
  getAudioBuffers(): {
    mainBuffer: AudioBuffer | null;
    otherBuffer: AudioBuffer | null;
  } {
    if (!this.player) {
      return { mainBuffer: null, otherBuffer: null };
    }
    return this.player.getBuffers();
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
    this.tertiaryIndex = null;
    this.quaternaryIndex = null;
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
    this.tertiaryIndex = null;
    this.quaternaryIndex = null;
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
    const isSingleSong = this.otherBeats.length === 0;
    const isSingleMulti = isSingleSong && this.singleVoiceCount >= 3;
    const isSingleQuad = isSingleSong && this.singleVoiceCount >= 4;
    const delay = this.player.playBeat(beat);
    this.viz.update(this.currentIndex);
    const cursorTimes: AutocanonizerCursorTimes = {
      mainSeconds: beat.start,
      otherSeconds: beat.other.start,
    };
    if (this.quadMode && beat.pink && beat.gold) {
      cursorTimes.pinkSeconds = beat.pink.start;
      cursorTimes.goldSeconds = beat.gold.start;
    } else if (isSingleMulti) {
      cursorTimes.goldSeconds =
        beat.gold && (beat.goldGain ?? 0) > 0 ? beat.gold.start : null;
      if (isSingleQuad) {
        cursorTimes.pinkSeconds =
          beat.pink && (beat.pinkGain ?? 0) > 0 ? beat.pink.start : null;
      }
    }
    this.onBeat?.(this.currentIndex, beat, cursorTimes);
    if (isFinal) {
      if (this.finishOutSong) {
        this.secondaryOnly = true;
        this.secondaryIndex = beat.other.which;
        if (isSingleMulti) {
          this.tertiaryIndex =
            beat.gold && (beat.goldGain ?? 0) > 0 ? beat.gold.which : null;
          this.quaternaryIndex =
            isSingleQuad && beat.pink && (beat.pinkGain ?? 0) > 0
              ? beat.pink.which
              : null;
          this.player.stopMain(
            this.tertiaryIndex !== null,
            this.quaternaryIndex !== null,
          );
        } else {
          this.tertiaryIndex = null;
          this.quaternaryIndex = null;
          this.player.stopMain();
        }
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
    const isSingleSong = this.otherBeats.length === 0;
    const isSingleMulti = isSingleSong && this.singleVoiceCount >= 3;
    const isSingleQuad = isSingleSong && this.singleVoiceCount >= 4;
    if (
      !this.quadMode &&
      isSingleMulti &&
      (this.tertiaryIndex !== null || this.quaternaryIndex !== null)
    ) {
      if (!this.player || !this.beats.length) {
        this.stop();
        this.onEnded?.();
        return;
      }
      const otherBeat =
        this.secondaryIndex < this.beats.length
          ? this.beats[this.secondaryIndex]
          : null;
      const goldBeat =
        this.tertiaryIndex !== null && this.tertiaryIndex < this.beats.length
          ? this.beats[this.tertiaryIndex]
          : null;
      const pinkBeat =
        this.quaternaryIndex !== null &&
        this.quaternaryIndex < this.beats.length
          ? this.beats[this.quaternaryIndex]
          : null;
      if (!otherBeat && !goldBeat && !pinkBeat) {
        this.stop();
        this.onEnded?.();
        return;
      }
      const delay = this.player.playFinishOutBeat(
        otherBeat,
        goldBeat,
        pinkBeat,
      );
      this.viz.setFinishOutIndices(
        otherBeat ? this.secondaryIndex : null,
        goldBeat ? this.tertiaryIndex : null,
        pinkBeat ? this.quaternaryIndex : null,
      );
      const finalMainStart = this.beats[this.beats.length - 1]?.start ?? 0;
      const activeBeat = (otherBeat ?? goldBeat ?? pinkBeat)!;
      const activeIndex = otherBeat
        ? this.secondaryIndex
        : goldBeat
          ? this.tertiaryIndex!
          : this.quaternaryIndex!;
      const cursorTimes: AutocanonizerCursorTimes = {
        mainSeconds: finalMainStart,
        otherSeconds: otherBeat ? otherBeat.start : finalMainStart,
        goldSeconds: goldBeat ? goldBeat.start : null,
      };
      if (isSingleQuad) {
        cursorTimes.pinkSeconds = pinkBeat ? pinkBeat.start : null;
      }
      this.onBeat?.(activeIndex, activeBeat, cursorTimes);
      if (otherBeat) {
        this.secondaryIndex += 1;
      }
      if (goldBeat) {
        this.tertiaryIndex =
          this.tertiaryIndex! + 1 < this.beats.length
            ? this.tertiaryIndex! + 1
            : null;
      }
      if (pinkBeat) {
        this.quaternaryIndex =
          this.quaternaryIndex! + 1 < this.beats.length
            ? this.quaternaryIndex! + 1
            : null;
      }
      const nextDelayMs = Math.max(0, delay * 1000);
      this.timerId = backgroundSetTimeout(
        () => this.tickSecondary(),
        nextDelayMs,
      );
      return;
    }

    const secondaryBeats =
      !this.quadMode && this.otherBeats.length ? this.otherBeats : this.beats;
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
    const cursorTimes: AutocanonizerCursorTimes = {
      mainSeconds: this.beats[this.beats.length - 1]?.start ?? 0,
      otherSeconds: beat.start,
    };
    if (isSingleMulti) {
      cursorTimes.goldSeconds = null;
    }
    if (isSingleQuad) {
      cursorTimes.pinkSeconds = null;
    }
    this.onBeat?.(this.secondaryIndex, beat, cursorTimes);
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
 * aligned beat index in Song 2 via multi-section local DTW, recording which
 * Song 1 beats belong to an aligned span (`matchedMask`) so unique sections in
 * differing-length covers can play solo instead of clamping onto Song 2's end.
 */
function buildCoverSyncIndexMap(
  featuresA: ReturnType<typeof extractTrackBeatFeatures>,
  featuresB: ReturnType<typeof extractTrackBeatFeatures>,
  mainLength: number,
  otherLength: number,
): { indexMap: number[]; matchedMask: boolean[] } {
  const { pairs: aligned, spans } = alignTrackPairMultiSectionDtw(
    featuresA,
    featuresB,
  );
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

  const isMultiSpan = spans.length > 1 || mainLength / Math.max(1, otherLength) > 1.25;
  const indexMap = new Array<number>(mainLength);
  const matchedMask = new Array<boolean>(mainLength);

  for (let i = 0; i < mainLength; i += 1) {
    let targetIdx: number;
    const mapped = bestByA.get(i);
    if (mapped) {
      targetIdx = mapped.indexB;
      matchedMask[i] = true;
    } else if (coveredIndices.length === 0) {
      targetIdx = Math.min(i, maxOtherIndex);
      matchedMask[i] = !isMultiSpan && i < otherLength;
    } else if (i < firstA) {
      // Extrapolate backward linearly before the DTW-aligned span begins.
      const candidate = firstB - (firstA - i);
      targetIdx = candidate;
      matchedMask[i] = !isMultiSpan || (candidate >= 0 && candidate <= maxOtherIndex);
    } else if (i > lastA) {
      // Extrapolate forward linearly after the DTW-aligned span ends.
      const candidate = lastB + (i - lastA);
      targetIdx = candidate;
      matchedMask[i] = !isMultiSpan || (candidate >= 0 && candidate <= maxOtherIndex);
    } else {
      // Gap between matched spans (e.g. Verse 2 / Bridge unique to Song 1):
      // interpolate nearest anchor for visuals while marking unmatched so voice mutes.
      let nearestA = firstA;
      let nearestDist = Math.abs(i - firstA);
      for (const idxA of coveredIndices) {
        const d = Math.abs(i - idxA);
        if (d < nearestDist) {
          nearestDist = d;
          nearestA = idxA;
        }
      }
      targetIdx = bestByA.get(nearestA)?.indexB ?? firstB;
      matchedMask[i] = false;
    }
    indexMap[i] = Math.max(0, Math.min(maxOtherIndex, targetIdx));
  }
  return { indexMap, matchedMask };
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
  for (const beat of mainBeats) {
    beat.pink = undefined;
    beat.pinkGain = undefined;
    beat.gold = undefined;
    beat.goldGain = undefined;
  }
  const featuresA = extractTrackBeatFeatures(mainBeats);
  const featuresB = extractTrackBeatFeatures(otherBeats);
  const { indexMap: syncedOtherIndices, matchedMask } = buildCoverSyncIndexMap(
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
      let matchedCanonCount = 0;
      for (const beat of list) {
        const canonIdx = beat.other.which;
        if (matchedMask[canonIdx]) {
          matchedCanonCount += 1;
        }
        const syncedTarget = syncedOtherIndices[canonIdx] ?? 0;
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
      const sectionSolo = matchedCanonCount === 0;
      for (const beat of list) {
        const rawIdx = beat.which - bestDelta;
        const inBounds = rawIdx >= 0 && rawIdx <= maxOtherIndex;
        const clampedIdx = Math.max(0, Math.min(maxOtherIndex, rawIdx));
        beat.other = otherBeats[clampedIdx];
        beat.otherGain = !sectionSolo && inBounds ? 1 : 0;
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
 * Configures 4-voice quad canon targets on `mainBeats`:
 * - Blue: Song 1 straight (`beat`)
 * - Green: Song 1's own vanilla canon (`beat.other`)
 * - Pink: Song 2 synced to Song 1 via DTW (`beat.pink`)
 * - Gold: Song 2 canon branch (`beat.gold`), either synced to Green's section
 *   jumps or following Song 2's independent vanilla canon.
 */
function applyQuadAlignment(
  mainBeats: BeatWithSim[],
  otherBeats: BeatWithSim[],
  branchMode: AutocanonizerQuadBranchMode,
) {
  const featuresA = extractTrackBeatFeatures(mainBeats);
  const featuresB = extractTrackBeatFeatures(otherBeats);
  const { indexMap: syncedOtherIndices, matchedMask } = buildCoverSyncIndexMap(
    featuresA,
    featuresB,
    mainBeats.length,
    otherBeats.length,
  );
  const maxOtherIndex = otherBeats.length - 1;

  // Song 1 plays its own vanilla autocanonizer (Blue + Green).
  calculateNearestNeighbors(mainBeats);
  foldBySection(mainBeats);

  // Pink stays structurally synced to Song 1's Blue cursor, muting during unmatched sections.
  for (let i = 0; i < mainBeats.length; i += 1) {
    const beat = mainBeats[i];
    beat.pink = otherBeats[syncedOtherIndices[i] ?? 0];
    beat.pinkGain = matchedMask[i] ? 1 : 0;
  }
  applyStreamSeamDucking(
    mainBeats,
    (beat) => beat.pink,
    (beat, gain) => {
      if ((beat.pinkGain ?? 0) > 0) {
        beat.pinkGain = gain;
      }
    },
  );

  if (branchMode === "synced") {
    // Synced mode: Gold mirrors Green's section-level canon offsets inside Song 2.
    const sections = new Map<number, BeatWithSim[]>();
    for (const beat of mainBeats) {
      const list = sections.get(beat.section) ?? [];
      list.push(beat);
      sections.set(beat.section, list);
    }
    for (const [, list] of sections) {
      if (!list.length) {
        continue;
      }
      const counter = new Map<number, number>();
      let matchedCanonCount = 0;
      for (const beat of list) {
        const canonIdx = beat.other.which;
        if (matchedMask[canonIdx]) {
          matchedCanonCount += 1;
        }
        const syncedTarget = syncedOtherIndices[canonIdx] ?? 0;
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
      const sectionSolo = matchedCanonCount === 0;
      for (const beat of list) {
        const rawIdx = beat.which - bestDelta;
        const inBounds = rawIdx >= 0 && rawIdx <= maxOtherIndex;
        const clampedIdx = Math.max(0, Math.min(maxOtherIndex, rawIdx));
        beat.gold = otherBeats[clampedIdx];
        beat.goldGain = !sectionSolo && inBounds ? 1 : 0;
      }
    }
  } else {
    // Independent mode: Song 2 builds its own vanilla canon and Gold follows it.
    calculateNearestNeighbors(otherBeats);
    foldBySection(otherBeats);
    for (const beat of mainBeats) {
      beat.gold = beat.pink?.other ?? otherBeats[0];
      beat.goldGain = beat.pinkGain ?? 1;
    }
  }

  applyStreamSeamDucking(
    mainBeats,
    (beat) => beat.gold,
    (beat, gain) => {
      if ((beat.goldGain ?? 0) > 0) {
        beat.goldGain = gain;
      }
    },
  );
}

/**
 * Ducks a voice's gain across non-consecutive beat jumps to soften seams.
 */
function applyStreamSeamDucking(
  beats: BeatWithSim[],
  getTarget: (beat: BeatWithSim) => CanonizerBeat | undefined,
  setGain: (beat: BeatWithSim, gain: number) => void,
) {
  for (const beat of beats) {
    const curTarget = getTarget(beat);
    if (!curTarget) {
      continue;
    }
    const prev = beat.prev as BeatWithSim | null;
    const next = beat.next as BeatWithSim | null;
    const prevTarget = prev ? getTarget(prev) : undefined;
    const nextTarget = next ? getTarget(next) : undefined;
    if (prev && prevTarget && prevTarget.which + 1 !== curTarget.which) {
      setGain(prev, 0.5);
      setGain(beat, 0.5);
    }
    if (next && nextTarget && nextTarget.which - 1 !== curTarget.which) {
      setGain(next, 0.5);
      setGain(beat, 0.5);
    }
  }
}

/**
 * Ducks the secondary voice gain at discontinuous jumps so transitions between
 * non-consecutive beats cross-fade smoothly.
 */
function applyOtherSeamDucking(beats: BeatWithSim[]) {
  applyStreamSeamDucking(
    beats,
    (beat) => beat.other,
    (beat, gain) => {
      if (beat.otherGain > 0) {
        beat.otherGain = gain;
      }
    },
  );
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

/**
 * Returns the median of a non-empty numeric array.
 */
function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Selects a runner-up section match for one section of beats, excluding any
 * sections already claimed by prior voices, and applies the strict quality gate.
 */
function assignRunnerUpSectionVoice(
  beats: BeatWithSim[],
  list: BeatWithSim[],
  trackMedianSimDist: number,
  isSectionExcluded: (beat: BeatWithSim, cand: BeatWithSim) => boolean,
  assign: (beat: BeatWithSim, target: CanonizerBeat, gain: number) => void,
) {
  const sectionOtherDists: number[] = [];
  for (const beat of list) {
    if (beat.other !== beat) {
      const d = compareBeats(beat, beat.other);
      if (Number.isFinite(d)) {
        sectionOtherDists.push(d);
      }
    }
  }
  const sectionOtherDist = sectionOtherDists.length
    ? medianNumber(sectionOtherDists)
    : trackMedianSimDist;

  const counter = new Map<number, number>();
  for (const beat of list) {
    let bestCand: BeatWithSim | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const cand of beats) {
      if (cand === beat || isSectionExcluded(beat, cand)) {
        continue;
      }
      const dist = compareBeats(beat, cand);
      if (Number.isFinite(dist) && dist >= 0 && dist < bestDist) {
        bestDist = dist;
        bestCand = cand;
      }
    }
    if (bestCand) {
      const delta = beat.which - bestCand.which;
      counter.set(delta, (counter.get(delta) ?? 0) + 1);
    }
  }

  let bestDelta: number | null = null;
  let bestCount = -1;
  for (const [delta, count] of counter) {
    if (delta === 0) {
      continue;
    }
    let inBoundsCount = 0;
    let distinctCount = 0;
    for (const beat of list) {
      const rawIdx = beat.which - delta;
      if (rawIdx >= 0 && rawIdx < beats.length) {
        inBoundsCount += 1;
        const target = beats[rawIdx];
        if (!isSectionExcluded(beat, target)) {
          distinctCount += 1;
        }
      }
    }
    if (
      inBoundsCount === 0 ||
      inBoundsCount * 2 < list.length ||
      distinctCount * 2 <= inBoundsCount
    ) {
      continue;
    }
    if (count > bestCount) {
      bestCount = count;
      bestDelta = delta;
    }
  }

  if (bestDelta === null) {
    for (const beat of list) {
      assign(beat, beat, 0);
    }
    return;
  }

  const candDists: number[] = [];
  for (const beat of list) {
    const rawIdx = beat.which - bestDelta;
    if (rawIdx >= 0 && rawIdx < beats.length) {
      const d = compareBeats(beat, beats[rawIdx]);
      if (Number.isFinite(d)) {
        candDists.push(d);
      }
    }
  }
  const sectionCandDist = candDists.length
    ? medianNumber(candDists)
    : Number.POSITIVE_INFINITY;
  const maxAcceptableDist = Math.min(
    sectionOtherDist * 1.5 + 15,
    trackMedianSimDist * 1.75 + 20,
  );
  const acceptMatch =
    Number.isFinite(sectionCandDist) && sectionCandDist <= maxAcceptableDist;

  for (const beat of list) {
    const rawIdx = beat.which - bestDelta;
    const inBounds = rawIdx >= 0 && rawIdx < beats.length;
    const clampedIdx = Math.max(0, Math.min(beats.length - 1, rawIdx));
    assign(beat, beats[clampedIdx], acceptMatch && inBounds ? 1 : 0);
  }
}

/**
 * Configures Voice 3 (`beat.gold`) and optional Voice 4 (`beat.pink`) for
 * single-song multi-voice mode by picking each section's distinct runner-up
 * matches, muting any section that lacks a distinct, musically similar match.
 */
function applyMultiVoiceAlignment(beats: BeatWithSim[], voiceCount: 3 | 4) {
  const sections = new Map<number, BeatWithSim[]>();
  for (const beat of beats) {
    const list = sections.get(beat.section) ?? [];
    list.push(beat);
    sections.set(beat.section, list);
  }

  const allSimDists: number[] = [];
  for (const beat of beats) {
    if (beat.simDistance !== undefined && Number.isFinite(beat.simDistance)) {
      allSimDists.push(beat.simDistance);
    }
  }
  const trackMedianSimDist = allSimDists.length
    ? medianNumber(allSimDists)
    : Number.POSITIVE_INFINITY;

  // Pass 1: assign Gold excluding own section and Voice 2's matched section.
  if (sections.size < 3) {
    for (const beat of beats) {
      beat.gold = beat;
      beat.goldGain = 0;
    }
  } else {
    for (const [, list] of sections) {
      if (!list.length) {
        continue;
      }
      assignRunnerUpSectionVoice(
        beats,
        list,
        trackMedianSimDist,
        (beat, cand) =>
          cand.section === beat.section || cand.section === beat.other.section,
        (beat, target, gain) => {
          beat.gold = target;
          beat.goldGain = gain;
        },
      );
    }
    applyStreamSeamDucking(
      beats,
      (beat) => beat.gold,
      (beat, gain) => {
        if ((beat.goldGain ?? 0) > 0) {
          beat.goldGain = gain;
        }
      },
    );
  }

  if (voiceCount < 4) {
    for (const beat of beats) {
      beat.pink = undefined;
      beat.pinkGain = undefined;
    }
    return;
  }

  // Pass 2: assign Pink excluding own, Green, and Gold sections (or mute if Gold muted).
  if (sections.size < 4) {
    for (const beat of beats) {
      beat.pink = beat;
      beat.pinkGain = 0;
    }
    return;
  }

  for (const [, list] of sections) {
    if (!list.length) {
      continue;
    }
    if (!list.some((b) => (b.goldGain ?? 0) > 0)) {
      for (const beat of list) {
        beat.pink = beat;
        beat.pinkGain = 0;
      }
      continue;
    }
    assignRunnerUpSectionVoice(
      beats,
      list,
      trackMedianSimDist,
      (beat, cand) =>
        cand.section === beat.section ||
        cand.section === beat.other.section ||
        cand.section === beat.gold?.section,
      (beat, target, gain) => {
        beat.pink = target;
        beat.pinkGain = gain;
      },
    );
  }

  applyStreamSeamDucking(
    beats,
    (beat) => beat.pink,
    (beat, gain) => {
      if ((beat.pinkGain ?? 0) > 0) {
        beat.pinkGain = gain;
      }
    },
  );
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
