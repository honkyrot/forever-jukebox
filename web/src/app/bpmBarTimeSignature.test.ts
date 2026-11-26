import { beforeEach, describe, expect, it } from "vitest";
import type { QuantumBase } from "@forever-jukebox/shared";
import {
  DEFAULT_BPM_BAR_SMOOTH_DURATION_MS,
  DEFAULT_BPM_BAR_STYLE,
  DEFAULT_BPM_BAR_TIME_SIGNATURE_MODE,
  MAX_BPM_BAR_SEGMENTS,
  MAX_BPM_BAR_SMOOTH_DURATION_MS,
  MIN_BPM_BAR_SMOOTH_DURATION_MS,
  isPulseBpmBarStyle,
  isSmoothBpmBarStyle,
  normalizeBpmBarStyle,
  normalizeBpmBarTimeSignatureMode,
  readStoredBpmBarOffsetMap,
  resolveBpmBarActiveSegment,
  resolveBpmBarSegmentCount,
  resolveBpmBarSmoothAnimation,
  resolveStoredBpmBarBeatOffsetForTrack,
  resolveStoredBpmBarDenominator,
  resolveStoredBpmBarNumerator,
  resolveStoredBpmBarStyle,
  resolveStoredBpmBarTimeSignatureMode,
  storeBpmBarBeatOffsetForTrack,
  storeBpmBarDenominator,
  storeBpmBarNumerator,
  storeBpmBarStyle,
  storeBpmBarTimeSignatureMode,
  type BpmBarTimeSignatureInput,
} from "./bpmBarTimeSignature";

function makeInput(
  overrides: Partial<BpmBarTimeSignatureInput> = {},
): BpmBarTimeSignatureInput {
  return {
    bpmBarTimeSignatureMode: "auto",
    bpmBarNumerator: 4,
    bpmBarDenominator: 4,
    bpmBarBeatOffset: 0,
    multiTrackEnabled: false,
    coverSyncEnabled: false,
    timeSignatureBranchingEnabled: false,
    timeSignatureBranchMode: "overwrite",
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    timeSignatureTrackOffsets: [],
    timeSignatureSimilarityRestrictEnabled: false,
    timeSignatureSimilarityNumerator: 4,
    timeSignatureSimilarityDenominator: 4,
    jukeboxAudioMode: "off",
    metronomeBeatsPerBar: null,
    metronomeBeatOffset: 0,
    metronomeDetectedBeatsPerBar: 4,
    ...overrides,
  };
}

function makeBeat(
  which: number,
  extra: Partial<QuantumBase> = {},
): QuantumBase {
  return {
    start: which * 0.5,
    duration: 0.5,
    which,
    prev: null,
    next: null,
    overlappingSegments: [],
    neighbors: [],
    allNeighbors: [],
    ...extra,
  };
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  } as Storage;
}

describe("bpmBarTimeSignature", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  it("normalizes and persists BPM bar time-signature settings", () => {
    expect(normalizeBpmBarTimeSignatureMode(undefined)).toBe(
      DEFAULT_BPM_BAR_TIME_SIGNATURE_MODE,
    );
    expect(normalizeBpmBarTimeSignatureMode("off")).toBe("off");
    expect(normalizeBpmBarTimeSignatureMode("custom")).toBe("custom");
    expect(normalizeBpmBarTimeSignatureMode("unknown")).toBe("auto");

    expect(resolveStoredBpmBarTimeSignatureMode()).toBe("auto");
    expect(resolveStoredBpmBarNumerator()).toBe(4);
    expect(resolveStoredBpmBarDenominator()).toBe(4);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-a")).toBe(0);

    storeBpmBarTimeSignatureMode("custom");
    storeBpmBarNumerator(7);
    storeBpmBarDenominator(8);
    storeBpmBarBeatOffsetForTrack("song-a", -3);
    storeBpmBarBeatOffsetForTrack("song-b", 2);

    expect(resolveStoredBpmBarTimeSignatureMode()).toBe("custom");
    expect(resolveStoredBpmBarNumerator()).toBe(7);
    expect(resolveStoredBpmBarDenominator()).toBe(8);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-a")).toBe(-3);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-b")).toBe(2);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-c")).toBe(0);
    expect(readStoredBpmBarOffsetMap()).toEqual({ "song-a": -3, "song-b": 2 });

    // Resetting a song to 0 removes only its entry without affecting other songs.
    storeBpmBarBeatOffsetForTrack("song-a", 0);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-a")).toBe(0);
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-b")).toBe(2);

    // Null/empty track IDs are safe no-ops and legacy scalar strings fall back to 0.
    storeBpmBarBeatOffsetForTrack(null, 4);
    expect(resolveStoredBpmBarBeatOffsetForTrack(null)).toBe(0);
    localStorage.setItem("fj-bpm-bar-ts-offset", "2");
    expect(resolveStoredBpmBarBeatOffsetForTrack("song-b")).toBe(0);
  });

  it("resolves solid bar when off or no time-signature feature is active in auto mode", () => {
    expect(resolveBpmBarSegmentCount(makeInput())).toBeNull();
    expect(
      resolveBpmBarActiveSegment(
        makeInput({
          bpmBarTimeSignatureMode: "off",
          multiTrackEnabled: true,
          timeSignatureBranchingEnabled: true,
        }),
        0,
        makeBeat(0),
      ),
    ).toEqual({ segmentCount: null, activeSegmentIndex: null });
  });

  it("tracks multi-track time signatures in auto mode with proper priority and offsets", () => {
    // Similarity restrict (4/4) takes priority over combine auto-create (4/2).
    const bothInput = makeInput({
      multiTrackEnabled: true,
      timeSignatureSimilarityRestrictEnabled: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureBranchingEnabled: true,
      timeSignatureBranchMode: "combine",
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 2,
      timeSignatureTrackOffsets: [0, 1],
    });
    expect(resolveBpmBarSegmentCount(bothInput)).toBe(4);
    expect(
      resolveBpmBarActiveSegment(
        bothInput,
        0,
        makeBeat(0, { trackIndex: 0, localWhich: 0 }),
      ),
    ).toEqual({ segmentCount: 4, activeSegmentIndex: 0 });
    expect(
      resolveBpmBarActiveSegment(
        bothInput,
        19,
        makeBeat(19, { trackIndex: 1, localWhich: 3 }),
      ),
    ).toEqual({ segmentCount: 4, activeSegmentIndex: 2 });

    // Overwrite mode takes priority over similarity restrict.
    const overwriteInput = makeInput({
      ...bothInput,
      timeSignatureBranchMode: "overwrite",
    });
    expect(resolveBpmBarSegmentCount(overwriteInput)).toBe(8);
    expect(
      resolveBpmBarActiveSegment(
        overwriteInput,
        7,
        makeBeat(7, { trackIndex: 0, localWhich: 7 }),
      ),
    ).toEqual({ segmentCount: 8, activeSegmentIndex: 7 });
  });

  it("follows metronome time signature and offset in auto mode", () => {
    const bar3 = { start: 0, duration: 1.5, which: 0, prev: null, next: null, overlappingSegments: [], neighbors: [], allNeighbors: [], children: [{}, {}, {}] as QuantumBase[] };
    const input = makeInput({
      jukeboxAudioMode: "metronome",
      metronomeBeatsPerBar: null,
      metronomeDetectedBeatsPerBar: 3,
      metronomeBeatOffset: 1,
    });
    expect(
      resolveBpmBarActiveSegment(
        input,
        2,
        makeBeat(2, { indexInParent: 2, parent: bar3 }),
      ),
    ).toEqual({ segmentCount: 3, activeSegmentIndex: 1 });

    // Explicit metronome override uses modular localWhich counting.
    expect(
      resolveBpmBarActiveSegment(
        makeInput({
          jukeboxAudioMode: "metronome",
          metronomeBeatsPerBar: 6,
          metronomeBeatOffset: 2,
        }),
        7,
        makeBeat(7, { localWhich: 7 }),
      ),
    ).toEqual({ segmentCount: 6, activeSegmentIndex: 5 });
  });

  it("supports custom time signatures and caps segments at MAX_BPM_BAR_SEGMENTS", () => {
    const custom42 = makeInput({
      bpmBarTimeSignatureMode: "custom",
      bpmBarNumerator: 4,
      bpmBarDenominator: 2,
      bpmBarBeatOffset: 2,
    });
    expect(resolveBpmBarActiveSegment(custom42, 2, makeBeat(2))).toEqual({
      segmentCount: 8,
      activeSegmentIndex: 0,
    });
    expect(resolveBpmBarActiveSegment(custom42, 9, makeBeat(9))).toEqual({
      segmentCount: 8,
      activeSegmentIndex: 7,
    });

    const capped = makeInput({
      bpmBarTimeSignatureMode: "custom",
      bpmBarNumerator: 32,
      bpmBarDenominator: 4,
    });
    expect(resolveBpmBarSegmentCount(capped)).toBe(MAX_BPM_BAR_SEGMENTS);
  });

  it("tracks single-track similarity bar restriction and offset in auto mode", () => {
    const input = makeInput({
      multiTrackEnabled: false,
      timeSignatureSimilarityRestrictEnabled: true,
      timeSignatureSimilarityNumerator: 4,
      timeSignatureSimilarityDenominator: 4,
      timeSignatureTrackOffsets: [1],
    });
    expect(resolveBpmBarSegmentCount(input)).toBe(4);
    expect(resolveBpmBarActiveSegment(input, 1, makeBeat(1))).toEqual({
      segmentCount: 4,
      activeSegmentIndex: 0,
    });
    expect(resolveBpmBarActiveSegment(input, 4, makeBeat(4))).toEqual({
      segmentCount: 4,
      activeSegmentIndex: 3,
    });
  });

  it("normalizes and persists BPM bar style", () => {
    expect(normalizeBpmBarStyle(undefined)).toBe(DEFAULT_BPM_BAR_STYLE);
    expect(normalizeBpmBarStyle("pulse")).toBe("pulse");
    expect(normalizeBpmBarStyle("smooth")).toBe("smooth");
    expect(normalizeBpmBarStyle("smooth-pulse")).toBe("smooth-pulse");
    expect(normalizeBpmBarStyle("other")).toBe("pulse");

    expect(isSmoothBpmBarStyle("pulse")).toBe(false);
    expect(isSmoothBpmBarStyle("smooth")).toBe(true);
    expect(isSmoothBpmBarStyle("smooth-pulse")).toBe(true);
    expect(isPulseBpmBarStyle("pulse")).toBe(true);
    expect(isPulseBpmBarStyle("smooth")).toBe(false);
    expect(isPulseBpmBarStyle("smooth-pulse")).toBe(true);

    expect(resolveStoredBpmBarStyle()).toBe("pulse");
    storeBpmBarStyle("smooth");
    expect(resolveStoredBpmBarStyle()).toBe("smooth");
    expect(localStorage.getItem("fj-bpm-bar-style")).toBe("smooth");
    storeBpmBarStyle("smooth-pulse");
    expect(resolveStoredBpmBarStyle()).toBe("smooth-pulse");
    expect(localStorage.getItem("fj-bpm-bar-style")).toBe("smooth-pulse");
  });

  it("computes smooth animation slices for single beats, measures, playback rate, and poll lag", () => {
    // No time signature: skips empty reset pulses, animates 0 -> 1 per beat.
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: null,
        activeSegmentIndex: null,
        beatIndex: null,
        beat: null,
      }),
    ).toBeNull();

    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: null,
        activeSegmentIndex: null,
        beatIndex: 2,
        beat: makeBeat(2, { start: 1.0, duration: 0.5 }),
      }),
    ).toEqual({
      fromFraction: 0,
      toFraction: 1,
      durationMs: 500,
      isDownbeat: false,
    });

    // Measure progress across 4/4 beats.
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: 4,
        activeSegmentIndex: 0,
        beatIndex: 0,
        beat: makeBeat(0, { start: 0, duration: 0.5 }),
      }),
    ).toEqual({
      fromFraction: 0,
      toFraction: 0.25,
      durationMs: 500,
      isDownbeat: true,
    });

    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: 4,
        activeSegmentIndex: 2,
        beatIndex: 2,
        beat: makeBeat(2, { start: 1.0, duration: 0.5 }),
        playbackRate: 1.25,
      }),
    ).toEqual({
      fromFraction: 0.5,
      toFraction: 0.75,
      durationMs: 400,
      isDownbeat: false,
    });

    // Poll-latency compensation advances start fraction and shortens remaining duration.
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: 4,
        activeSegmentIndex: 1,
        beatIndex: 1,
        beat: makeBeat(1, { start: 0.5, duration: 0.5 }),
        currentTimeSec: 0.6,
      }),
    ).toEqual({
      fromFraction: 0.3,
      toFraction: 0.5,
      durationMs: 400,
      isDownbeat: false,
    });

    // Missing duration falls back to default; extreme durations clamp cleanly.
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: 4,
        activeSegmentIndex: 3,
        beatIndex: 3,
        beat: { which: 3 },
      }),
    ).toEqual({
      fromFraction: 0.75,
      toFraction: 1,
      durationMs: DEFAULT_BPM_BAR_SMOOTH_DURATION_MS,
      isDownbeat: false,
    });
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: null,
        activeSegmentIndex: null,
        beatIndex: 0,
        beat: makeBeat(0, { duration: 0.005 }),
      })?.durationMs,
    ).toBe(MIN_BPM_BAR_SMOOTH_DURATION_MS);
    expect(
      resolveBpmBarSmoothAnimation({
        segmentCount: null,
        activeSegmentIndex: null,
        beatIndex: 0,
        beat: makeBeat(0, { duration: 25 }),
      })?.durationMs,
    ).toBe(MAX_BPM_BAR_SMOOTH_DURATION_MS);
  });
});
