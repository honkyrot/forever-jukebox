import {
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "@/shared/utils/safeStorage";

export const AUDIO_BALANCE_STORAGE_KEY = "audioBalance";

export type AutocanonizerAudioBalance = {
  mainPan: number;
  otherPan: number;
  pinkPan: number;
  goldPan: number;
};

// Clamp pan values to the slider's [-100, 100] percentage range.
function clampPanPct(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

/**
 * Checks whether a parsed JSON field is a finite numeric pan value.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Resolve the saved autocanonizer L/R stream balance from localStorage.
 * Falls back to centered (0) defaults when missing, malformed, or unavailable.
 */
export function resolveStoredAudioBalance(): AutocanonizerAudioBalance {
  try {
    const raw = safeLocalStorageGet(AUDIO_BALANCE_STORAGE_KEY);
    if (!raw) {
      return { mainPan: 0, otherPan: 0, pinkPan: 0, goldPan: 0 };
    }
    const parsed = JSON.parse(raw) as {
      blue?: unknown;
      green?: unknown;
      pink?: unknown;
      gold?: unknown;
    };
    const blue = parsed?.blue;
    const green = parsed?.green;
    if (isFiniteNumber(blue) && isFiniteNumber(green)) {
      // Pink and gold are optional so legacy { blue, green } entries still load.
      return {
        mainPan: clampPanPct(blue),
        otherPan: clampPanPct(green),
        pinkPan: isFiniteNumber(parsed?.pink) ? clampPanPct(parsed.pink) : 0,
        goldPan: isFiniteNumber(parsed?.gold) ? clampPanPct(parsed.gold) : 0,
      };
    }
  } catch {
    // Ignore storage and JSON parse errors and use centered defaults.
  }
  return { mainPan: 0, otherPan: 0, pinkPan: 0, goldPan: 0 };
}

/**
 * Persist the autocanonizer L/R stream balance for all four voices to localStorage.
 */
export function storeAudioBalance(
  mainPan: number,
  otherPan: number,
  pinkPan = 0,
  goldPan = 0,
): void {
  safeLocalStorageSet(
    AUDIO_BALANCE_STORAGE_KEY,
    JSON.stringify({
      blue: clampPanPct(mainPan),
      green: clampPanPct(otherPan),
      pink: clampPanPct(pinkPan),
      gold: clampPanPct(goldPan),
    }),
  );
}
