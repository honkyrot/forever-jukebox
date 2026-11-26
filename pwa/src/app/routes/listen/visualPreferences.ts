import {
  readStoredVisualPreferences,
  type VisualPreferences,
} from "@forever-jukebox/shared/viz/JukeboxViz";
import {
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "@/shared/utils/safeStorage";

const BPM_BAR_ENABLED_KEY = "bpmBarEnabled";
const VISUAL_EFFECT_MODE_KEY = "visualEffectMode";
const USE_SQUARE_BEATS_KEY = "useSquareBeats";
const USE_ALT_SEEK_SHAPE_KEY = "useAltSeekShape";

/**
 * Reads persisted Jukebox visualization preferences from localStorage.
 */
export function resolveStoredVisualPreferences(): VisualPreferences {
  return readStoredVisualPreferences();
}

/**
 * Persists a partial patch of Jukebox visualization preferences to localStorage.
 */
export function storeVisualPreferences(patch: Partial<VisualPreferences>): void {
  if (patch.visualEffectMode !== undefined) {
    safeLocalStorageSet(VISUAL_EFFECT_MODE_KEY, patch.visualEffectMode);
  }
  if (patch.useSquareBeats !== undefined) {
    safeLocalStorageSet(USE_SQUARE_BEATS_KEY, String(patch.useSquareBeats));
  }
  if (patch.useAltSeekShape !== undefined) {
    safeLocalStorageSet(USE_ALT_SEEK_SHAPE_KEY, String(patch.useAltSeekShape));
  }
}

/**
 * Reads whether the BPM beat-pulse bar is enabled (defaults to true).
 */
export function resolveStoredBpmBarEnabled(): boolean {
  const stored = safeLocalStorageGet(BPM_BAR_ENABLED_KEY);
  return stored !== "false";
}

/**
 * Persists whether the BPM beat-pulse bar is enabled.
 */
export function storeBpmBarEnabled(enabled: boolean): void {
  safeLocalStorageSet(BPM_BAR_ENABLED_KEY, String(enabled));
}
