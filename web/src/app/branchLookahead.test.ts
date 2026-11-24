import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH_LOOKAHEAD_COUNT,
  MAX_BRANCH_LOOKAHEAD_COUNT,
  MIN_BRANCH_LOOKAHEAD_COUNT,
  clampBranchLookaheadCount,
  resolveStoredBranchLookaheadCount,
  resolveStoredBranchLookaheadEnabled,
  storeBranchLookaheadCount,
  storeBranchLookaheadEnabled,
} from "./branchLookahead";

function setLocalStorage() {
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
  return store;
}

describe("branchLookahead preferences", () => {
  beforeEach(() => {
    setLocalStorage();
  });

  it("defaults to disabled with 3 upcoming branches", () => {
    expect(resolveStoredBranchLookaheadEnabled()).toBe(false);
    expect(resolveStoredBranchLookaheadCount()).toBe(
      DEFAULT_BRANCH_LOOKAHEAD_COUNT,
    );
  });

  it("round-trips stored toggle state", () => {
    storeBranchLookaheadEnabled(true);
    expect(resolveStoredBranchLookaheadEnabled()).toBe(true);
    storeBranchLookaheadEnabled(false);
    expect(resolveStoredBranchLookaheadEnabled()).toBe(false);
  });

  it("clamps count values on store and read", () => {
    expect(clampBranchLookaheadCount(Number.NaN)).toBe(
      DEFAULT_BRANCH_LOOKAHEAD_COUNT,
    );
    expect(clampBranchLookaheadCount(0)).toBe(MIN_BRANCH_LOOKAHEAD_COUNT);
    expect(clampBranchLookaheadCount(99)).toBe(MAX_BRANCH_LOOKAHEAD_COUNT);

    storeBranchLookaheadCount(12);
    expect(resolveStoredBranchLookaheadCount()).toBe(MAX_BRANCH_LOOKAHEAD_COUNT);

    localStorage.setItem("fj-branch-lookahead-count", "invalid");
    expect(resolveStoredBranchLookaheadCount()).toBe(
      DEFAULT_BRANCH_LOOKAHEAD_COUNT,
    );

    localStorage.setItem("fj-branch-lookahead-count", "5");
    expect(resolveStoredBranchLookaheadCount()).toBe(5);
  });
});
