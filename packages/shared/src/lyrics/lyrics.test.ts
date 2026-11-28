import { describe, expect, it } from "vitest";
import type { QuantumBase } from "../engine/types";
import {
  findActiveLineIndex,
  findNextLineIndex,
  normalizeSpicyLyrics,
  resolveAutocanonizerLyricsState,
  resolveKaraokeState,
  resolveSyllableProgress,
} from "./index";

function makeBeats(count: number, beatDur = 0.5): QuantumBase[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * beatDur,
    duration: beatDur,
    which: i,
    prev: null,
    next: null,
    overlappingSegments: [],
    neighbors: [],
    allNeighbors: [],
  }));
}

describe("normalizeSpicyLyrics", () => {
  it("normalizes Syllable lyrics and preserves IsPartOfWord joining", () => {
    const normalized = normalizeSpicyLyrics({
      Status: 200,
      Body: {
        id: "1QV6tiMFM6fSOKOGLMHYYg",
        source: "spicy_lyrics",
        SongWriters: ["Artist A", "Artist B"],
        Type: "Syllable",
        StartTime: 7.3,
        EndTime: 20.0,
        Content: [
          {
            Type: "Vocal",
            OppositeAligned: false,
            Lead: {
              StartTime: 7.3,
              EndTime: 8.7,
              Syllables: [
                { Text: "Mum-", IsPartOfWord: true, StartTime: 7.3, EndTime: 7.6 },
                { Text: "mum-", IsPartOfWord: true, StartTime: 7.6, EndTime: 7.9 },
                { Text: "mah", IsPartOfWord: false, StartTime: 7.9, EndTime: 8.2 },
                { Text: "yeah", IsPartOfWord: false, StartTime: 8.2, EndTime: 8.7 },
              ],
            },
            Background: [
              {
                Syllables: [
                  { Text: "ooh", IsPartOfWord: false, StartTime: 8.3, EndTime: 8.7 },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.type).toBe("syllable");
    expect(normalized?.trackId).toBe("1QV6tiMFM6fSOKOGLMHYYg");
    expect(normalized?.songWriters).toEqual(["Artist A", "Artist B"]);
    expect(normalized?.lines).toHaveLength(1);
    expect(normalized?.lines[0].text).toBe("Mum-mum-mah yeah");
    expect(normalized?.lines[0].backgroundText).toBe("ooh");
    expect(normalized?.lines[0].backgroundVocals).toHaveLength(1);
    expect(normalized?.lines[0].backgroundVocals?.[0].syllables?.[0].text).toBe("ooh");
    expect(normalized?.lines[0].syllables).toHaveLength(4);
    expect(normalized?.lines[0].syllables?.[0].isPartOfWord).toBe(true);
  });

  it("extends line span and syncs concurrent Background vocals even after Lead syllables finish", () => {
    const normalized = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 109.585,
              EndTime: 113.059,
              Syllables: [
                { Text: "De", IsPartOfWord: true, StartTime: 109.585, EndTime: 109.8 },
                { Text: "mand", IsPartOfWord: true, StartTime: 109.85, EndTime: 110.2 },
                { Text: "ing", IsPartOfWord: false, StartTime: 110.2, EndTime: 113.059 },
              ],
            },
            Background: [
              {
                StartTime: 109.85,
                EndTime: 114.365,
                Syllables: [
                  { Text: "威", IsPartOfWord: true, StartTime: 109.85, EndTime: 111.73 },
                  { Text: "武", IsPartOfWord: false, StartTime: 111.73, EndTime: 114.365 },
                ],
              },
            ],
          },
        ],
      },
    })!;

    expect(normalized.lines[0].startTime).toBe(109.585);
    expect(normalized.lines[0].endTime).toBe(114.365);

    const state = resolveKaraokeState({
      lyrics: normalized,
      playbackTimeSec: 113.5,
      beats: [],
      currentBeatIndex: -1,
    });
    expect(state.activeLineIndex).toBe(0);
    expect(state.backgroundStates).toHaveLength(1);
    expect(state.backgroundStates[0].isActive).toBe(true);
    expect(state.backgroundStates[0].activeSyllableIndex).toBe(1);
    expect(state.backgroundStates[0].activeSyllableProgress).toBeGreaterThan(0.5);
  });

  it("normalizes Line lyrics and infers missing EndTime from the next line", () => {
    const normalized = normalizeSpicyLyrics({
      Type: "Line",
      Content: [
        { Type: "Vocal", Text: "First line", StartTime: 2.0 },
        { Type: "Vocal", Text: "Second line", StartTime: 6.5, EndTime: 9.0 },
      ],
    });

    expect(normalized?.type).toBe("line");
    expect(normalized?.lines).toHaveLength(2);
    expect(normalized?.lines[0]).toMatchObject({
      index: 0,
      text: "First line",
      startTime: 2.0,
      endTime: 6.5,
    });
    expect(normalized?.lines[1]).toMatchObject({
      index: 1,
      text: "Second line",
      startTime: 6.5,
      endTime: 9.0,
    });
  });

  it("normalizes Static lyrics without timestamps", () => {
    const normalized = normalizeSpicyLyrics({
      Body: {
        Type: "Static",
        Lines: [{ Text: "Static line 1" }, { Text: "   " }, { Text: "Static line 2" }],
      },
    });

    expect(normalized?.type).toBe("static");
    expect(normalized?.lines).toHaveLength(2);
    expect(normalized?.lines[0]).toEqual({
      index: 0,
      text: "Static line 1",
      startTime: null,
      endTime: null,
    });
  });

  it("parses transliterations across Syllable (with TransliteratedIsPartOfWord), VocalGroup fallback, Line, and Static payloads", () => {
    const syllableNorm = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        HasTransliterations: true,
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 1.0,
              EndTime: 3.0,
              Syllables: [
                {
                  Text: "星",
                  TransliteratedText: "Ho",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: true,
                  StartTime: 1.0,
                  EndTime: 1.5,
                },
                {
                  Text: "を",
                  TransliteratedText: "shi",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 1.5,
                  EndTime: 2.0,
                },
                {
                  Text: "見",
                  TransliteratedText: "o",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 2.0,
                  EndTime: 2.5,
                },
                {
                  Text: "る",
                  TransliteratedText: "miru",
                  IsPartOfWord: false,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 2.5,
                  EndTime: 3.0,
                },
              ],
            },
          },
          {
            Type: "Vocal",
            Lead: {
              StartTime: 4.0,
              EndTime: 6.0,
              TransliteratedText: "Group romanized",
              Syllables: [
                { Text: "漢字", IsPartOfWord: false, StartTime: 4.0, EndTime: 6.0 },
              ],
            },
          },
        ],
      },
    });

    expect(syllableNorm?.hasTransliterations).toBe(true);
    expect(syllableNorm?.lines[0].text).toBe("星を見る");
    expect(syllableNorm?.lines[0].transliteratedText).toBe("Hoshi o miru");
    expect(syllableNorm?.lines[0].syllables?.[1].transliteratedIsPartOfWord).toBe(false);
    expect(syllableNorm?.lines[1].transliteratedText).toBe("Group romanized");

    const lineNorm = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          {
            Type: "Vocal",
            Text: "夜に駆ける",
            TransliteratedText: "Yoru ni kakeru",
            StartTime: 2.0,
            EndTime: 4.0,
          },
        ],
      },
    });
    expect(lineNorm?.hasTransliterations).toBe(true);
    expect(lineNorm?.lines[0].transliteratedText).toBe("Yoru ni kakeru");

    const staticNorm = normalizeSpicyLyrics({
      Body: {
        Type: "Static",
        Lines: [{ Text: "夢", TransliteratedText: "Yume" }],
      },
    });
    expect(staticNorm?.hasTransliterations).toBe(true);
    expect(staticNorm?.lines[0].transliteratedText).toBe("Yume");

    const englishNorm = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [{ Type: "Vocal", Text: "Plain English", StartTime: 1.0, EndTime: 2.0 }],
      },
    });
    expect(englishNorm?.hasTransliterations).toBe(false);
  });

  it("returns null for unknown payloads", () => {
    expect(normalizeSpicyLyrics(null)).toBeNull();
    expect(normalizeSpicyLyrics({ Body: { Type: "Unknown" } })).toBeNull();
  });
});

describe("lyrics sync & branch-aware karaoke", () => {
  const sample = normalizeSpicyLyrics({
    Body: {
      Type: "Syllable",
      Content: [
        {
          Type: "Vocal",
          Lead: {
            StartTime: 4.0,
            EndTime: 6.0,
            Syllables: [
              { Text: "Line", IsPartOfWord: false, StartTime: 4.0, EndTime: 5.0 },
              { Text: "one", IsPartOfWord: false, StartTime: 5.0, EndTime: 6.0 },
            ],
          },
        },
        {
          Type: "Vocal",
          Lead: {
            StartTime: 8.0,
            EndTime: 10.0,
            Syllables: [
              { Text: "Line", IsPartOfWord: false, StartTime: 8.0, EndTime: 9.0 },
              { Text: "two", IsPartOfWord: false, StartTime: 9.0, EndTime: 10.0 },
            ],
          },
        },
        {
          Type: "Vocal",
          Lead: {
            StartTime: 14.0,
            EndTime: 16.0,
            Syllables: [
              { Text: "Branch", IsPartOfWord: false, StartTime: 14.0, EndTime: 15.0 },
              { Text: "target", IsPartOfWord: false, StartTime: 15.0, EndTime: 16.0 },
            ],
          },
        },
      ],
    },
  })!;

  it("finds active and next lines across jumps", () => {
    expect(findActiveLineIndex(sample.lines, 1.0)).toBe(-1);
    expect(findActiveLineIndex(sample.lines, 4.5)).toBe(0);
    expect(findActiveLineIndex(sample.lines, 14.5)).toBe(2);
    expect(findActiveLineIndex(sample.lines, 4.2)).toBe(0);
    expect(findNextLineIndex(sample.lines, 6.5)).toBe(1);
    expect(findNextLineIndex(sample.lines, 16.5)).toBe(-1);
  });

  it("computes syllable sweep progress", () => {
    const line = sample.lines[0];
    expect(resolveSyllableProgress(line, 3.5)).toEqual({
      activeSyllableIndex: -1,
      progress: 0,
    });
    expect(resolveSyllableProgress(line, 4.5)).toEqual({
      activeSyllableIndex: 0,
      progress: 0.5,
    });
    expect(resolveSyllableProgress(line, 5.25)).toEqual({
      activeSyllableIndex: 1,
      progress: 0.25,
    });
    expect(resolveSyllableProgress(line, 6.5)).toEqual({
      activeSyllableIndex: 2,
      progress: 1,
    });
  });

  it("previews the linear next line only within one measure before it starts", () => {
    const beats = makeBeats(40, 0.5);
    const earlyState = resolveKaraokeState({
      lyrics: sample,
      playbackTimeSec: 5.5,
      beats,
      currentBeatIndex: 11,
      beatsPerBar: 4,
      nextJump: { fromIndex: 24, toIndex: 28, edgeId: 1 },
    });
    expect(earlyState.activeLineIndex).toBe(0);
    expect(earlyState.nextLine?.text).toBe("Line two");
    expect(earlyState.nextLineVisible).toBe(false);

    const state = resolveKaraokeState({
      lyrics: sample,
      playbackTimeSec: 6.2,
      beats,
      currentBeatIndex: 12,
      beatsPerBar: 4,
      nextJump: { fromIndex: 24, toIndex: 28, edgeId: 1 },
    });

    expect(state.activeLineIndex).toBe(-1);
    expect(state.nextLineIndex).toBe(1);
    expect(state.nextLine?.text).toBe("Line two");
    expect(state.nextLineVisible).toBe(true);
    expect(state.isBranchPreview).toBe(false);
  });

  it("keeps Line 2 hidden during a 40s instrumental gap even past the active line midpoint", () => {
    const gapLyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          { Type: "Vocal", Text: "Until you're gone", StartTime: 149.6, EndTime: 154.0 },
          { Type: "Vocal", Text: "Oh, it's a long way", StartTime: 191.4, EndTime: 196.2 },
        ],
      },
    })!;
    const beats = makeBeats(400, 0.5);
    const state = resolveKaraokeState({
      lyrics: gapLyrics,
      playbackTimeSec: 153.5,
      beats,
      currentBeatIndex: 307,
      beatsPerBar: 4,
      nextJump: null,
    });

    expect(state.activeLineIndex).toBe(0);
    expect(state.nextLineIndex).toBe(1);
    expect(state.nextLineVisible).toBe(false);
  });

  it("switches Line 2 to the branch destination lyric when a jump is within one measure", () => {
    const beats = makeBeats(40, 0.5);
    // Beat 10 is at 5.0s; jump at beat 12 executes at 6.0s -> 2 beats away (<= 4),
    // before linear line 2 at 8.0s, jumping to beat 28 (14.0s -> "Branch target").
    const state = resolveKaraokeState({
      lyrics: sample,
      playbackTimeSec: 5.1,
      beats,
      currentBeatIndex: 10,
      beatsPerBar: 4,
      nextJump: { fromIndex: 12, toIndex: 28, edgeId: 7 },
    });

    expect(state.activeLineIndex).toBe(0);
    expect(state.nextLineIndex).toBe(2);
    expect(state.nextLine?.text).toBe("Branch target");
    expect(state.nextLineVisible).toBe(true);
    expect(state.isBranchPreview).toBe(true);
    expect(state.branchBeatsRemaining).toBe(2);
  });

  it("suppresses Line 2 when an imminent branch jump lands in a long instrumental gap", () => {
    const gapLyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          { Type: "Vocal", Text: "Before jump", StartTime: 4.0, EndTime: 6.0 },
          { Type: "Vocal", Text: "Bypassed linear", StartTime: 6.8, EndTime: 8.5 },
          { Type: "Vocal", Text: "Way later", StartTime: 50.0, EndTime: 53.0 },
        ],
      },
    })!;
    const beats = makeBeats(120, 0.5);
    // Beat 10 at 5.0s; jump at beat 12 (executes at 6.0s, before 6.8s) lands at beat 40 (20.0s),
    // 30s before "Way later" at 50.0s.
    const state = resolveKaraokeState({
      lyrics: gapLyrics,
      playbackTimeSec: 5.1,
      beats,
      currentBeatIndex: 10,
      beatsPerBar: 4,
      nextJump: { fromIndex: 12, toIndex: 40, edgeId: 9 },
    });

    expect(state.activeLineIndex).toBe(0);
    expect(state.nextLine).toBeNull();
    expect(state.nextLineVisible).toBe(false);
    expect(state.isBranchPreview).toBe(false);
  });

  it("hides Line 2 when the next line is far away and no branch is imminent", () => {
    const beats = makeBeats(40, 0.5);
    const state = resolveKaraokeState({
      lyrics: sample,
      playbackTimeSec: 0.2,
      beats,
      currentBeatIndex: 0,
      beatsPerBar: 4,
      nextJump: null,
    });

    expect(state.activeLine).toBeNull();
    expect(state.nextLine?.text).toBe("Line one");
    expect(state.nextLineVisible).toBe(false);
  });

  it("resolves dual Blue/Green cursors, unison, and finish-out tail in Autocanonizer mode", () => {
    // Main at 4.5s ("Line one"), Canon at 14.5s ("Branch target").
    const split = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 14.5,
    });
    expect(split.main.activeLine?.text).toBe("Line one");
    expect(split.other.activeLine?.text).toBe("Branch target");
    expect(split.inUnison).toBe(false);

    // Unison on "Line one" near its end (5.8s -> active line suppresses upcoming preview).
    const unison = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 5.8,
      otherTimeSec: 5.8,
      inUnison: true,
    });
    expect(unison.inUnison).toBe(true);
    expect(unison.main.activeLine?.text).toBe("Line one");
    expect(unison.main.upcomingLineVisible).toBe(false);

    // Independent per-voice upcoming previews while resting in gaps.
    const resting = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 6.8,
      otherTimeSec: 12.2,
    });
    expect(resting.main.activeLine).toBeNull();
    expect(resting.main.upcomingLine?.text).toBe("Line two");
    expect(resting.main.upcomingLineVisible).toBe(true);
    expect(resting.other.activeLine).toBeNull();
    expect(resting.other.upcomingLine?.text).toBe("Branch target");
    expect(resting.other.upcomingLineVisible).toBe(true);

    // Offset voices overlapping inside the same lyric line must remain separate (not unison).
    const offsetSameLine = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.8,
      otherTimeSec: 4.2,
      inUnison: false,
    });
    expect(offsetSameLine.inUnison).toBe(false);
    expect(offsetSameLine.main.activeLineIndex).toBe(0);
    expect(offsetSameLine.other.activeLineIndex).toBe(0);
    expect(offsetSameLine.main.activeSyllableProgress).toBeCloseTo(0.8);
    expect(offsetSameLine.other.activeSyllableProgress).toBeCloseTo(0.2);

    // Finish-out tail: mainTimeSec is null while Canon continues.
    const tail = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: null,
      otherTimeSec: 8.5,
    });
    expect(tail.main.activeLine).toBeNull();
    expect(tail.other.activeLine?.text).toBe("Line two");
    expect(tail.inUnison).toBe(false);
  });

  it("resolves an independent 3rd Gold cursor (including syllable sweep, preview, and muted null) in 3-Voice mode", () => {
    const trio = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: 15.25,
    });
    expect(trio.main.activeLine?.text).toBe("Line one");
    expect(trio.other.activeLine?.text).toBe("Line two");
    expect(trio.gold.activeLine?.text).toBe("Branch target");
    expect(trio.gold.activeSyllableIndex).toBe(1);
    expect(trio.gold.activeSyllableProgress).toBeCloseTo(0.25);

    const goldResting = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: 12.2,
    });
    expect(goldResting.gold.activeLine).toBeNull();
    expect(goldResting.gold.upcomingLine?.text).toBe("Branch target");
    expect(goldResting.gold.upcomingLineVisible).toBe(true);

    const goldMuted = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: null,
    });
    expect(goldMuted.gold.activeLine).toBeNull();
    expect(goldMuted.gold.upcomingLine).toBeNull();
  });

  it("resolves an independent 4th Pink cursor (syllable sweep, preview, and muted null) in 4-Voice mode", () => {
    const quad = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: 12.2,
      pinkTimeSec: 15.25,
    });
    expect(quad.main.activeLine?.text).toBe("Line one");
    expect(quad.other.activeLine?.text).toBe("Line two");
    expect(quad.pink.activeLine?.text).toBe("Branch target");
    expect(quad.pink.activeSyllableIndex).toBe(1);
    expect(quad.pink.activeSyllableProgress).toBeCloseTo(0.25);

    const pinkResting = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: null,
      pinkTimeSec: 12.2,
    });
    expect(pinkResting.pink.activeLine).toBeNull();
    expect(pinkResting.pink.upcomingLine?.text).toBe("Branch target");
    expect(pinkResting.pink.upcomingLineVisible).toBe(true);

    const pinkMuted = resolveAutocanonizerLyricsState({
      lyrics: sample,
      mainTimeSec: 4.5,
      otherTimeSec: 8.5,
      goldTimeSec: null,
      pinkTimeSec: null,
    });
    expect(pinkMuted.pink.activeLine).toBeNull();
    expect(pinkMuted.pink.upcomingLine).toBeNull();
  });
});
