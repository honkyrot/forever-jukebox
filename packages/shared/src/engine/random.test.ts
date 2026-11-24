import { describe, expect, it } from "vitest";
import { createCloneableRng, createRng, generateRandomSeed } from "./random";

describe("createRng", () => {
  it("matches the seed-1337 golden sequence for seeded mode", () => {
    const rng = createRng("seeded", 1337);
    const actual = Array.from({ length: 5 }, () => rng());
    const expected = [
      0.1844118325971067,
      0.18998925131745636,
      0.8104719922412187,
      0.6437488221563399,
      0.430774615611881,
    ];

    expect(actual).toEqual(expected);
  });

  it("uses the same deterministic algorithm as seeded mode", () => {
    const seeded = createRng("seeded", 1337);
    const deterministic = createRng("deterministic", 1337);

    const seededValues = Array.from({ length: 8 }, () => seeded());
    const deterministicValues = Array.from({ length: 8 }, () => deterministic());

    expect(deterministicValues).toEqual(seededValues);
  });
});

describe("createCloneableRng", () => {
  it("matches the seed-1337 golden sequence and clones independently", () => {
    const rng = createCloneableRng(1337);
    expect(rng.next()).toBe(0.1844118325971067);
    expect(rng.next()).toBe(0.18998925131745636);

    const snapshot = rng.clone();
    const fromOriginal = Array.from({ length: 4 }, () => rng.next());
    const fromClone = Array.from({ length: 4 }, () => snapshot.next());

    expect(fromClone).toEqual(fromOriginal);
    expect(fromOriginal[0]).toBe(0.8104719922412187);
    expect(fromOriginal[1]).toBe(0.6437488221563399);
    expect(fromOriginal[2]).toBe(0.430774615611881);
  });
});

describe("generateRandomSeed", () => {
  it("returns finite unsigned 32-bit integers", () => {
    for (let i = 0; i < 10; i += 1) {
      const seed = generateRandomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
