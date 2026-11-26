import { describe, expect, it } from "vitest";
import {
  computeBeatColors,
  computeBeatPitchColor,
  computePitchBeatColors,
} from "./beatColors";
import type { QuantumBase, Segment } from "./types";

function segment(t1: number, t2: number, t3: number) {
  return { timbre: [0, t1, t2, t3, 0, 0, 0, 0, 0, 0, 0, 0] } as Segment;
}

function pitchSegment(pitches: number[], duration = 1) {
  return { pitches, duration } as unknown as Segment;
}

function beat(overlappingSegments: Segment[], oseg?: Segment | null) {
  return { overlappingSegments, oseg } as QuantumBase;
}

function hexHue(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

describe("computeBeatColors", () => {
  it("maps normalized timbre 1-3 to blue, red and green", () => {
    const low = segment(-10, -20, -30);
    const high = segment(10, 20, 30);
    const mixed = segment(10, -20, -30);
    expect(
      computeBeatColors([beat([low]), beat([high]), beat([mixed])], [low, high, mixed]),
    ).toEqual(["#000000", "#ffffff", "#0000ff"]);
  });

  it("uses a neutral color for beats without segments", () => {
    expect(computeBeatColors([beat([])], [])).toEqual(["#333333"]);
  });
});

describe("computePitchBeatColors", () => {
  it("maps pitch classes onto the Circle of Fifths with adjacent fifths closer than tritones", () => {
    const cVec = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const gVec = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    const fSharpVec = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const colors = computePitchBeatColors([
      beat([pitchSegment(cVec)]),
      beat([pitchSegment(gVec)]),
      beat([pitchSegment(fSharpVec)]),
    ]);
    expect(colors[0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors[1]).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors[2]).toMatch(/^#[0-9a-f]{6}$/);

    const hC = hexHue(colors[0]!);
    const hG = hexHue(colors[1]!);
    const hFs = hexHue(colors[2]!);
    expect(circularHueDistance(hC, hG)).toBeCloseTo(30, 0);
    expect(circularHueDistance(hC, hFs)).toBeCloseTo(180, 0);
  });

  it("weights multiple overlapping segments by duration and falls back to oseg", () => {
    const cLong = pitchSegment([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4);
    const fSharpShort = pitchSegment([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], 1);
    const weighted = computeBeatPitchColor(beat([cLong, fSharpShort]));
    const pureC = computeBeatPitchColor(beat([cLong]));
    const pureFSharp = computeBeatPitchColor(beat([fSharpShort]));
    const fallbackOseg = computeBeatPitchColor(beat([], cLong));
    expect(weighted).not.toBeNull();
    expect(pureC).not.toBeNull();
    expect(pureFSharp).not.toBeNull();
    // Dominant C segment steers hue to C even with a short tritone overlap.
    expect(hexHue(weighted!)).toBeCloseTo(hexHue(pureC!), 0);
    expect(circularHueDistance(hexHue(weighted!), hexHue(pureFSharp!))).toBeGreaterThan(90);
    expect(fallbackOseg).toBe(pureC);
  });

  it("returns null when no positive pitch values exist", () => {
    const emptyPitch = pitchSegment([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(computePitchBeatColors([beat([]), beat([emptyPitch])])).toEqual([
      null,
      null,
    ]);
  });
});
