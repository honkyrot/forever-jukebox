import { describe, expect, it } from "vitest";
import { buildJumpGraph } from "./graph";
import { DEFAULT_JUKEBOX_CONFIG } from "./JukeboxEngine";
import { mergeTrackAnalyses } from "./multiTrack";
import type { QuantumBase } from "./types";
import {
  clampTimeSignatureDenominator,
  clampTimeSignatureNumerator,
  clampTimeSignatureTrackOffset,
  normalizeTimeSignatureBranchMode,
  resolveTimeSignatureBeatPosition,
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

  it("combines 4/4 bar boundaries with similarity branches while preserving crossTrackThreshold and computedCrossThreshold", () => {
    const instBar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const vocalBar = [CHORDS.Dm, CHORDS.G, CHORDS.Em, CHORDS.C];
    const progression = [...instBar, ...vocalBar, ...instBar, ...vocalBar];
    const trackA = makeChromaTrack({ title: "Human", progression });
    const trackB = makeChromaTrack({ title: "Vocaloid", progression });

    // Diverge the vocal bars in opposite directions on Track A vs Track B (while
    // keeping instrumental bars 0..3 and 8..11 identical) so similarity at
    // threshold 25 connects instrumental bars (including diagonals) and leaves
    // vocal sections unbranched unless bar-boundary links are layered in.
    for (const beatIdx of [4, 5, 6, 7, 12, 13, 14, 15]) {
      const segA = trackA.segments[beatIdx];
      segA.timbre = segA.timbre.map((v) => v - 40);
      segA.loudness_start += 6;
      segA.loudness_max += 6;

      const segB = trackB.segments[beatIdx];
      segB.timbre = segB.timbre.map((v) => v + 45);
      segB.loudness_start -= 8;
      segB.loudness_max -= 8;
      segB.pitches = segB.pitches.map((v, k) =>
        k === 1 ? Math.min(1, v + 0.35) : v,
      );
    }

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const baselineGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 0,
      timeSignatureBranching: false,
    });

    const combinedGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 25,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    expect(combinedGraph.computedCrossThreshold).toBe(
      baselineGraph.computedCrossThreshold,
    );
    expect(combinedGraph.currentCrossThreshold).toBe(25);

    // Beat 0 (instrumental downbeat) keeps both parallel (0) and diagonal (8) matches without duplicates.
    const beat0Dests = merged.beats[0].neighbors.map((e) => e.dest.localWhich);
    expect(beat0Dests.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 8]);
    expect(
      merged.beats[0].neighbors.find((e) => e.dest.localWhich === 0)
        ?.timeSignature,
    ).toBe(true);

    // Hard cut: 100%-identical instrumental mid-bar beats (1..3, 9..11) cannot branch.
    for (const beatIdx of [1, 2, 3, 9, 10, 11]) {
      expect(merged.beats[beatIdx].neighbors).toHaveLength(0);
    }

    // Vocal downbeats (4 and 12) get 1-to-1 aligned 4/4 cross-track links despite distance > 25.
    expect(merged.beats[4].neighbors.map((e) => e.dest.localWhich)).toEqual([4]);
    expect(merged.beats[4].neighbors[0].timeSignature).toBe(true);
    expect(merged.beats[4].neighbors[0].distance).toBeGreaterThan(25);
    expect(merged.beats[12].neighbors.map((e) => e.dest.localWhich)).toEqual([
      12,
    ]);

    // Vocal mid-bar beats (5, 6, 7, 13, 14, 15) stay unbranched so vocals aren't chopped mid-bar.
    for (const beatIdx of [5, 6, 7, 13, 14, 15]) {
      expect(merged.beats[beatIdx].neighbors).toHaveLength(0);
    }

    // Even with threshold maxed to 80 and same-track branches enabled, mid-bar beats stay empty.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      currentThreshold: 80,
      crossTrackThreshold: 80,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    for (let i = 0; i < progression.length; i += 1) {
      if (i % 4 !== 0) {
        expect(merged.beats[i].neighbors).toHaveLength(0);
        expect(merged.beats[progression.length + i].neighbors).toHaveLength(0);
      }
    }

    // Switching to overwrite removes diagonal similarity jumps and mid-bar instrumental jumps.
    const overwriteGraph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 25,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "overwrite",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(overwriteGraph.computedCrossThreshold).toBe(0);
    expect(merged.beats[0].neighbors.map((e) => e.dest.localWhich)).toEqual([0]);
    expect(merged.beats[1].neighbors).toHaveLength(0);
  });

  it("applies direction/sequential filters to similarity edges while preserving time-signature links in combine mode", () => {
    const instBar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const vocalBar = [CHORDS.Dm, CHORDS.G, CHORDS.Em, CHORDS.C];
    const progression = [...instBar, ...vocalBar, ...instBar, ...vocalBar];
    const trackA = makeChromaTrack({ title: "Track A", progression });
    const trackB = makeChromaTrack({ title: "Track B", progression });
    for (const beatIdx of [4, 5, 6, 7, 12, 13, 14, 15]) {
      const seg = trackB.segments[beatIdx];
      seg.timbre = seg.timbre.map((v) => v + 45);
      seg.loudness_start -= 8;
      seg.loudness_max -= 8;
    }

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      coverSync: false,
      justBackwards: true,
      removeSequentialBranches: true,
      currentThreshold: 20,
      crossTrackThreshold: 20,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    // Same-track forward edge 0 -> 8 is blocked by justBackwards, while 0 -> trackB(0)
    // is a time-signature bar link and remains intact.
    expect(
      merged.beats[0].neighbors.some(
        (e) => e.dest.trackIndex === 0 && e.dest.which > 0,
      ),
    ).toBe(false);
    expect(
      merged.beats[0].neighbors.some(
        (e) => e.dest.trackIndex === 1 && e.dest.localWhich === 0,
      ),
    ).toBe(true);
    expect(
      merged.beats[4].neighbors.some(
        (e) => e.dest.trackIndex === 1 && e.dest.localWhich === 4,
      ),
    ).toBe(true);
  });

  it("combines Cover sync DTW bar boundaries with similarity edges across differing intros", () => {
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
      timbreShift: 45,
      loudnessOffset: -8,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      crossTrackThreshold: 2,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    expect(merged.beats[0].neighbors[0].dest.localWhich).toBe(intro.length);
    expect(merged.beats[4].neighbors[0].dest.localWhich).toBe(intro.length + 4);

    // Non-boundary beats remain hard-cut even when Cover Sync DTW aligns every beat.
    expect(merged.beats[1].neighbors).toHaveLength(0);
    expect(merged.beats[2].neighbors).toHaveLength(0);
    expect(merged.beats[SONG.length + intro.length + 1].neighbors).toHaveLength(0);
  });

  it("respects per-track offsets in combine mode without applying indexInParent mismatch penalty", () => {
    const bar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const shiftedBar = [CHORDS.F, CHORDS.C, CHORDS.G, CHORDS.Am];
    const trackA = makeChromaTrack({
      title: "Track A",
      progression: [...bar, ...bar, ...bar, ...bar],
    });
    const trackB = makeChromaTrack({
      title: "Track B Shifted",
      progression: [...shiftedBar, ...shiftedBar, ...shiftedBar, ...shiftedBar],
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: false,
      crossTrackThreshold: 15,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 1],
    });

    // Track A boundary beat 0 (indexInParent=0) similarity-matches all Track B
    // offset boundary beats {1, 5, 9, 13} (indexInParent=1) with distance < 15;
    // beat 12 keeps all four active including its time-signature link to beat 13.
    const beat0AllDests = merged.beats[0].allNeighbors
      .map((e) => e.dest.localWhich)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(beat0AllDests).toEqual([1, 5, 9, 13]);
    const beat12Dests = merged.beats[12].neighbors
      .map((e) => e.dest.localWhich)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(beat12Dests).toEqual([1, 5, 9, 13]);

    // Every non-boundary beat on both tracks has 0 neighbors.
    const trackABoundaries = new Set([0, 4, 8, 12]);
    const trackBBoundaries = new Set([1, 5, 9, 13]);
    for (let i = 0; i < 16; i += 1) {
      if (!trackABoundaries.has(i)) {
        expect(merged.beats[i].neighbors).toHaveLength(0);
      }
      if (!trackBBoundaries.has(i)) {
        expect(merged.beats[16 + i].neighbors).toHaveLength(0);
      }
    }
  });

  it("scales auto cross-threshold to eligible boundary beats for wide time signatures like 8/4", () => {
    const bar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const trackA = makeChromaTrack({
      title: "Track A",
      progression: [...bar, ...bar, ...bar, ...bar],
    });
    const trackB = makeChromaTrack({
      title: "Track B",
      progression: [...bar, ...bar, ...bar, ...bar],
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    const graph = buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 0,
      timeSignatureBranching: false,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 8,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });

    // 8/4 has only 4 eligible boundary beats across 32 total beats (4/32 < 1/6);
    // scaling to eligible boundary beats avoids saturating computedCrossThreshold at 80.
    expect(graph.computedCrossThreshold).toBeLessThan(80);
    expect(merged.beats[0].neighbors.length).toBeGreaterThan(0);
    expect(merged.beats[8].neighbors.length).toBeGreaterThan(0);
    expect(merged.beats[4].neighbors).toHaveLength(0);
  });

  it("supports similarity-only bar restriction separately and with an independent auto-create meter (4/4 + 4/2)", () => {
    expect(normalizeTimeSignatureBranchMode("combine")).toBe("combine");
    expect(normalizeTimeSignatureBranchMode("restrict")).toBe("overwrite");

    const instBar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const vocalBar = [CHORDS.Dm, CHORDS.G, CHORDS.Em, CHORDS.C];
    const progression = [...instBar, ...instBar, ...vocalBar, ...vocalBar];
    const trackA = makeChromaTrack({ title: "Human", progression });
    const trackB = makeChromaTrack({ title: "Vocaloid", progression });

    for (let beatIdx = 8; beatIdx < 16; beatIdx += 1) {
      const segA = trackA.segments[beatIdx];
      segA.timbre = segA.timbre.map((v) => v - 40);
      segA.loudness_start += 6;
      segA.loudness_max += 6;

      const segB = trackB.segments[beatIdx];
      segB.timbre = segB.timbre.map((v) => v + 45);
      segB.loudness_start -= 8;
      segB.loudness_max -= 8;
      segB.pitches = segB.pitches.map((v, k) =>
        k === 1 ? Math.min(1, v + 0.35) : v,
      );
    }

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    // Similarity restricted to 4/4 ONLY (auto-create off): instrumental 4/4 beats (0, 4)
    // connect via similarity; mid-bar beats and divergent vocal 4/4 beats (8, 12) stay empty.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 25,
      timeSignatureBranching: false,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(
      merged.beats[progression.length].neighbors
        .map((e) => e.dest.localWhich)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([0, 4]);
    expect(merged.beats[1].neighbors).toHaveLength(0);
    expect(merged.beats[8].neighbors).toHaveLength(0);
    expect(merged.beats[12].neighbors).toHaveLength(0);

    // Now enable auto-created 4/2 (step 8) layered onto 4/4 similarity restriction:
    // instrumental 4/4 beats (0, 4) still connect via similarity, vocal beat 8 (on 4/2)
    // gets an auto-created aligned link, while vocal beat 12 (4/4 only, not 4/2) stays empty.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 25,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 2,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(
      merged.beats[0].allNeighbors
        .map((e) => e.dest.localWhich)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([0, 4]);
    expect(
      merged.beats[4].allNeighbors
        .map((e) => e.dest.localWhich)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([0, 4]);
    expect(merged.beats[1].neighbors).toHaveLength(0);
    expect(merged.beats[5].neighbors).toHaveLength(0);
    expect(merged.beats[8].neighbors.map((e) => e.dest.localWhich)).toEqual([8]);
    expect(merged.beats[8].neighbors[0].timeSignature).toBe(true);
    expect(merged.beats[12].neighbors).toHaveLength(0);

    // Without similarity restriction, 4/2 combine layers aligned links onto unrestricted similarity.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      crossTrackThreshold: 25,
      timeSignatureBranching: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 2,
      timeSignatureSimilarityRestrict: false,
      timeSignatureTrackOffsets: [0, 0],
    });
    expect(merged.beats[1].allNeighbors.length).toBeGreaterThan(0);
    expect(merged.beats[8].neighbors.map((e) => e.dest.localWhich)).toEqual([8]);
    expect(merged.beats[12].neighbors).toHaveLength(0);
  });

  it("resolves beat position within a bar for direct offsets and Cover sync DTW alignments", () => {
    const intro = [
      CHORDS.Dm,
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.Em,
      CHORDS.Am,
      CHORDS.G,
    ];
    const trackA = makeChromaTrack({ title: "A", progression: SONG });
    const trackB = makeChromaTrack({
      title: "B",
      progression: [...intro, ...SONG],
    });
    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );

    // Direct offsets without Cover sync: beat 3 with offset 1 -> (3 - 1) % 4 = 2.
    expect(
      resolveTimeSignatureBeatPosition(merged.beats, merged.beats[3], {
        numerator: 4,
        denominator: 4,
        trackOffsets: [1, 0],
        useCoverSync: false,
      }),
    ).toBe(2);

    // With Cover sync DTW, Track B's aligned downbeat at intro.length (6) is beat 0 of the bar,
    // and beat intro.length + 3 (9) is beat 3 of the bar.
    const trackBStart = SONG.length;
    expect(
      resolveTimeSignatureBeatPosition(
        merged.beats,
        merged.beats[trackBStart + intro.length],
        {
          numerator: 4,
          denominator: 4,
          trackOffsets: [0, 0],
          useCoverSync: true,
        },
      ),
    ).toBe(0);
    expect(
      resolveTimeSignatureBeatPosition(
        merged.beats,
        merged.beats[trackBStart + intro.length + 3],
        {
          numerator: 4,
          denominator: 4,
          trackOffsets: [0, 0],
          useCoverSync: true,
        },
      ),
    ).toBe(3);
  });

  it("restricts single-track similarity branches to bar boundaries with offset and threshold scaling", () => {
    const bar = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const shiftedBar = [CHORDS.F, CHORDS.C, CHORDS.G, CHORDS.Am];
    const raw = makeChromaTrack({
      title: "Single",
      progression: [...shiftedBar, ...shiftedBar, ...shiftedBar, ...shiftedBar],
    });
    const beats: QuantumBase[] = raw.beats.map((b, i) => ({
      start: b.start,
      duration: b.duration,
      confidence: b.confidence,
      which: i,
      prev: null,
      next: null,
      indexInParent: i % 4,
      overlappingSegments: [{ ...raw.segments[i], which: i }],
      neighbors: [],
      allNeighbors: [],
    }));
    for (let i = 0; i < beats.length; i += 1) {
      beats[i].prev = i > 0 ? beats[i - 1] : null;
      beats[i].next = i < beats.length - 1 ? beats[i + 1] : null;
    }
    const singleAnalysis = {
      sections: [],
      bars: [],
      beats,
      tatums: [],
      segments: raw.segments.map((s, i) => ({ ...s, which: i })),
      track: raw.track,
    };

    // 4/4 with beat offset 1: only beats {1, 5, 9, 13} can connect, even at threshold 80.
    buildJumpGraph(singleAnalysis, {
      ...DEFAULT_JUKEBOX_CONFIG,
      currentThreshold: 80,
      timeSignatureSimilarityRestrict: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [1],
    });

    const allowed = new Set([1, 5, 9, 13]);
    for (let i = 0; i < beats.length; i += 1) {
      if (allowed.has(i)) {
        expect(beats[i].allNeighbors.length).toBeGreaterThan(0);
        for (const edge of beats[i].allNeighbors) {
          expect(allowed.has(edge.dest.which)).toBe(true);
        }
      } else {
        expect(beats[i].neighbors).toHaveLength(0);
        expect(beats[i].allNeighbors).toHaveLength(0);
      }
    }

    // 8/4 scales auto threshold to eligible boundary beats instead of saturating at 80.
    const sameBarSingle = makeChromaTrack({
      title: "Single 8/4",
      progression: [...bar, ...bar, ...bar, ...bar],
    });
    const beats84: QuantumBase[] = sameBarSingle.beats.map((b, i) => ({
      start: b.start,
      duration: b.duration,
      confidence: b.confidence,
      which: i,
      prev: null,
      next: null,
      indexInParent: i % 4,
      overlappingSegments: [{ ...sameBarSingle.segments[i], which: i }],
      neighbors: [],
      allNeighbors: [],
    }));
    for (let i = 0; i < beats84.length; i += 1) {
      beats84[i].prev = i > 0 ? beats84[i - 1] : null;
      beats84[i].next = i < beats84.length - 1 ? beats84[i + 1] : null;
    }
    const graph84 = buildJumpGraph(
      {
        sections: [],
        bars: [],
        beats: beats84,
        tatums: [],
        segments: sameBarSingle.segments.map((s, i) => ({ ...s, which: i })),
        track: sameBarSingle.track,
      },
      {
        ...DEFAULT_JUKEBOX_CONFIG,
        currentThreshold: 0,
        timeSignatureSimilarityRestrict: true,
        timeSignatureSimilarityNumerator: 8,
        timeSignatureSimilarityDenominator: 4,
        timeSignatureTrackOffsets: [0],
      },
    );
    expect(graph84.computedThreshold).toBeLessThan(80);
    expect(beats84[0].neighbors.length).toBeGreaterThan(0);
    expect(beats84[4].neighbors).toHaveLength(0);
  });
});
