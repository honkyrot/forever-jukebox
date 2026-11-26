import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_SIGNATURE_BRANCH_MODE } from "@forever-jukebox/shared";
import {
  resolveBpmBarActiveSegment,
  resolveBpmBarSegmentCount,
  resolveBpmBarSmoothAnimation,
  resolveStoredBpmBarBeatOffsetForTrack,
  storeBpmBarBeatOffsetForTrack,
  type BpmBarTimeSignatureInput,
} from "./bpmBarTimeSignature";

function createInput(
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
    timeSignatureBranchMode: DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    timeSignatureTrackOffsets: [0],
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

describe("bpmBarTimeSignature", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("resolves segment count for off, custom, and auto modes", () => {
    expect(
      resolveBpmBarSegmentCount(
        createInput({ bpmBarTimeSignatureMode: "off" }),
      ),
    ).toBeNull();

    expect(
      resolveBpmBarSegmentCount(
        createInput({
          bpmBarTimeSignatureMode: "custom",
          bpmBarNumerator: 3,
          bpmBarDenominator: 4,
        }),
      ),
    ).toBe(3);

    expect(
      resolveBpmBarSegmentCount(
        createInput({
          bpmBarTimeSignatureMode: "auto",
          timeSignatureSimilarityRestrictEnabled: true,
          timeSignatureSimilarityNumerator: 5,
          timeSignatureSimilarityDenominator: 4,
        }),
      ),
    ).toBe(5);

    expect(
      resolveBpmBarSegmentCount(
        createInput({
          bpmBarTimeSignatureMode: "auto",
          jukeboxAudioMode: "metronome",
          metronomeBeatsPerBar: 5,
        }),
      ),
    ).toBe(5);
  });

  it("resolves active segment index respecting track offsets in custom mode", () => {
    const input = createInput({
      bpmBarTimeSignatureMode: "custom",
      bpmBarNumerator: 4,
      bpmBarDenominator: 4,
      bpmBarBeatOffset: 1,
    });
    expect(resolveBpmBarActiveSegment(input, 1, null)).toEqual({
      segmentCount: 4,
      activeSegmentIndex: 0,
    });
    expect(resolveBpmBarActiveSegment(input, 4, null)).toEqual({
      segmentCount: 4,
      activeSegmentIndex: 3,
    });
  });

  it("computes smooth sweep fractions and elapsed compensation", () => {
    const anim = resolveBpmBarSmoothAnimation({
      segmentCount: 4,
      activeSegmentIndex: 2,
      beatIndex: 2,
      beat: { which: 2, duration: 0.5, start: 1.0 },
      playbackRate: 1,
      currentTimeSec: 1.1,
    });
    expect(anim).not.toBeNull();
    expect(anim?.isDownbeat).toBe(false);
    expect(anim?.toFraction).toBeCloseTo(0.75);
    expect(anim?.fromFraction).toBeGreaterThan(0.5);
    expect(anim?.durationMs).toBeCloseTo(400, -1);

    const downbeat = resolveBpmBarSmoothAnimation({
      segmentCount: 4,
      activeSegmentIndex: 0,
      beatIndex: 0,
      beat: { which: 0, duration: 0.5 },
    });
    expect(downbeat?.isDownbeat).toBe(true);
    expect(downbeat?.fromFraction).toBe(0);
    expect(downbeat?.toFraction).toBe(0.25);
  });

  it("stores per-track beat offsets and clears zero values", () => {
    storeBpmBarBeatOffsetForTrack("track-a", 2);
    expect(resolveStoredBpmBarBeatOffsetForTrack("track-a")).toBe(2);
    storeBpmBarBeatOffsetForTrack("track-a", 0);
    expect(resolveStoredBpmBarBeatOffsetForTrack("track-a")).toBe(0);
  });
});
