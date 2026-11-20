import { describe, expect, it, vi } from "vitest";
import { combineAudioBuffers } from "../audio/multiTrackBuffer";
import { beatPairDistance, buildJumpGraph } from "./graph";
import { DEFAULT_JUKEBOX_CONFIG, JukeboxEngine, type JukeboxPlayer } from "./JukeboxEngine";
import { computeTempoSyncRatio, mergeTrackAnalyses } from "./multiTrack";

function makeFakeAudioBuffer(channels: number[][], sampleRate = 1000): AudioBuffer {
  const data = channels.map((ch) => new Float32Array(ch));
  const length = data[0]?.length ?? 0;
  return {
    numberOfChannels: data.length,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (idx: number) => data[idx],
  } as unknown as AudioBuffer;
}

function makeFakeAudioContext(sampleRate = 1000): BaseAudioContext {
  return {
    sampleRate,
    createBuffer: (numChannels: number, length: number, rate: number) =>
      makeFakeAudioBuffer(
        Array.from({ length: numChannels }, () => new Array(length).fill(0)),
        rate,
      ),
  } as unknown as BaseAudioContext;
}

function makeRawTrack(opts: {
  title: string;
  beatCount: number;
  beatDuration: number;
  tempo: number;
  pitchValue: number;
  timbreValue: number;
}) {
  const { title, beatCount, beatDuration, tempo, pitchValue, timbreValue } = opts;
  const totalDuration = beatCount * beatDuration;
  const beats = Array.from({ length: beatCount }, (_, i) => ({
    start: i * beatDuration,
    duration: beatDuration,
    confidence: 0.9,
  }));
  const segments = Array.from({ length: beatCount }, (_, i) => ({
    start: i * beatDuration,
    duration: beatDuration,
    confidence: 0.9,
    loudness_start: -12,
    loudness_max: -4,
    loudness_max_time: beatDuration * 0.2,
    pitches: new Array(12).fill(pitchValue),
    timbre: new Array(12).fill(timbreValue),
  }));
  return {
    sections: [{ start: 0, duration: totalDuration, confidence: 1 }],
    bars: [
      { start: 0, duration: totalDuration / 2, confidence: 0.9 },
      { start: totalDuration / 2, duration: totalDuration / 2, confidence: 0.9 },
    ],
    beats,
    tatums: beats.map((b) => ({ ...b })),
    segments,
    track: {
      title,
      duration: totalDuration,
      tempo,
      time_signature: 4,
    },
  };
}

describe("computeTempoSyncRatio", () => {
  it("returns 1 when disabled or tempos are missing", () => {
    expect(computeTempoSyncRatio(120, 100, false)).toBe(1);
    expect(computeTempoSyncRatio(undefined, 100, true)).toBe(1);
    expect(computeTempoSyncRatio(120, 0, true)).toBe(1);
  });

  it("computes direct ratio within natural band and folds halftime/double-time", () => {
    expect(computeTempoSyncRatio(120, 100, true)).toBeCloseTo(1.2, 6);
    expect(computeTempoSyncRatio(140, 70, true)).toBeCloseTo(1, 6);
    expect(computeTempoSyncRatio(70, 140, true)).toBeCloseTo(1, 6);
  });
});

describe("mergeTrackAnalyses and cross-track branching", () => {
  it("merges track metadata, offsets timestamps, and limits edges when crossTrackOnly is true", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 4,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 1,
    });
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 4,
      beatDuration: 0.4,
      tempo: 150,
      pitchValue: 0.5,
      timbreValue: 1,
    });

    const merged = mergeTrackAnalyses(
      [
        { analysis: trackA, title: "Song A" },
        { analysis: trackB, title: "Song B" },
      ],
      { tempoSync: false },
    );

    expect(merged.tracks).toHaveLength(2);
    expect(merged.tracks?.[0]).toMatchObject({
      trackIndex: 0,
      startTimeOffset: 0,
      startBeatIndex: 0,
      beatCount: 4,
      tempoRatio: 1,
    });
    expect(merged.tracks?.[1]).toMatchObject({
      trackIndex: 1,
      startTimeOffset: 2,
      startBeatIndex: 4,
      beatCount: 4,
      tempoRatio: 1,
    });
    expect(merged.beats[4].trackIndex).toBe(1);
    expect(merged.beats[4].localWhich).toBe(0);
    expect(merged.beats[4].start).toBeCloseTo(2, 6);

    const graph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      currentThreshold: 20,
    });
    expect(graph.allEdges.length).toBeGreaterThan(0);
    for (const edge of graph.allEdges) {
      expect(edge.src.trackIndex).not.toBe(edge.dest.trackIndex);
    }
    for (const beat of merged.beats) {
      for (const edge of beat.neighbors) {
        expect(edge.src.trackIndex).not.toBe(edge.dest.trackIndex);
      }
    }
  });

  it("wraps at the end of track 0 back to track 0 start instead of bleeding into track 1", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 4,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.1,
      timbreValue: 1,
    });
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 4,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.9,
      timbreValue: 50,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const scheduleJump = vi.fn(() => true);
    const player: JukeboxPlayer = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      scheduleJump,
      cancelScheduledJump: vi.fn(),
      getCurrentTime: () => 1.5,
      getAudioTime: () => 1.5,
      getPlaybackRate: () => 1,
      isPlaying: () => true,
    };

    const engine = new JukeboxEngine(player, {
      config: {
        crossTrackOnly: true,
        currentThreshold: 5,
        minRandomBranchChance: 0,
        maxRandomBranchChance: 0,
      },
    });
    engine.loadAnalysis(merged);
    engine.seekToBeat(3);

    const engineInternal = engine as unknown as {
      advanceBeat: (audioTime: number) => void;
      currentBeatIndex: number;
      lastJumpToIndex: number | null;
    };
    engineInternal.advanceBeat(2.0);

    expect(scheduleJump).toHaveBeenCalledWith(0, 2.0, null);
    expect(engineInternal.currentBeatIndex).toBe(0);
    expect(engineInternal.lastJumpToIndex).toBe(0);
  });

  it("aligns segment loudness across tracks when normalizeLoudness is true", () => {
    const trackA = makeRawTrack({
      title: "Loud A",
      beatCount: 2,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 1,
    });
    const trackB = makeRawTrack({
      title: "Quiet B",
      beatCount: 2,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 1,
    });
    for (const seg of trackB.segments) {
      seg.loudness_start = -20;
      seg.loudness_max = -12;
    }

    const unnormalized = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { normalizeLoudness: false },
    );
    expect(beatPairDistance(unnormalized.beats[0], unnormalized.beats[2])).toBeGreaterThan(0);

    const normalized = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { normalizeLoudness: true },
    );
    expect(normalized.segments[2].loudness_start).toBeCloseTo(-12, 6);
    expect(normalized.segments[2].loudness_max).toBeCloseTo(-4, 6);
    expect(beatPairDistance(normalized.beats[0], normalized.beats[2])).toBeCloseTo(0, 6);
  });

  it("filters cross-track edges by maxLongBranch using normalized song progress", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 10,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 1,
    });
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 10,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 1,
    });
    // Make beat 0 in Song A match beat 0 and beat 8 in Song B closely, while
    // keeping beat 0->0 short-span (0% diff) and beat 0->8 long-span (~89% diff).
    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      currentThreshold: 20,
      maxLongBranch: 4,
      maxLongBranchPercent: 20,
    });

    const beat0Neighbors = merged.beats[0].neighbors;
    expect(beat0Neighbors.length).toBeGreaterThan(0);
    for (const edge of beat0Neighbors) {
      const srcFrac = (edge.src.localWhich ?? 0) / 9;
      const destFrac = (edge.dest.localWhich ?? 0) / 9;
      expect(Math.abs(destFrac - srcFrac) * merged.beats.length).toBeLessThanOrEqual(4);
    }
  });

  it("filters same-track edges in multi-track mode using normalized per-song progress", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 10,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.1,
      timbreValue: 1,
    });
    // Use 2-beat bars so beat 0 matches beats 2, 4, 6, and 8 on bar position.
    trackA.bars = Array.from({ length: 5 }, (_, i) => ({
      start: i,
      duration: 1,
      confidence: 0.9,
    }));
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 10,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.5,
      timbreValue: 20,
    });
    const trackC = makeRawTrack({
      title: "Song C",
      beatCount: 10,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.9,
      timbreValue: 40,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }, { analysis: trackC }],
      { tempoSync: true },
    );
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      currentThreshold: 20,
      justLongBranches: true,
      minLongBranch: 6,
      minLongBranchPercent: 20,
      maxLongBranch: 15,
      maxLongBranchPercent: 50,
    });

    const beat0DestIndices = merged.beats[0].neighbors
      .map((edge) => edge.dest.which)
      .sort((a, b) => a - b);
    // Raw deltas 2 and 4 normalize to ~6.67 and ~13.33 (within [6, 15]),
    // whereas raw deltas 6 and 8 normalize to 20 and ~26.67 (over the cap of 15).
    expect(beat0DestIndices).toEqual([2, 4]);
  });

  it("computes and filters independent same-track and cross-track thresholds when crossTrackOnly is false", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 12,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.1,
      timbreValue: 1,
    });
    // Give beat 4 a moderate intra-track distance (~6.93 after segment averaging) while beat 8 matches beat 0 (distance 0).
    // Use 4-beat bars so beats 0, 4, and 8 share bar position 0.
    trackA.bars = Array.from({ length: 3 }, (_, i) => ({
      start: i * 2,
      duration: 2,
      confidence: 0.9,
    }));
    trackA.segments[4].pitches = new Array(12).fill(0.5);
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 12,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.6,
      timbreValue: 5,
    });
    trackB.bars = Array.from({ length: 3 }, (_, i) => ({
      start: i * 2,
      duration: 2,
      confidence: 0.9,
    }));

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const autoGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      maxBranches: 2,
      crossTrackOnly: false,
      currentThreshold: 0,
      crossTrackThreshold: 0,
    });

    // Separate precalculation pools ensure close same-song beats cannot crowd out cross-song candidates.
    const beat0CrossCandidates = merged.beats[0].allNeighbors.filter(
      (edge) => edge.dest.trackIndex !== edge.src.trackIndex,
    );
    expect(beat0CrossCandidates.length).toBeGreaterThan(0);
    expect(autoGraph.computedCrossThreshold).toBeDefined();
    expect(autoGraph.computedCrossThreshold!).toBeGreaterThan(
      autoGraph.computedThreshold,
    );

    // Tightening crossTrackThreshold drops cross-song edges without dropping same-song edges.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      maxBranches: 2,
      crossTrackOnly: false,
      currentThreshold: 5,
      crossTrackThreshold: 20,
    });
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.trackIndex === 1),
    ).toBe(false);
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.which === 8),
    ).toBe(true);
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.which === 4),
    ).toBe(false);

    // Raising currentThreshold adds beat 4 without enabling cross-track edges.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      maxBranches: 2,
      crossTrackOnly: false,
      currentThreshold: 10,
      crossTrackThreshold: 20,
    });
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.which === 4),
    ).toBe(true);
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.trackIndex === 1),
    ).toBe(false);

    // Raising crossTrackThreshold independently restores cross-track edges.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      maxBranches: 2,
      crossTrackOnly: false,
      currentThreshold: 10,
      crossTrackThreshold: 40,
    });
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.which === 4),
    ).toBe(true);
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.trackIndex === 1),
    ).toBe(true);
  });

  it("uses crossTrackThreshold independently of currentThreshold when crossTrackOnly is true", () => {
    const trackA = makeRawTrack({
      title: "Song A",
      beatCount: 8,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.1,
      timbreValue: 1,
    });
    const trackB = makeRawTrack({
      title: "Song B",
      beatCount: 8,
      beatDuration: 0.5,
      tempo: 120,
      pitchValue: 0.6,
      timbreValue: 5,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      currentThreshold: 5,
      crossTrackThreshold: 40,
    });
    expect(merged.beats[0].neighbors.length).toBeGreaterThan(0);

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      currentThreshold: 60,
      crossTrackThreshold: 20,
    });
    expect(merged.beats[0].neighbors).toHaveLength(0);
  });
});

describe("combineAudioBuffers volume normalization and per-track gain", () => {
  it("scales secondary tracks to match master RMS and respects peak ceiling", () => {
    const ctx = makeFakeAudioContext(1000);
    const master = makeFakeAudioBuffer([[0.4, -0.4, 0.4, -0.4]], 1000);
    const quiet = makeFakeAudioBuffer([[0.1, -0.1, 0.1, -0.1]], 1000);
    const spiky = makeFakeAudioBuffer(
      [[
        0.02, -0.02, 0.02, -0.02, 0.02, -0.02, 0.02, -0.02,
        0.02, -0.02, 0.02, -0.02, 0.02, -0.02, 0.5, 0.02,
      ]],
      1000,
    );

    const normalized = combineAudioBuffers(
      ctx,
      [
        { buffer: master, gain: 0.5 },
        { buffer: quiet, gain: 1 },
        { buffer: spiky, gain: 1 },
      ],
      { normalizeVolume: true },
    );

    const out = normalized.buffer.getChannelData(0);
    // Master slice scaled by user gain 0.5 -> 0.2
    expect(out[0]).toBeCloseTo(0.2, 5);
    // Quiet slice (RMS 0.1) boosted 4x to match master RMS 0.4 -> 0.4
    expect(out[4]).toBeCloseTo(0.4, 5);
    // Spiky slice (RMS ~0.126, raw boost ~3.16x) capped by 0.98 / 0.5 = 1.96x ceiling
    expect(normalized.appliedGains[2]).toBeCloseTo(1.96, 5);
    expect(Math.abs(out[8 + 14])).toBeCloseTo(0.98, 5);
  });
});
