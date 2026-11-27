import {
  backgroundClearTimeout,
  backgroundSetTimeout,
} from "../background/backgroundTimer";
import { createSafetyLimiter } from "../audio/audioModes";
import { clampVolume } from "../audio/volume";
import { normalizeAnalysis } from "../engine/analysis";
import { computeBeatColors } from "../engine/beatColors";
import {
  alignTrackPairMultiSectionDtw,
  extractTrackBeatFeatures,
} from "../engine/coverSync";
import { clampTimeSignatureTrackOffset } from "../engine/timeSignatureBranching";
import type { QuantumBase, TrackAnalysis } from "../engine/types";
import {
  SONG_SYNC_TRACK_COLORS,
  SongSyncViz,
  type SongSyncVizTrack,
} from "./SongSyncViz";

export interface SongSyncTrackInput {
  title: string;
  buffer: AudioBuffer;
  analysis: unknown;
  durationSec?: number;
  tempo?: number;
  tempoRatio?: number;
  gain?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
  beatOffset?: number;
}

export interface SongSyncTrackConfig {
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  beatOffset: number;
}

export interface SongSyncTrackMeta {
  trackIndex: number;
  title: string;
  duration: number;
  tempo?: number;
  color: string;
  beatCount: number;
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  beatOffset: number;
  isMaster: boolean;
}

export interface SongSyncBeatSnapshot {
  masterBeatIndex: number;
  masterBeat: QuantumBase;
  trackSeconds: Array<number | null>;
  beatIndicesByTrack: Array<number | null>;
}

interface PreparedSongSyncTrack {
  title: string;
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
  beats: Array<QuantumBase & { color: string }>;
  duration: number;
  tempo?: number;
  tempoRatio: number;
  color: string;
  config: SongSyncTrackConfig;
}

const MAX_SYNC_SKEW_SEC = 0.035;
const SEAM_FADE_SEC = 0.015;
const MIN_STREAM_GAIN = 0;
const MAX_STREAM_GAIN = 2;

function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, pan));
}

function clampStreamGain(gain: number, fallback: number): number {
  if (!Number.isFinite(gain)) {
    return fallback;
  }
  return Math.max(MIN_STREAM_GAIN, Math.min(MAX_STREAM_GAIN, gain));
}

function scaleAnalysisTiming(analysis: TrackAnalysis, timeScale: number): void {
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
 * Computes raw master-beat -> secondary-beat alignment maps using multi-section
 * local DTW. Beats in unique sections of the master track map to `null` so
 * secondary voices stay silent rather than repeating or clamping.
 */
function computeTrackAlignmentMap(
  masterBeats: readonly QuantumBase[],
  otherBeats: readonly QuantumBase[],
): Array<number | null> {
  const result = new Array<number | null>(masterBeats.length).fill(null);
  if (masterBeats.length === 0 || otherBeats.length === 0) {
    return result;
  }
  const masterFeatures = extractTrackBeatFeatures(masterBeats);
  const otherFeatures = extractTrackBeatFeatures(otherBeats);
  const alignment = alignTrackPairMultiSectionDtw(masterFeatures, otherFeatures);

  const bestByMaster = new Map<number, { indexB: number; distance: number }>();
  for (const pair of alignment.pairs) {
    const existing = bestByMaster.get(pair.indexA);
    if (!existing || pair.distance < existing.distance) {
      bestByMaster.set(pair.indexA, {
        indexB: pair.indexB,
        distance: pair.distance,
      });
    }
  }
  for (const [masterIdx, entry] of bestByMaster.entries()) {
    result[masterIdx] = entry.indexB;
  }
  return result;
}

class SongSyncPlayer {
  private readonly context: AudioContext;
  private readonly masterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode | null;
  private trackGains: GainNode[] = [];
  private trackPanners: Array<StereoPannerNode | null> = [];
  private trackSources: Array<AudioBufferSourceNode | null> = [];
  private trackBuffers: AudioBuffer[] = [];
  private activeBeatIndices: Array<number | null> = [];
  private skewDeltas: number[] = [];
  private masterDeltaTime = 0;
  private baseVolume = 1;

  constructor(context: AudioContext) {
    this.context = context;
    this.masterGain = this.context.createGain();
    this.limiter = createSafetyLimiter(this.context);
    if (this.limiter) {
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.context.destination);
    } else {
      this.masterGain.connect(this.context.destination);
    }
    this.masterGain.gain.value = 1;
  }

  /**
   * Rebuilds per-track GainNode and StereoPannerNode chains to match `tracks`.
   */
  configureTracks(tracks: readonly PreparedSongSyncTrack[]) {
    this.stop();
    for (const gain of this.trackGains) {
      try {
        gain.disconnect();
      } catch {
        // Ignore disconnect errors on already-disconnected nodes.
      }
    }
    for (const panner of this.trackPanners) {
      try {
        panner?.disconnect();
      } catch {
        // Ignore disconnect errors on already-disconnected nodes.
      }
    }

    this.trackBuffers = tracks.map((t) => t.buffer);
    this.trackSources = tracks.map(() => null);
    this.activeBeatIndices = tracks.map(() => null);
    this.skewDeltas = tracks.map(() => 0);

    this.trackGains = [];
    this.trackPanners = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const gain = this.context.createGain();
      const panner =
        typeof this.context.createStereoPanner === "function"
          ? this.context.createStereoPanner()
          : null;
      if (panner) {
        panner.connect(gain);
      }
      gain.connect(this.masterGain);
      this.trackGains.push(gain);
      this.trackPanners.push(panner);
    }
    this.updateTrackMixParams(tracks);
  }

  setVolume(volume: number) {
    this.baseVolume = clampVolume(volume, this.baseVolume);
    this.masterGain.gain.value = this.baseVolume;
  }

  /**
   * Updates per-track volume trims, pans, and mute/solo state live without
   * stopping active AudioBufferSourceNodes.
   */
  updateTrackMixParams(tracks: readonly PreparedSongSyncTrack[]) {
    const anySolo = tracks.some((t) => t.config.solo);
    const audibleCount = tracks.filter(
      (t) => !t.config.muted && (!anySolo || t.config.solo),
    ).length;
    // Scale summed voices inversely with sqrt(N) to preserve headroom while staying punchy.
    const mixBlend = 1 / Math.sqrt(Math.max(1, audibleCount));

    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const gainNode = this.trackGains[i];
      const panner = this.trackPanners[i];
      const isAudible =
        !track.config.muted && (!anySolo || track.config.solo);
      const targetGain = isAudible ? track.config.gain * mixBlend : 0;
      if (gainNode) {
        const currentBeatActive = this.activeBeatIndices[i] !== null;
        const resolved = currentBeatActive || this.trackSources[i] === null
          ? targetGain
          : 0;
        if (typeof gainNode.gain.setValueAtTime === "function") {
          gainNode.gain.setValueAtTime(resolved, this.context.currentTime);
        } else {
          gainNode.gain.value = resolved;
        }
      }
      if (panner) {
        panner.pan.value = track.config.pan;
      }
    }
  }

  reset() {
    this.stop();
    this.masterDeltaTime = 0;
  }

  stop() {
    for (let i = 0; i < this.trackSources.length; i += 1) {
      this.stopTrackSource(i);
      this.activeBeatIndices[i] = null;
      this.skewDeltas[i] = 0;
    }
  }

  private stopTrackSource(index: number) {
    const src = this.trackSources[index];
    if (!src) {
      return;
    }
    try {
      src.stop(0);
    } catch {
      // Ignore stop errors on already-ended sources.
    }
    src.disconnect();
    this.trackSources[index] = null;
  }

  private startTrackSource(
    index: number,
    startSec: number,
    targetGain: number,
    fadeIn: boolean,
  ) {
    this.stopTrackSource(index);
    const buffer = this.trackBuffers[index];
    const gainNode = this.trackGains[index];
    const dest: AudioNode | undefined = this.trackPanners[index] ?? gainNode;
    if (!buffer || !gainNode || !dest) {
      return;
    }
    const clampedStart = Math.max(0, Math.min(startSec, buffer.duration));
    const remaining = Math.max(0, buffer.duration - clampedStart);
    if (remaining <= 0) {
      return;
    }
    const now = this.context.currentTime;
    if (
      fadeIn &&
      typeof gainNode.gain.setValueAtTime === "function" &&
      typeof gainNode.gain.linearRampToValueAtTime === "function"
    ) {
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(targetGain, now + SEAM_FADE_SEC);
    } else {
      gainNode.gain.value = targetGain;
    }

    const src = this.context.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    src.start(0, clampedStart, remaining);
    this.trackSources[index] = src;
  }

  /**
   * Advances all synced tracks for one master beat step and returns the delay
   * in seconds until the next master beat boundary.
   */
  playBeatStep(
    tracks: readonly PreparedSongSyncTrack[],
    masterTrackIndex: number,
    masterBeatIndex: number,
    beatIndicesByTrack: ReadonlyArray<number | null>,
  ): number {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    const masterTrack = tracks[masterTrackIndex];
    const masterBeat = masterTrack?.beats[masterBeatIndex];
    if (!masterTrack || !masterBeat) {
      return 0.1;
    }

    const anySolo = tracks.some((t) => t.config.solo);
    const audibleCount = tracks.filter(
      (t) => !t.config.muted && (!anySolo || t.config.solo),
    ).length;
    const mixBlend = 1 / Math.sqrt(Math.max(1, audibleCount));

    // Advance or resync the master track when discontinuous or freshly started.
    const prevMasterIdx = this.activeBeatIndices[masterTrackIndex];
    const masterAudible =
      !masterTrack.config.muted && (!anySolo || masterTrack.config.solo);
    const masterTargetGain = masterAudible
      ? masterTrack.config.gain * mixBlend
      : 0;
    if (
      this.trackSources[masterTrackIndex] === null ||
      prevMasterIdx === null ||
      prevMasterIdx + 1 !== masterBeatIndex
    ) {
      this.startTrackSource(
        masterTrackIndex,
        masterBeat.start,
        masterTargetGain,
        false,
      );
      this.masterDeltaTime = this.context.currentTime - masterBeat.start;
    } else if (this.trackGains[masterTrackIndex]) {
      this.trackGains[masterTrackIndex].gain.value = masterTargetGain;
    }
    this.activeBeatIndices[masterTrackIndex] = masterBeatIndex;

    // Advance, resync, or mute each secondary track based on its mapped beat.
    for (let t = 0; t < tracks.length; t += 1) {
      if (t === masterTrackIndex) {
        continue;
      }
      const track = tracks[t];
      const targetIdx = beatIndicesByTrack[t];
      const gainNode = this.trackGains[t];
      if (targetIdx === null || targetIdx === undefined) {
        if (this.trackSources[t] !== null) {
          this.stopTrackSource(t);
        }
        if (gainNode) {
          gainNode.gain.value = 0;
        }
        this.activeBeatIndices[t] = null;
        this.skewDeltas[t] = 0;
        continue;
      }

      const targetBeat = track.beats[targetIdx];
      if (!targetBeat) {
        this.stopTrackSource(t);
        this.activeBeatIndices[t] = null;
        continue;
      }

      const isAudible = !track.config.muted && (!anySolo || track.config.solo);
      const targetGain = isAudible ? track.config.gain * mixBlend : 0;
      const prevIdx = this.activeBeatIndices[t];
      const wasSilent = prevIdx === null || this.trackSources[t] === null;
      const isNonConsecutive = prevIdx !== null && prevIdx + 1 !== targetIdx;
      const skewExceeded = Math.abs(this.skewDeltas[t]) > MAX_SYNC_SKEW_SEC;

      if (wasSilent || isNonConsecutive || skewExceeded) {
        this.skewDeltas[t] = 0;
        this.startTrackSource(
          t,
          targetBeat.start,
          targetGain,
          wasSilent || isNonConsecutive,
        );
      } else if (gainNode) {
        gainNode.gain.value = targetGain;
      }

      this.activeBeatIndices[t] = targetIdx;
      this.skewDeltas[t] += masterBeat.duration - targetBeat.duration;
    }

    const elapsedOnMaster = this.context.currentTime - this.masterDeltaTime;
    const drift = elapsedOnMaster - masterBeat.start;
    return Math.max(0.01, masterBeat.duration - drift);
  }
}

/**
 * Coordinates multi-track Song Sync playback: aligns all tracks to a master
 * timeline via multi-section DTW without canon jumping, plays all matched
 * tracks simultaneously with live mix controls, and drives `SongSyncViz`.
 */
export class SongSyncController {
  private readonly viz: SongSyncViz;
  private tracks: PreparedSongSyncTrack[] = [];
  private masterTrackIndex = 0;
  private rawMaps: Array<Array<number | null>> = [];
  private effectiveMaps: Array<Array<number | null>> = [];
  private player: SongSyncPlayer | null = null;
  private running = false;
  private loop = false;
  private currentIndex = 0;
  private timerId: number | null = null;
  private volume = 1;
  private onBeat: ((snapshot: SongSyncBeatSnapshot) => void) | null = null;
  private onEnded: (() => void) | null = null;
  private onSelect: ((masterBeatIndex: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.viz = new SongSyncViz(container);
    this.viz.setOnSelect((trackIndex, beatIndex) => {
      const masterBeatIdx = this.resolveMasterBeatForTrackBeat(
        trackIndex,
        beatIndex,
      );
      if (this.onSelect) {
        this.onSelect(masterBeatIdx);
      } else {
        this.selectIndex(masterBeatIdx, true);
      }
    });
  }

  setVisible(visible: boolean) {
    this.viz.setVisible(visible);
  }

  resizeNow() {
    this.viz.resizeNow();
  }

  setOnBeat(handler: ((snapshot: SongSyncBeatSnapshot) => void) | null) {
    this.onBeat = handler;
  }

  setOnEnded(handler: (() => void) | null) {
    this.onEnded = handler;
  }

  setOnSelect(handler: ((masterBeatIndex: number) => void) | null) {
    this.onSelect = handler;
  }

  setLoop(enabled: boolean) {
    this.loop = enabled;
  }

  setVolume(volume: number) {
    this.volume = clampVolume(volume, this.volume);
    this.player?.setVolume(this.volume);
  }

  /**
   * Configures the tracks, audio buffers, and initial alignment for Song Sync.
   * Defaults `masterTrackIndex` to the longest track unless overridden.
   */
  setTracks(
    inputs: readonly SongSyncTrackInput[],
    context: AudioContext | null,
    options?: { masterTrackIndex?: number; loop?: boolean },
  ) {
    this.stop();
    if (options?.loop !== undefined) {
      this.loop = options.loop;
    }
    this.tracks = inputs.map((input, index) => {
      const analysis = normalizeAnalysis(input.analysis);
      const ratio =
        input.tempoRatio !== undefined &&
        Number.isFinite(input.tempoRatio) &&
        input.tempoRatio > 0
          ? input.tempoRatio
          : 1;
      if (ratio !== 1) {
        scaleAnalysisTiming(analysis, 1 / ratio);
      }
      const colors = computeBeatColors(analysis.beats, analysis.segments);
      const beats = analysis.beats.map((beat, bIdx) => ({
        ...beat,
        color: colors[bIdx] ?? SONG_SYNC_TRACK_COLORS[index % SONG_SYNC_TRACK_COLORS.length],
      }));
      const lastBeat = beats[beats.length - 1];
      const fallbackDur = lastBeat ? lastBeat.start + lastBeat.duration : input.buffer.duration;
      const duration =
        input.durationSec !== undefined &&
        Number.isFinite(input.durationSec) &&
        input.durationSec > 0
          ? input.durationSec
          : input.buffer.duration || fallbackDur;
      return {
        title: input.title || `Track ${index + 1}`,
        buffer: input.buffer,
        analysis,
        beats,
        duration,
        tempo: input.tempo ?? analysis.track?.tempo,
        tempoRatio: ratio,
        color: SONG_SYNC_TRACK_COLORS[index % SONG_SYNC_TRACK_COLORS.length],
        config: {
          gain: clampStreamGain(input.gain ?? 1, 1),
          pan: clampPan(input.pan ?? 0),
          muted: Boolean(input.muted),
          solo: Boolean(input.solo),
          beatOffset: clampTimeSignatureTrackOffset(input.beatOffset ?? 0),
        },
      };
    });

    if (this.tracks.length === 0) {
      this.masterTrackIndex = 0;
      this.rawMaps = [];
      this.effectiveMaps = [];
      this.player = null;
      this.viz.setData([], 0, []);
      return;
    }

    if (
      options?.masterTrackIndex !== undefined &&
      options.masterTrackIndex >= 0 &&
      options.masterTrackIndex < this.tracks.length
    ) {
      this.masterTrackIndex = options.masterTrackIndex;
    } else {
      // Pick the longest track as master so shorter covers sync along its full span.
      let longestIdx = 0;
      let longestDur = -1;
      for (let i = 0; i < this.tracks.length; i += 1) {
        if (this.tracks[i].duration > longestDur) {
          longestDur = this.tracks[i].duration;
          longestIdx = i;
        }
      }
      this.masterTrackIndex = longestIdx;
    }

    if (context) {
      if (!this.player) {
        this.player = new SongSyncPlayer(context);
      }
      this.player.setVolume(this.volume);
      this.player.configureTracks(this.tracks);
    } else {
      this.player = null;
    }

    this.recomputeAlignments();
    this.currentIndex = 0;
    this.pushVizData();
  }

  /**
   * Switches which track acts as the master timeline and recomputes alignments.
   */
  setMasterTrackIndex(index: number) {
    if (index < 0 || index >= this.tracks.length || index === this.masterTrackIndex) {
      return;
    }
    const wasRunning = this.running;
    const mappedMasterBeat = this.effectiveMaps[index]?.[this.currentIndex] ?? 0;
    if (wasRunning) {
      this.stop();
    }
    this.masterTrackIndex = index;
    this.recomputeAlignments();
    this.currentIndex = Math.max(
      0,
      Math.min(
        mappedMasterBeat,
        Math.max(0, (this.tracks[this.masterTrackIndex]?.beats.length ?? 1) - 1),
      ),
    );
    this.pushVizData();
    if (wasRunning) {
      this.startAtIndex(this.currentIndex);
    }
  }

  /**
   * Updates one track's live volume trim, pan, mute, solo, or beat offset.
   */
  setTrackConfig(trackIndex: number, patch: Partial<SongSyncTrackConfig>) {
    const track = this.tracks[trackIndex];
    if (!track) {
      return;
    }
    const prevOffset = track.config.beatOffset;
    if (patch.gain !== undefined) {
      track.config.gain = clampStreamGain(patch.gain, track.config.gain);
    }
    if (patch.pan !== undefined) {
      track.config.pan = clampPan(patch.pan);
    }
    if (patch.muted !== undefined) {
      track.config.muted = Boolean(patch.muted);
    }
    if (patch.solo !== undefined) {
      track.config.solo = Boolean(patch.solo);
    }
    if (patch.beatOffset !== undefined) {
      track.config.beatOffset = clampTimeSignatureTrackOffset(patch.beatOffset);
    }
    this.player?.updateTrackMixParams(this.tracks);

    if (track.config.beatOffset !== prevOffset) {
      this.applyBeatOffsets();
      this.pushVizData();
      if (this.running) {
        this.resyncPlaybackInPlace();
      } else {
        this.updateVizCursors(this.currentIndex);
      }
      return;
    }
    this.pushVizData();
    this.updateVizCursors(this.currentIndex);
  }

  getMasterTrackIndex(): number {
    return this.masterTrackIndex;
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getTrackMeta(): SongSyncTrackMeta[] {
    return this.tracks.map((track, idx) => ({
      trackIndex: idx,
      title: track.title,
      duration: track.duration,
      tempo: track.tempo,
      color: track.color,
      beatCount: track.beats.length,
      gain: track.config.gain,
      pan: track.config.pan,
      muted: track.config.muted,
      solo: track.config.solo,
      beatOffset: track.config.beatOffset,
      isMaster: idx === this.masterTrackIndex,
    }));
  }

  isReady(): boolean {
    const master = this.tracks[this.masterTrackIndex];
    return Boolean(this.player && master && master.beats.length > 0);
  }

  selectIndex(masterBeatIndex: number, autoStart: boolean) {
    const master = this.tracks[this.masterTrackIndex];
    if (!master || master.beats.length === 0) {
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(masterBeatIndex, master.beats.length - 1),
    );
    this.currentIndex = clamped;
    if (this.running) {
      this.resyncPlaybackInPlace();
      return;
    }
    this.updateVizCursors(clamped);
    if (autoStart) {
      this.startAtIndex(clamped);
    }
  }

  start() {
    this.startAtIndex(0);
  }

  startAtIndex(index: number) {
    const master = this.tracks[this.masterTrackIndex];
    if (!this.isReady() || !this.player || !master) {
      return;
    }
    this.stop();
    this.running = true;
    this.currentIndex = Math.max(0, Math.min(index, master.beats.length - 1));
    this.player.reset();
    this.tick();
  }

  stop() {
    if (this.timerId !== null) {
      backgroundClearTimeout(this.timerId);
      this.timerId = null;
    }
    this.running = false;
    this.player?.stop();
  }

  reset() {
    this.stop();
    this.tracks = [];
    this.rawMaps = [];
    this.effectiveMaps = [];
    this.currentIndex = 0;
    this.viz.setData([], 0, []);
    this.viz.reset();
  }

  resetVisualization() {
    this.viz.reset();
  }

  destroy() {
    this.stop();
    this.tracks = [];
    this.rawMaps = [];
    this.effectiveMaps = [];
    this.viz.destroy();
    this.player = null;
  }

  private recomputeAlignments() {
    const master = this.tracks[this.masterTrackIndex];
    if (!master) {
      this.rawMaps = [];
      this.effectiveMaps = [];
      return;
    }
    this.rawMaps = this.tracks.map((track, idx) =>
      idx === this.masterTrackIndex
        ? master.beats.map((_, bIdx) => bIdx)
        : computeTrackAlignmentMap(master.beats, track.beats),
    );
    this.applyBeatOffsets();
  }

  private applyBeatOffsets() {
    const master = this.tracks[this.masterTrackIndex];
    if (!master) {
      this.effectiveMaps = [];
      return;
    }
    const masterOffset = master.config.beatOffset;
    this.effectiveMaps = this.tracks.map((track, t) => {
      const raw = this.rawMaps[t] ?? [];
      if (t === this.masterTrackIndex) {
        return raw;
      }
      const relativeOffset = track.config.beatOffset - masterOffset;
      const maxBeat = track.beats.length - 1;
      return raw.map((mappedIdx) => {
        if (mappedIdx === null || maxBeat < 0) {
          return null;
        }
        const shifted = mappedIdx + relativeOffset;
        if (shifted < 0 || shifted > maxBeat) {
          return null;
        }
        return shifted;
      });
    });
  }

  private pushVizData() {
    const vizTracks: SongSyncVizTrack[] = this.tracks.map((track, idx) => ({
      trackIndex: idx,
      title: track.title,
      duration: track.duration,
      tempo: track.tempo,
      beats: track.beats,
      color: track.color,
      isMaster: idx === this.masterTrackIndex,
      muted: track.config.muted,
      solo: track.config.solo,
    }));
    this.viz.setData(vizTracks, this.masterTrackIndex, this.effectiveMaps);
  }

  private resolveMasterBeatForTrackBeat(
    trackIndex: number,
    beatIndex: number,
  ): number {
    if (trackIndex === this.masterTrackIndex) {
      return beatIndex;
    }
    const map = this.effectiveMaps[trackIndex];
    if (!map) {
      return 0;
    }
    let bestMaster = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < map.length; i += 1) {
      const target = map[i];
      if (target === null) {
        continue;
      }
      const dist = Math.abs(target - beatIndex);
      if (dist < bestDist) {
        bestDist = dist;
        bestMaster = i;
        if (dist === 0) {
          break;
        }
      }
    }
    return bestMaster;
  }

  private resolveBeatIndicesAtMasterBeat(
    masterBeatIndex: number,
  ): Array<number | null> {
    return this.tracks.map((_, t) =>
      t === this.masterTrackIndex
        ? masterBeatIndex
        : (this.effectiveMaps[t]?.[masterBeatIndex] ?? null),
    );
  }

  private updateVizCursors(masterBeatIndex: number) {
    this.viz.update({
      masterBeatIndex,
      beatIndicesByTrack: this.resolveBeatIndicesAtMasterBeat(masterBeatIndex),
    });
  }

  private resyncPlaybackInPlace() {
    if (this.timerId !== null) {
      backgroundClearTimeout(this.timerId);
      this.timerId = null;
    }
    this.player?.reset();
    this.tick();
  }

  private tick() {
    if (!this.running) {
      return;
    }
    const master = this.tracks[this.masterTrackIndex];
    if (!this.player || !master || !master.beats.length) {
      this.running = false;
      this.onEnded?.();
      return;
    }
    if (this.currentIndex >= master.beats.length) {
      this.running = false;
      this.onEnded?.();
      return;
    }

    const masterBeatIdx = this.currentIndex;
    const masterBeat = master.beats[masterBeatIdx];
    const beatIndicesByTrack = this.resolveBeatIndicesAtMasterBeat(masterBeatIdx);
    const delaySec = this.player.playBeatStep(
      this.tracks,
      this.masterTrackIndex,
      masterBeatIdx,
      beatIndicesByTrack,
    );

    this.viz.update({
      masterBeatIndex: masterBeatIdx,
      beatIndicesByTrack,
    });

    const trackSeconds = beatIndicesByTrack.map((idx, t) =>
      idx !== null ? (this.tracks[t]?.beats[idx]?.start ?? null) : null,
    );
    this.onBeat?.({
      masterBeatIndex: masterBeatIdx,
      masterBeat,
      trackSeconds,
      beatIndicesByTrack,
    });

    const isFinal = masterBeatIdx === master.beats.length - 1;
    if (isFinal) {
      if (this.loop) {
        this.currentIndex = 0;
      } else {
        this.currentIndex = master.beats.length;
      }
    } else {
      this.currentIndex += 1;
    }

    this.timerId = backgroundSetTimeout(
      () => this.tick(),
      Math.max(0, delaySec * 1000),
    );
  }
}
