import { describe, expect, it } from "vitest";
import { buildJumpGraph } from "./graph";
import { DEFAULT_JUKEBOX_CONFIG } from "./JukeboxEngine";
import { mergeTrackAnalyses } from "./multiTrack";
import {
  clampTimeSignatureDenominator,
  clampTimeSignatureNumerator,
  clampTimeSignatureTrackOffset,
  resolveTimeSignatureBranchStepBeats,
} from "./timeSignatureBranching";

const CHORDS = {
  C: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  G: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
  Am: [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
  F: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
  Dm: [0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0],
  Em: [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
  Bb: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  Eb: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
} as const;

/**
 * Builds a synthetic single-track analysis from a per-beat chord progression
 * with configurable timbre/loudness divergence.
 */
function makeChromaTrack(opts: {
  title: string;
  progression: ReadonlyArray<readonly number[]>;
  beatDuration?: number;
  beatsPerBar?: number;
  timbreShift?: number;
  loudnessOffset?: number;
}) {
  const beatDuration = opts.beatDuration ?? 0.5;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const beatCount = opts.progression.length;
  const totalDuration = beatCount * beatDuration;
  const timbreShift = opts.timbreShift ?? 0;
  const loudnessOffset = opts.loudnessOffset ?? 0;

  const barCount = Math.ceil(beatCount / beatsPerBar);
  const bars = Array.from({ length: barCount }, (_, i) => ({
    start: i * beatsPerBar * beatDuration,
    duration: Math.min(
      beatsPerBar * beatDuration,
      totalDuration - i * beatsPerBar * beatDuration,
    ),
    confidence: 0.9,
  }));

  const beats = Array.from({ length: beatCount }, (_, i) => ({
    start: i * beatDuration,
    duration: beatDuration,
    confidence: 0.9,
  }));

  const segments = opts.progression.map((pitches, i) => ({
    start: i * beatDuration,
    duration: beatDuration,
    confidence: 0.9,
    loudness_start: -12 + loudnessOffset,
    loudness_max: -8 + loudnessOffset,
    loudness_max_time: beatDuration * 0.2,
    pitches: [...pitches],
    timbre: Array.from({ length: 12 }, (_, k) =>
      (k % 2 === 0 ? 5 : -5) + timbreShift,
    ),
  }));

  return {
    sections: [{ start: 0, duration: totalDuration, confidence: 1 }],
    bars,
    beats,
    tatums: beats.map((b) => ({ ...b })),
    segments,
    track: {
      title: opts.title,
      duration: totalDuration,
      tempo: 60 / beatDuration,
      time_signature: beatsPerBar,
    },
  };
}

const VERSE = [
  CHORDS.C,
  CHORDS.G,
  CHORDS.Am,
  CHORDS.F,
  CHORDS.C,
  CHORDS.Dm,
  CHORDS.G,
  CHORDS.C,
];
const CHORUS = [
  CHORDS.F,
  CHORDS.G,
  CHORDS.Em,
  CHORDS.Am,
  CHORDS.F,
  CHORDS.G,
  CHORDS.C,
  CHORDS.C,
];
const SONG = [...VERSE, ...CHORUS];

describe("timeSignatureBranching", () => {
  it("resolves beat spacing and clamps numerator, denominator, and per-track offsets", () => {
    expect(resolveTimeSignatureBranchStepBeats(4, 4)).toBe(4);
    expect(resolveTimeSignatureBranchStepBeats(3, 4)).toBe(3);
    expect(resolveTimeSignatureBranchStepBeats(8, 4)).toBe(8);
    expect(resolveTimeSignatureBranchStepBeats(16, 4)).toBe(16);
    expect(resolveTimeSignatureBranchStepBeats(4, 2)).toBe(8);
    expect(resolveTimeSignatureBranchStepBeats(6, 8)).toBe(3);
    expect(resolveTimeSignatureBranchStepBeats(12, 8)).toBe(6);

    expect(clampTimeSignatureNumerator(undefined)).toBe(4);
    expect(clampTimeSignatureNumerator(Number.NaN)).toBe(4);
    expect(clampTimeSignatureNumerator(0)).toBe(1);
    expect(clampTimeSignatureNumerator(128)).toBe(64);

    expect(clampTimeSignatureDenominator(undefined)).toBe(4);
    expect(clampTimeSignatureDenominator(0)).toBe(1);
    expect(clampTimeSignatureDenominator(32)).toBe(16);

    expect(clampTimeSignatureTrackOffset(-0)).toBe(0);
    expect(clampTimeSignatureTrackOffset(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampTimeSignatureTrackOffset(-999)).toBe(-256);
    expect(clampTimeSignatureTrackOffset(999)).toBe(256);
  });

  it("overwrites cross-track similarity branches with 4/4 bar boundaries when crossTrackOnly is enabled", () => {
    const trackA = makeChromaTrack({ title: "Original", progression: SONG });
    // High timbre shift and detuned pitch energy that would fail tight thresholds.
    const trackB = makeChromaTrack({
      title: "Cover With Divergence",
      progression: SONG.map((p) =>
        p.map((v, k) => (k === 1 ? Math.min(1, v + 0.35) : v)),
      ),
      timbreShift: 45,
      loudnessOffset: -8,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const graph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      justBackwards: true,
      justLongBranches: true,
      minLongBranch: 20,
      maxLongBranch: 2,
      crossTrackThreshold: 2,
      currentThreshold: 2,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    expect(graph.computedThreshold).toBe(0);
    expect(graph.currentThreshold).toBe(0);
    expect(graph.computedCrossThreshold).toBe(0);
    expect(graph.currentCrossThreshold).toBe(0);
    expect(graph.lastBranchPoint).toBe(-1);

    // Every beat on boundaries 0, 4, 8, 12 branches symmetrically across tracks only.
    const expectedBoundaries = new Set([0, 4, 8, 12]);
    for (let i = 0; i < SONG.length; i += 1) {
      const beatA = merged.beats[i];
      const beatB = merged.beats[SONG.length + i];
      if (expectedBoundaries.has(i)) {
        expect(beatA.neighbors).toHaveLength(1);
        expect(beatA.neighbors[0].dest.trackIndex).toBe(1);
        expect(beatA.neighbors[0].dest.localWhich).toBe(i);
        expect(beatA.neighbors[0].distance).toBe(0);

        expect(beatB.neighbors).toHaveLength(1);
        expect(beatB.neighbors[0].dest.trackIndex).toBe(0);
        expect(beatB.neighbors[0].dest.localWhich).toBe(i);
        expect(beatB.neighbors[0].distance).toBe(0);
      } else {
        expect(beatA.neighbors).toHaveLength(0);
        expect(beatB.neighbors).toHaveLength(0);
      }
    }
  });

  it("preserves local same-track branches alongside 4/4 cross-track boundaries when crossTrackOnly is false", () => {
    const trackA = makeChromaTrack({ title: "Original", progression: SONG });
    const trackB = makeChromaTrack({
      title: "Cover With Divergence",
      progression: SONG.map((p) =>
        p.map((v, k) => (k === 1 ? Math.min(1, v + 0.35) : v)),
      ),
      timbreShift: 45,
      loudnessOffset: -8,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const graph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      coverSync: true,
      currentThreshold: 20,
      crossTrackThreshold: 2,
      removeSequentialBranches: true,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    expect(graph.computedThreshold).toBeGreaterThan(0);
    expect(graph.currentThreshold).toBe(20);
    expect(graph.computedCrossThreshold).toBe(0);
    expect(graph.currentCrossThreshold).toBe(0);
    expect(graph.lastBranchPoint).toBe(-1);

    // Same-track local branches remain active (e.g., beat 0 CHORDS.C -> CHORDS.C beats in track 0).
    const sameTrackAtBeat0 = merged.beats[0].neighbors.filter(
      (edge) => edge.dest.trackIndex === 0,
    );
    expect(sameTrackAtBeat0.length).toBeGreaterThan(0);

    // Cross-track edges remain strictly on 4/4 bar boundaries and bypass crossTrackThreshold.
    const crossTrackAtBeat0 = merged.beats[0].neighbors.filter(
      (edge) => edge.dest.trackIndex === 1,
    );
    expect(crossTrackAtBeat0.map((edge) => edge.dest.localWhich)).toEqual([0]);
    const crossTrackAtBeat1 = merged.beats[1].neighbors.filter(
      (edge) => edge.dest.trackIndex === 1,
    );
    expect(crossTrackAtBeat1).toHaveLength(0);
    const crossTrackAtBeat4 = merged.beats[4].neighbors.filter(
      (edge) => edge.dest.trackIndex === 1,
    );
    expect(crossTrackAtBeat4.map((edge) => edge.dest.localWhich)).toEqual([4]);
  });

  it("aligns different intro lengths via Cover sync DTW and applies per-track offsets", () => {
    const intro = [
      CHORDS.Dm,
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.Em,
      CHORDS.Am,
      CHORDS.G,
    ];
    const trackA = makeChromaTrack({ title: "Cover A", progression: SONG });
    const trackB = makeChromaTrack({
      title: "Cover B With Intro",
      progression: [...intro, ...SONG],
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    const trackBStart = SONG.length;

    // Neutral offsets [0, 0]: Cover A beats [0, 4, 8, 12] -> Cover B [6, 10, 14, 18].
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(merged.beats[0].neighbors[0].dest.localWhich).toBe(intro.length);
    expect(merged.beats[4].neighbors[0].dest.localWhich).toBe(intro.length + 4);
    expect(merged.beats[8].neighbors[0].dest.localWhich).toBe(intro.length + 8);
    expect(merged.beats[trackBStart + intro.length + 4].neighbors[0].dest.localWhich).toBe(4);

    // Shifting both tracks by +2 shifts the shared boundary grid without double-shifting B.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [2, 2],
    });
    expect(merged.beats[0].neighbors).toHaveLength(0);
    expect(merged.beats[2].neighbors[0].dest.localWhich).toBe(intro.length + 2);
    expect(merged.beats[6].neighbors[0].dest.localWhich).toBe(intro.length + 6);

    // Adjusting only Track 2 offset by +1 shifts Track 2 targets by +1.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 1],
    });
    expect(merged.beats[0].neighbors[0].dest.localWhich).toBe(intro.length + 1);
    expect(merged.beats[4].neighbors[0].dest.localWhich).toBe(intro.length + 5);

    // Adjusting only Track 1 offset by +1 shifts Track 1 sources while keeping Track 2 anchored to aligned[1] -> intro.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [1, 0],
    });
    expect(merged.beats[1].neighbors[0].dest.localWhich).toBe(intro.length);
    expect(merged.beats[5].neighbors[0].dest.localWhich).toBe(intro.length + 4);
  });

  it("supports direct per-track offset alignment when Cover sync is off, including 3-track mixes and deletions", () => {
    const trackA = makeChromaTrack({ title: "Track 1", progression: SONG });
    const trackB = makeChromaTrack({ title: "Track 2", progression: SONG });
    const trackC = makeChromaTrack({ title: "Track 3", progression: SONG });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }, { analysis: trackC }],
      { tempoSync: true },
    );

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 2, -2],
    });

    // At bar m=0: A=0, B=2, C=-2 (skipped) -> only A <-> B connects at (0, 2).
    expect(merged.beats[0].neighbors.map((e) => [e.dest.trackIndex, e.dest.localWhich])).toEqual([
      [1, 2],
    ]);
    // At bar m=1: A=4, B=6, C=2 -> all 3 connect symmetrically.
    expect(merged.beats[4].neighbors.map((e) => [e.dest.trackIndex, e.dest.localWhich])).toEqual([
      [1, 6],
      [2, 2],
    ]);
    expect(
      merged.beats[SONG.length * 2 + 2].neighbors.map((e) => [
        e.dest.trackIndex,
        e.dest.localWhich,
      ]),
    ).toEqual([
      [0, 4],
      [1, 6],
    ]);

    // Deleting an edge keeps it filtered out when rebuilding with cached params.
    const edgeToDelete = merged.beats[4].neighbors[0];
    edgeToDelete.deleted = true;
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 2, -2],
    });
    expect(merged.beats[4].neighbors.map((e) => [e.dest.trackIndex, e.dest.localWhich])).toEqual([
      [2, 2],
    ]);
  });

  it("invalidates cached neighbor graphs across signature changes, crossTrackOnly toggles, and disabling the mode", () => {
    const trackA = makeChromaTrack({ title: "A", progression: SONG });
    const trackB = makeChromaTrack({ title: "B", progression: SONG });
    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    // 4/4 -> step 4
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(merged.beats[4].neighbors).toHaveLength(1);
    expect(merged.beats[8].neighbors).toHaveLength(1);

    // 8/4 -> step 8 (beat 4 no longer branches)
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 8,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(merged.beats[4].neighbors).toHaveLength(0);
    expect(merged.beats[8].neighbors).toHaveLength(1);

    // 4/8 -> step 2 (beat 2 and beat 6 now branch)
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 8,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(merged.beats[2].neighbors).toHaveLength(1);
    expect(merged.beats[6].neighbors).toHaveLength(1);

    // Non-zero offset where beat 0 has no neighbors, then changing back to [0, 0] hits/invalidates cache properly.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [1, 1],
    });
    expect(merged.beats[0].neighbors).toHaveLength(0);
    expect(merged.beats[1].neighbors).toHaveLength(1);

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [1, 1],
    });
    expect(merged.beats[1].neighbors).toHaveLength(1);

    // Enabling local same-track branches while keeping time-signature branching rebuilds cleanly.
    const hybridGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      coverSync: false,
      currentThreshold: 20,
      timeSignatureBranching: true,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [1, 1],
    });
    expect(hybridGraph.computedThreshold).toBeGreaterThan(0);
    expect(
      merged.beats[0].neighbors.some((edge) => edge.dest.trackIndex === 0),
    ).toBe(true);
    expect(
      merged.beats[1].neighbors.some((edge) => edge.dest.trackIndex === 1),
    ).toBe(true);

    // Turning timeSignatureBranching off restores normal similarity graph building.
    const similarityGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      coverSync: true,
      crossTrackOnly: true,
      timeSignatureBranching: false,
    });
    expect(similarityGraph.computedThreshold).toBeGreaterThan(0);
    expect(merged.beats[0].neighbors).toHaveLength(1);
    expect(merged.beats[1].neighbors).toHaveLength(1);
  });
});
