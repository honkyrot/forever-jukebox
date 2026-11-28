import { describe, expect, it } from "vitest";
import type { CanonizerBeat } from "./AutocanonizerViz";
import {
  planCanonizerRender,
  type CanonizerRenderSegment,
} from "./canonizerRenderPlan";

// Contiguous linked beats; `others[i]` is the index beat `i` is paired with.
function makeBeats(start: number, durations: number[], others: number[]) {
  let cursor = start;
  const beats = durations.map((duration, which) => {
    const beat = { which, start: cursor, duration, otherGain: 1 };
    cursor += duration;
    return beat as unknown as CanonizerBeat;
  });
  beats.forEach((beat, index) => {
    beat.prev = beats[index - 1] ?? null;
    beat.next = beats[index + 1] ?? null;
    beat.other = beats[others[index]];
  });
  return beats;
}

function expectSegments(
  actual: CanonizerRenderSegment[],
  expected: Array<[number, number, number, number]>,
) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([outputStart, duration, sourceOffset, gain], index) => {
    expect(actual[index].outputStart).toBeCloseTo(outputStart);
    expect(actual[index].duration).toBeCloseTo(duration);
    expect(actual[index].sourceOffset).toBeCloseTo(sourceOffset);
    expect(actual[index].gain).toBeCloseTo(gain);
  });
}

const centered = { mainPan: 0, otherPan: 0 };

describe("planCanonizerRender", () => {
  it("returns null without beats", () => {
    expect(
      planCanonizerRender([], { finishOutSong: false, ...centered }),
    ).toBeNull();
  });

  it("plans one pass of both voices when not finishing out", () => {
    const beats = makeBeats(2, [1, 1, 1, 1], [2, 3, 0, 1]);
    beats[1].otherGain = 0.5;
    beats[2].otherGain = 0.5;

    const plan = planCanonizerRender(beats, {
      finishOutSong: false,
      mainPan: -0.5,
      otherPan: 0.25,
    });

    expect(plan?.durationSeconds).toBeCloseTo(4);
    expect(plan?.voices.map((voice) => voice.pan)).toEqual([-0.5, 0.25]);
    expectSegments(plan!.voices[0].segments, [[0, 4, 2, 0.55]]);
    // The other voice runs on through sequential partners and restarts at the jump.
    expectSegments(plan!.voices[1].segments, [
      [0, 1, 4, 0.45],
      [1, 1, 4, 0.225],
      [2, 1, 0, 0.225],
      [3, 1, 0, 0.45],
    ]);
  });

  it("ends the main voice at the final beat and plays the other voice out", () => {
    const beats = makeBeats(2, [1, 1, 1, 1], [2, 3, 0, 1]);
    beats[1].otherGain = 0.5;

    const plan = planCanonizerRender(beats, {
      finishOutSong: true,
      ...centered,
    });

    expect(plan?.durationSeconds).toBeCloseTo(6);
    expectSegments(plan!.voices[0].segments, [[0, 3, 2, 0.55]]);
    expectSegments(plan!.voices[1].segments, [
      [0, 1, 4, 0.45],
      [1, 1, 4, 0.225],
      [2, 1, 0, 0.45],
      // From the final beat's partner to the end of the track.
      [3, 1, 0, 0.225],
      [4, 1, 0, 0.45],
      [5, 1, 0, 0.45],
    ]);
  });

  it("resyncs the other voice once it drifts past the skew limit", () => {
    const beats = makeBeats(
      0,
      [1, 1, 1, 0.97, 0.97, 0.97],
      [3, 4, 5, 3, 4, 5],
    );

    const plan = planCanonizerRender(beats, {
      finishOutSong: false,
      ...centered,
    });

    const offsets = plan!.voices[1].segments.map(
      (segment) => segment.sourceOffset,
    );
    expect(offsets[0]).toBeCloseTo(3);
    expect(offsets[1]).toBeCloseTo(3);
    expect(offsets[2]).toBeCloseTo(2.94);
  });

  it("plans a 2-song dual mix with sourceIndex 1 and otherBeats finish-out", () => {
    const main = makeBeats(0, [1, 1], [0, 0]);
    const other = makeBeats(10, [1, 1, 1], [0, 1, 2]);
    main[0].other = other[1];
    main[1].other = other[0];

    const plan = planCanonizerRender(main, {
      finishOutSong: true,
      mainPan: -0.25,
      otherPan: 0.25,
      mainGain: 1.5,
      otherGain: 0.5,
      isDual: true,
      otherBeats: other,
    });

    expect(plan?.voices.map((v) => v.sourceIndex)).toEqual([0, 1]);
    expect(plan?.durationSeconds).toBeCloseTo(4);
    expectSegments(plan!.voices[0].segments, [[0, 1, 0, 0.55 * 1.5]]);
    expectSegments(plan!.voices[1].segments, [
      [0, 1, 11, 0.45 * 0.5],
      [1, 1, 9, 0.45 * 0.5],
      [2, 1, 9, 0.45 * 0.5],
      [3, 1, 9, 0.45 * 0.5],
    ]);
  });

  it("plans a 4-voice quad mix with quad blend weights, gains, and pink sync resync", () => {
    const main = makeBeats(0, [1, 1], [1, 0]);
    const other = makeBeats(5, [0.95, 0.95], [0, 1]);
    main[0].pink = other[0];
    main[1].pink = other[1];
    main[0].pinkGain = 1;
    main[1].pinkGain = 0.5;
    main[0].gold = other[1];
    main[1].gold = other[0];
    main[0].goldGain = 0.5;
    main[1].goldGain = 1;

    const plan = planCanonizerRender(main, {
      finishOutSong: false,
      mainPan: -0.5,
      otherPan: -0.25,
      pinkPan: 0.25,
      goldPan: 0.5,
      mainGain: 1,
      otherGain: 1.5,
      pinkGain: 0.5,
      goldGain: 2,
      isDual: true,
      quadMode: true,
      otherBeats: other,
    });

    expect(plan?.voices).toHaveLength(4);
    expect(plan?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 1, 1]);
    expect(plan?.voices.map((v) => v.pan)).toEqual([-0.5, -0.25, 0.25, 0.5]);
    expectSegments(plan!.voices[0].segments, [[0, 2, 0, 0.28]]);
    expectSegments(plan!.voices[1].segments, [
      [0, 1, 1, 0.22 * 1.5],
      [1, 1, -1, 0.22 * 1.5],
    ]);
    // Pink resyncs on beat 1 because |1 - 0.95| = 0.05 > QUAD_SYNC_MAX_SKEW_DELTA (0.025).
    expectSegments(plan!.voices[2].segments, [
      [0, 1, 5, 0.28 * 0.5],
      [1, 1, 4.95, 0.28 * 0.5 * 0.5],
    ]);
    expectSegments(plan!.voices[3].segments, [
      [0, 1, 5.95, 0.22 * 2 * 0.5],
      [1, 1, 4, 0.22 * 2],
    ]);
  });

  it("plans a 3-voice single-song trio with 0.4/0.3/0.3 weights, muted sections, and dual-branch finish-out", () => {
    const beats = makeBeats(0, [1, 1, 1, 1], [1, 2, 3, 2]);
    beats[0].gold = beats[2];
    beats[0].goldGain = 1;
    beats[1].gold = beats[1];
    beats[1].goldGain = 0;
    beats[2].gold = beats[0];
    beats[2].goldGain = 0.5;
    beats[3].gold = beats[1];
    beats[3].goldGain = 1;

    const looped = planCanonizerRender(beats, {
      finishOutSong: false,
      mainPan: -0.25,
      otherPan: 0.25,
      goldPan: 0.75,
      trioMode: true,
    });
    expect(looped?.voices).toHaveLength(3);
    expect(looped?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 0]);
    expect(looped?.voices.map((v) => v.pan)).toEqual([-0.25, 0.25, 0.75]);
    expect(looped?.durationSeconds).toBeCloseTo(4);
    expectSegments(looped!.voices[0].segments, [[0, 4, 0, 0.4]]);
    expectSegments(looped!.voices[1].segments, [
      [0, 1, 1, 0.3],
      [1, 1, 1, 0.3],
      [2, 1, 1, 0.3],
      [3, 1, -1, 0.3],
    ]);
    expectSegments(looped!.voices[2].segments, [
      [0, 1, 2, 0.3],
      [1, 1, 0, 0],
      [2, 1, -2, 0.15],
      [3, 1, -2, 0.3],
    ]);

    // Finish-out: final beat (index 3) has other=2 (2 beats left) and gold=1 (3 beats left).
    // Both play out until both reach beat 3 (total 3s main + 3s finish-out = 6s).
    const finishOut = planCanonizerRender(beats, {
      finishOutSong: true,
      mainPan: 0,
      otherPan: 0,
      goldPan: 0,
      trioMode: true,
    });
    expect(finishOut?.durationSeconds).toBeCloseTo(6);
    expectSegments(finishOut!.voices[0].segments, [[0, 3, 0, 0.4]]);
    expectSegments(finishOut!.voices[1].segments, [
      [0, 1, 1, 0.3],
      [1, 1, 1, 0.3],
      [2, 1, 1, 0.3],
      [3, 1, -1, 0.3],
      [4, 1, -1, 0.3],
    ]);
    expectSegments(finishOut!.voices[2].segments, [
      [0, 1, 2, 0.3],
      [1, 1, 0, 0],
      [2, 1, -2, 0.15],
      [3, 1, -2, 0.3],
      [4, 1, -2, 0.3],
      [5, 1, -2, 0.3],
    ]);
  });

  it("stops Gold at the final beat during trio finish-out if Gold was muted on the final beat", () => {
    const beats = makeBeats(0, [1, 1, 1], [1, 2, 1]);
    beats[0].gold = beats[2];
    beats[0].goldGain = 1;
    beats[1].gold = beats[0];
    beats[1].goldGain = 1;
    beats[2].gold = beats[2];
    beats[2].goldGain = 0;

    const plan = planCanonizerRender(beats, {
      finishOutSong: true,
      mainPan: 0,
      otherPan: 0,
      goldPan: 0,
      trioMode: true,
    });
    // Final beat (2) has other=1 (2 beats left: 1, 2) and muted gold -> total 2s + 2s = 4s.
    expect(plan?.durationSeconds).toBeCloseTo(4);
    expect(plan!.voices[2].segments).toHaveLength(2);
  });

  it("mixes 4 single-song voices (0.31/0.23/0.23/0.23) and finishes out all active branches", () => {
    const beats = makeBeats(0, [1, 1, 1, 1], [1, 2, 3, 2]);
    beats[0].gold = beats[2];
    beats[0].goldGain = 1;
    beats[1].gold = beats[3];
    beats[1].goldGain = 1;
    beats[2].gold = beats[0];
    beats[2].goldGain = 0.5;
    beats[3].gold = beats[2];
    beats[3].goldGain = 1;

    beats[0].pink = beats[3];
    beats[0].pinkGain = 1;
    beats[1].pink = beats[1];
    beats[1].pinkGain = 0; // muted section
    beats[2].pink = beats[1];
    beats[2].pinkGain = 0.5; // ducked entry
    beats[3].pink = beats[0];
    beats[3].pinkGain = 1; // 4 beats left in finish-out: 0, 1, 2, 3

    const looped = planCanonizerRender(beats, {
      finishOutSong: false,
      mainPan: -0.5,
      otherPan: 0.5,
      goldPan: 0.25,
      pinkPan: -0.25,
      singleVoiceCount: 4,
    });
    expect(looped?.voices).toHaveLength(4);
    expect(looped?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 0, 0]);
    expect(looped?.voices.map((v) => v.pan)).toEqual([-0.5, 0.5, 0.25, -0.25]);
    expect(looped?.durationSeconds).toBeCloseTo(4);
    expectSegments(looped!.voices[0].segments, [[0, 4, 0, 0.31]]);
    expectSegments(looped!.voices[3].segments, [
      [0, 1, 3, 0.23],
      [1, 1, 0, 0],
      [2, 1, -1, 0.115],
      [3, 1, -3, 0.23],
    ]);

    // Finish-out: main stops at beat 3 (t=3); other finishes at t=5, gold finishes at t=5, pink plays 0,1,2,3 (t=7).
    const finishOut = planCanonizerRender(beats, {
      finishOutSong: true,
      mainPan: 0,
      otherPan: 0,
      goldPan: 0,
      pinkPan: 0,
      singleVoiceCount: 4,
    });
    expect(finishOut?.durationSeconds).toBeCloseTo(7);
    expectSegments(finishOut!.voices[0].segments, [[0, 3, 0, 0.31]]);
    expect(finishOut!.voices[1].segments).toHaveLength(5);
    expect(finishOut!.voices[2].segments).toHaveLength(5);
    expectSegments(finishOut!.voices[3].segments, [
      [0, 1, 3, 0.23],
      [1, 1, 0, 0],
      [2, 1, -1, 0.115],
      [3, 1, -3, 0.23],
      [4, 1, -3, 0.23],
      [5, 1, -3, 0.23],
      [6, 1, -3, 0.23],
    ]);
  });
});
