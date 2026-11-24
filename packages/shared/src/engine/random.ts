export type RandomMode = "random" | "seeded" | "deterministic";

export interface CloneableRng {
  next: () => number;
  clone: () => CloneableRng;
}

const DEFAULT_SEED = 123456789;
const MIX_CONSTANT = 0x6d2b79f5;
const MASK_32 = 0xffffffff;
const UINT32_RANGE = 4294967296;

/**
 * Generates a fresh unsigned 32-bit seed using Web Crypto when available.
 */
export function generateRandomSeed(): number {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    const buffer = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buffer);
    return buffer[0] >>> 0;
  }
  return Math.floor(Math.random() * UINT32_RANGE) >>> 0;
}

function createCloneableRngFromState(initialState: number): CloneableRng {
  // Keep internal state constrained to unsigned 32-bit integers so cloned
  // generators remain exact regardless of how many values were drawn.
  let t = initialState >>> 0;
  const next = () => {
    t = (t + MIX_CONSTANT) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return (((x ^ (x >>> 14)) >>> 0) % (MASK_32 + 1)) / UINT32_RANGE;
  };
  const clone = () => createCloneableRngFromState(t);
  return { next, clone };
}

/**
 * Creates a Mulberry32 PRNG whose state can be cloned for lookahead simulation.
 */
export function createCloneableRng(seed?: number): CloneableRng {
  const normalizedSeed =
    typeof seed === "number" && Number.isFinite(seed)
      ? seed >>> 0
      : DEFAULT_SEED;
  return createCloneableRngFromState(normalizedSeed);
}

/**
 * Creates a scalar RNG callback for the specified RandomMode.
 */
export function createRng(mode: RandomMode, seed?: number): () => number {
  if (mode === "random") {
    return Math.random;
  }
  return createCloneableRng(seed).next;
}
