const LOOKAHEAD_ENABLED_STORAGE_KEY = "fj-branch-lookahead-enabled";
const LOOKAHEAD_COUNT_STORAGE_KEY = "fj-branch-lookahead-count";

export const DEFAULT_BRANCH_LOOKAHEAD_COUNT = 3;
export const MIN_BRANCH_LOOKAHEAD_COUNT = 1;
export const MAX_BRANCH_LOOKAHEAD_COUNT = 8;

/**
 * Clamps the predicted branch count to the supported integer range [1, 8].
 */
export function clampBranchLookaheadCount(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_BRANCH_LOOKAHEAD_COUNT;
  }
  return Math.max(
    MIN_BRANCH_LOOKAHEAD_COUNT,
    Math.min(MAX_BRANCH_LOOKAHEAD_COUNT, Math.round(raw)),
  );
}

/**
 * Reads the persisted toggle state for upcoming branch lookahead visualization.
 */
export function resolveStoredBranchLookaheadEnabled(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  const stored = localStorage.getItem(LOOKAHEAD_ENABLED_STORAGE_KEY);
  return stored === "1" || stored === "true";
}

/**
 * Persists whether upcoming branch lookahead visualization is enabled.
 */
export function storeBranchLookaheadEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(LOOKAHEAD_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
}

/**
 * Reads and clamps the persisted count of upcoming predicted branches to display.
 */
export function resolveStoredBranchLookaheadCount(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_BRANCH_LOOKAHEAD_COUNT;
  }
  const raw = localStorage.getItem(LOOKAHEAD_COUNT_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_BRANCH_LOOKAHEAD_COUNT;
  }
  const parsed = Number.parseInt(raw, 10);
  return clampBranchLookaheadCount(parsed);
}

/**
 * Persists the clamped count of upcoming predicted branches to display.
 */
export function storeBranchLookaheadCount(count: number): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(
    LOOKAHEAD_COUNT_STORAGE_KEY,
    String(clampBranchLookaheadCount(count)),
  );
}
