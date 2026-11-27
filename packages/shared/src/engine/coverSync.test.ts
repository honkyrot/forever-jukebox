import { describe, expect, it } from "vitest";
import {
  alignTrackPairDtw,
  alignTrackPairMultiSectionDtw,
  extractTrackBeatFeatures,
} from "./coverSync";
import { buildJumpGraph } from "./graph";
import { DEFAULT_JUKEBOX_CONFIG } from "./JukeboxEngine";
import { mergeTrackAnalyses } from "./multiTrack";

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

function makeChromaTrack(opts: {
  title: string;
  progression: ReadonlyArray<readonly number[]>;
  beatDuration?: number;
  beatsPerBar?: number;
  timbreShift?: number;
  loudnessOffset?: number;
  sectionLoudness?: number[];
  sectionTimbreDelta?: number[];
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
    duration: Math.min(beatsPerBar * beatDuration, totalDuration - i * beatsPerBar * beatDuration),
    confidence: 0.9,
  }));

  const beats = Array.from({ length: beatCount }, (_, i) => ({
    start: i * beatDuration,
    duration: beatDuration,
    confidence: 0.9,
  }));

  const segments = opts.progression.map((pitches, i) => {
    const dynTimbre = opts.sectionTimbreDelta?.[i] ?? 0;
    const dynLoudness = opts.sectionLoudness?.[i] ?? -8;
    return {
      start: i * beatDuration,
      duration: beatDuration,
      confidence: 0.9,
      loudness_start: dynLoudness + loudnessOffset - 4,
      loudness_max: dynLoudness + loudnessOffset,
      loudness_max_time: beatDuration * 0.2,
      pitches: [...pitches],
      timbre: Array.from({ length: 12 }, (_, k) =>
        (k % 2 === 0 ? dynTimbre : -dynTimbre) + timbreShift,
      ),
    };
  });

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

// Two verses start on CHORDS.C (beat 0 and beat 16) separated by a chorus.
const VERSE1 = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F, CHORDS.C, CHORDS.Dm, CHORDS.G, CHORDS.C];
const CHORUS = [CHORDS.F, CHORDS.G, CHORDS.Em, CHORDS.Am, CHORDS.F, CHORDS.G, CHORDS.C, CHORDS.C];
const VERSE2 = [CHORDS.C, CHORDS.Em, CHORDS.Bb, CHORDS.Eb, CHORDS.F, CHORDS.Dm, CHORDS.G, CHORDS.C];
const FULL_SONG = [...VERSE1, ...CHORUS, ...VERSE2];

describe("coverSync alignment and graph integration", () => {
  it("aligns Verse 1 to Verse 1 and Verse 2 to Verse 2 despite vocal timbre and loudness shifts", () => {
    const sectionLoudness = FULL_SONG.map((_, i) => (i >= 8 && i < 16 ? -2 : -14));
    const sectionTimbre = FULL_SONG.map((_, i) => (i >= 8 && i < 16 ? 15 : -5));

    const trackA = makeChromaTrack({
      title: "Cover A",
      progression: FULL_SONG,
      sectionLoudness,
      sectionTimbreDelta: sectionTimbre,
    });
    const trackB = makeChromaTrack({
      title: "Cover B",
      progression: FULL_SONG,
      timbreShift: 45,
      loudnessOffset: -6,
      sectionLoudness,
      sectionTimbreDelta: sectionTimbre,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    const beatsA = merged.beats.filter((b) => b.trackIndex === 0);
    const beatsB = merged.beats.filter((b) => b.trackIndex === 1);
    const aligned = alignTrackPairDtw(
      extractTrackBeatFeatures(beatsA),
      extractTrackBeatFeatures(beatsB),
    );

    const byA = new Map(aligned.map((pair) => [pair.indexA, pair.indexB]));
    expect(byA.get(0)).toBe(0);
    expect(byA.get(16)).toBe(16);
    for (let i = 0; i < FULL_SONG.length; i += 1) {
      expect(byA.get(i)).toBe(i);
    }
  });

  it("handles different intro lengths by aligning across the true song offset", () => {
    const intro = [CHORDS.Dm, CHORDS.Bb, CHORDS.Eb, CHORDS.Em, CHORDS.Am, CHORDS.G];
    const trackA = makeChromaTrack({
      title: "Cover A",
      progression: FULL_SONG,
    });
    const trackB = makeChromaTrack({
      title: "Cover B With Intro",
      progression: [...intro, ...FULL_SONG],
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    const beatsA = merged.beats.filter((b) => b.trackIndex === 0);
    const beatsB = merged.beats.filter((b) => b.trackIndex === 1);
    const aligned = alignTrackPairDtw(
      extractTrackBeatFeatures(beatsA),
      extractTrackBeatFeatures(beatsB),
    );

    const byA = new Map(aligned.map((pair) => [pair.indexA, pair.indexB]));
    expect(byA.get(0)).toBe(intro.length);
    expect(byA.get(16)).toBe(intro.length + 16);
  });

  it("aligns accurately across non-4/4 and mismatched bar lengths without relying on indexInParent", () => {
    const trackA = makeChromaTrack({
      title: "Waltz 3/4",
      progression: FULL_SONG,
      beatsPerBar: 3,
    });
    const trackB = makeChromaTrack({
      title: "Four-Four",
      progression: FULL_SONG,
      beatsPerBar: 4,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    const beatsA = merged.beats.filter((b) => b.trackIndex === 0);
    const beatsB = merged.beats.filter((b) => b.trackIndex === 1);
    const aligned = alignTrackPairDtw(
      extractTrackBeatFeatures(beatsA),
      extractTrackBeatFeatures(beatsB),
    );

    const byA = new Map(aligned.map((pair) => [pair.indexA, pair.indexB]));
    for (let i = 0; i < FULL_SONG.length; i += 1) {
      expect(byA.get(i)).toBe(i);
    }
  });

  it("handles 2:1 half-time / double-time beat grids via DTW warping", () => {
    const sequence = [
      CHORDS.C,
      CHORDS.G,
      CHORDS.Am,
      CHORDS.F,
      CHORDS.Dm,
      CHORDS.Em,
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.C,
      CHORDS.F,
      CHORDS.G,
      CHORDS.C,
    ];
    const doubledSequence = sequence.flatMap((chord) => [chord, chord]);

    const trackA = makeChromaTrack({
      title: "Half-time grid",
      progression: sequence,
      beatDuration: 0.5,
    });
    const trackB = makeChromaTrack({
      title: "Double-time grid",
      progression: doubledSequence,
      beatDuration: 0.25,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: false },
    );
    const beatsA = merged.beats.filter((b) => b.trackIndex === 0);
    const beatsB = merged.beats.filter((b) => b.trackIndex === 1);
    const aligned = alignTrackPairDtw(
      extractTrackBeatFeatures(beatsA),
      extractTrackBeatFeatures(beatsB),
    );

    const targetsByA = new Map<number, number[]>();
    for (const pair of aligned) {
      const list = targetsByA.get(pair.indexA) ?? [];
      list.push(pair.indexB);
      targetsByA.set(pair.indexA, list);
    }

    for (let i = 1; i < sequence.length - 1; i += 1) {
      const targets = targetsByA.get(i) ?? [];
      expect(targets.some((j) => Math.abs(j - 2 * i) <= 1)).toBe(true);
    }
  });

  it("preserves aligned cross edges through direction, span, sequential, tail filters and respects crossTrackThreshold", () => {
    const trackA = makeChromaTrack({
      title: "Cover A",
      progression: FULL_SONG,
    });
    const trackB = makeChromaTrack({
      title: "Cover B",
      progression: FULL_SONG,
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
      removeSequentialBranches: true,
      crossTrackThreshold: 25,
    });

    expect(graph.lastBranchPoint).toBe(-1);
    // Beat 0 of Cover A maps to beat 0 of Cover B (localWhich 0), and tail beats stay active.
    const beat0Cross = merged.beats[0].neighbors;
    const lastTrackACross = merged.beats[FULL_SONG.length - 1].neighbors;
    expect(beat0Cross).toHaveLength(1);
    expect(beat0Cross[0].dest.trackIndex).toBe(1);
    expect(beat0Cross[0].dest.localWhich).toBe(0);
    expect(lastTrackACross).toHaveLength(1);
    expect(lastTrackACross[0].dest.trackIndex).toBe(1);
    expect(lastTrackACross[0].dest.localWhich).toBe(FULL_SONG.length - 1);

    // Setting crossTrackThreshold below 0.5 filters out edges when chord noise raises distance > 1.
    const noisyTrackB = makeChromaTrack({
      title: "Cover B Slightly Detuned",
      progression: FULL_SONG.map((p) => p.map((v, k) => (k === 1 ? v + 0.35 : v))),
    });
    const noisyMerged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: noisyTrackB }],
      { tempoSync: true },
    );
    buildJumpGraph(noisyMerged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      crossTrackThreshold: 2,
    });
    expect(noisyMerged.beats[0].neighbors).toHaveLength(0);

    // When crossTrackOnly is false, same-track edges build alongside cover-sync cross edges.
    const hybridMerged = mergeTrackAnalyses(
      [{ analysis: trackA }, { analysis: trackB }],
      { tempoSync: true },
    );
    buildJumpGraph(hybridMerged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: false,
      coverSync: true,
      currentThreshold: 20,
      crossTrackThreshold: 20,
      removeSequentialBranches: true,
    });
    expect(
      hybridMerged.beats[0].neighbors.some((edge) => edge.dest.trackIndex === 0),
    ).toBe(true);
    expect(
      hybridMerged.beats[0].neighbors.some(
        (edge) => edge.dest.trackIndex === 1 && edge.dest.localWhich === 0,
      ),
    ).toBe(true);
  });

  it("aligns shared repeated sections and leaves unique sections unmatched when track lengths differ", () => {
    const introV1C1 = [...VERSE1, ...CHORUS]; // 16 beats
    const uniqueV2 = [
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.Dm,
      CHORDS.Am,
      CHORDS.Bb,
      CHORDS.Eb,
      CHORDS.Dm,
      CHORDS.Eb,
      CHORDS.Bb,
      CHORDS.Dm,
    ]; // 12 distinct beats not present in short version
    const outro = [CHORDS.Am, CHORDS.F, CHORDS.C, CHORDS.G, CHORDS.C, CHORDS.C]; // 6 beats
    const fullSong = [...introV1C1, ...uniqueV2, ...CHORUS, ...outro]; // 42 beats
    const shortCover = [...introV1C1, ...outro]; // 22 beats

    const trackFull = makeChromaTrack({
      title: "JP Full (4 min)",
      progression: fullSong,
    });
    const trackShort = makeChromaTrack({
      title: "EN Short (2 min)",
      progression: shortCover,
    });

    const merged = mergeTrackAnalyses(
      [{ analysis: trackFull }, { analysis: trackShort }],
      { tempoSync: true },
    );
    const beatsFull = merged.beats.filter((b) => b.trackIndex === 0);
    const beatsShort = merged.beats.filter((b) => b.trackIndex === 1);
    const alignment = alignTrackPairMultiSectionDtw(
      extractTrackBeatFeatures(beatsFull),
      extractTrackBeatFeatures(beatsShort),
    );

    const matchedFullIndices = new Set(alignment.pairs.map((p) => p.indexA));
    // Intro+V1+C1 (0..15) and Chorus 2 (28..35) should align to shortCover.
    expect(matchedFullIndices.has(2)).toBe(true);
    expect(matchedFullIndices.has(12)).toBe(true);
    expect(matchedFullIndices.has(30)).toBe(true);
    // Unique Verse 2 middle beats should remain unmatched.
    const uniqueMatchedCount = uniqueV2.filter((_, idx) =>
      matchedFullIndices.has(introV1C1.length + idx),
    ).length;
    expect(uniqueMatchedCount).toBeLessThan(uniqueV2.length / 2);

    // Cross-track Cover Sync graph lets Chorus 1 of short cover connect to both choruses in full song.
    buildJumpGraph(merged, {
      ...DEFAULT_JUKEBOX_CONFIG,
      crossTrackOnly: true,
      coverSync: true,
      crossTrackThreshold: 30,
    });
    const shortBeatStart = beatsFull.length;
    const shortChorusBeat = merged.beats[shortBeatStart + VERSE1.length + 2];
    const destLocalIndices = shortChorusBeat.neighbors.map(
      (e) => e.dest.localWhich,
    );
    expect(destLocalIndices.length).toBeGreaterThanOrEqual(2);
  });
});
