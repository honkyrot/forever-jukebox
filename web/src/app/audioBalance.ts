export const AUDIO_BALANCE_STORAGE_KEY = "audioBalance";

export type AutocanonizerAudioBalance = {
  mainPan: number;
  otherPan: number;
};

// Clamp pan values to the slider's [-100, 100] percentage range.
function clampPanPct(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

/**
 * Resolve the saved autocanonizer L/R stream balance from localStorage.
 * Falls back to centered (0, 0) when missing, malformed, or unavailable.
 */
export function resolveStoredAudioBalance(): AutocanonizerAudioBalance {
  try {
    const raw = localStorage.getItem(AUDIO_BALANCE_STORAGE_KEY);
    if (!raw) {
      return { mainPan: 0, otherPan: 0 };
    }
    const parsed = JSON.parse(raw) as { blue?: unknown; green?: unknown };
    const blue = parsed?.blue;
    const green = parsed?.green;
    if (
      typeof blue === "number" &&
      Number.isFinite(blue) &&
      typeof green === "number" &&
      Number.isFinite(green)
    ) {
      return {
        mainPan: clampPanPct(blue),
        otherPan: clampPanPct(green),
      };
    }
  } catch {
    // Ignore storage and JSON parse errors and use centered defaults.
  }
  return { mainPan: 0, otherPan: 0 };
}

/**
 * Persist the autocanonizer L/R stream balance to localStorage.
 */
export function storeAudioBalance(mainPan: number, otherPan: number): void {
  try {
    localStorage.setItem(
      AUDIO_BALANCE_STORAGE_KEY,
      JSON.stringify({
        blue: clampPanPct(mainPan),
        green: clampPanPct(otherPan),
      }),
    );
  } catch {
    // Balance still applies for this session without storage.
  }
}
