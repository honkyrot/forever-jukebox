import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import {
  normalizeSpicyLyrics,
  type NormalizedLyrics,
} from "@forever-jukebox/shared/lyrics";
import { fetchJobLyrics } from "./api";
import { getCurrentTrackId, useAppStore } from "./store";

const LYRICS_KARAOKE_STORAGE_KEY = "fj-lyrics-karaoke-enabled";
const LYRICS_PANEL_STORAGE_KEY = "fj-lyrics-panel-open";
const LYRICS_ROMANIZATION_STORAGE_KEY = "fj-lyrics-romanization-enabled";
const LYRICS_OFFSETS_STORAGE_KEY = "fj-lyrics-offsets";

export const MIN_LYRICS_OFFSET_SEC = -30;
export const MAX_LYRICS_OFFSET_SEC = 30;
const OFFSET_STEP_PRECISION = 0.05;

export type LyricsStatus =
  | "idle"
  | "loading"
  | "loaded"
  | "not_found"
  | "error";

let lyricsAbortController: AbortController | null = null;
let lyricsFetchGeneration = 0;

/**
 * Clamps and snaps a lyrics sync offset in seconds to 0.05s increments within [-30, 30].
 */
export function clampLyricsOffsetSec(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  const clamped = Math.max(
    MIN_LYRICS_OFFSET_SEC,
    Math.min(MAX_LYRICS_OFFSET_SEC, raw),
  );
  const snapped =
    Math.round(clamped / OFFSET_STEP_PRECISION) * OFFSET_STEP_PRECISION;
  // Avoid `-0` and floating-point noise like 0.30000000000000004.
  const rounded = Math.round(snapped * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Reads the persisted karaoke lyrics bar toggle state.
 */
export function resolveStoredLyricsKaraokeEnabled(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  const stored = localStorage.getItem(LYRICS_KARAOKE_STORAGE_KEY);
  return stored === "1" || stored === "true";
}

/**
 * Persists the karaoke lyrics bar toggle state.
 */
export function storeLyricsKaraokeEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(LYRICS_KARAOKE_STORAGE_KEY, enabled ? "1" : "0");
}

/**
 * Reads the persisted left-side lyrics panel open state.
 */
export function resolveStoredLyricsPanelOpen(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  const stored = localStorage.getItem(LYRICS_PANEL_STORAGE_KEY);
  return stored === "1" || stored === "true";
}

/**
 * Persists the left-side lyrics panel open state.
 */
export function storeLyricsPanelOpen(open: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(LYRICS_PANEL_STORAGE_KEY, open ? "1" : "0");
}

/**
 * Reads the persisted romanization display toggle state.
 */
export function resolveStoredLyricsRomanizationEnabled(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  const stored = localStorage.getItem(LYRICS_ROMANIZATION_STORAGE_KEY);
  return stored === "1" || stored === "true";
}

/**
 * Persists the romanization display toggle state.
 */
export function storeLyricsRomanizationEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(LYRICS_ROMANIZATION_STORAGE_KEY, enabled ? "1" : "0");
}

function readOffsetsMap(): Record<string, number> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(LYRICS_OFFSETS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        result[key] = clampLyricsOffsetSec(val);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Reads the persisted sync offset (in seconds) for a given track or job ID.
 */
export function resolveStoredLyricsOffsetForTrack(
  trackId: string | null | undefined,
): number {
  if (!trackId) {
    return 0;
  }
  const map = readOffsetsMap();
  return map[trackId] ?? 0;
}

/**
 * Persists (or clears when zero) the sync offset for a given track or job ID.
 */
export function storeLyricsOffsetForTrack(
  trackId: string | null | undefined,
  offsetSec: number,
): void {
  if (typeof localStorage === "undefined" || !trackId) {
    return;
  }
  const map = readOffsetsMap();
  const clamped = clampLyricsOffsetSec(offsetSec);
  if (clamped === 0) {
    delete map[trackId];
  } else {
    map[trackId] = clamped;
  }
  try {
    localStorage.setItem(LYRICS_OFFSETS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors.
  }
}

/**
 * Aborts any in-flight lyrics lookup and clears track lyrics state.
 */
export function clearTrackLyrics(): void {
  lyricsFetchGeneration += 1;
  lyricsAbortController?.abort();
  lyricsAbortController = null;
  useAppStore.setState({
    lyricsStatus: "idle",
    lyricsData: null,
    lyricsJobId: null,
  });
}

/**
 * Returns true when lyrics are supported for the active play mode (single-track
 * Jukebox or single-song Autocanonizer).
 */
export function isLyricsSupportedMode(state: {
  playMode: PlayMode;
  multiTrackEnabled: boolean;
  autocanonizerMixEnabled: boolean;
}): boolean {
  if (state.playMode === "jukebox") {
    return !state.multiTrackEnabled;
  }
  if (state.playMode === "autocanonizer") {
    return !state.autocanonizerMixEnabled;
  }
  return false;
}

function canFetchLyricsNow(state = useAppStore.getState()): boolean {
  return Boolean(
    state.appConfig?.allow_lyrics &&
      isLyricsSupportedMode(state) &&
      state.lastJobId &&
      (state.lyricsKaraokeEnabled || state.lyricsPanelOpen),
  );
}

/**
 * Fetches and normalizes lyrics for the active single-track Jukebox job.
 * Deduplicates already-loaded jobs unless `refresh` is explicitly requested.
 */
export async function loadLyricsForCurrentTrack(options?: {
  refresh?: boolean;
}): Promise<NormalizedLyrics | null> {
  const state = useAppStore.getState();
  if (!canFetchLyricsNow(state)) {
    return state.lyricsData;
  }
  const jobId = state.lastJobId;
  if (!jobId) {
    return null;
  }
  const refresh = Boolean(options?.refresh);
  if (
    !refresh &&
    state.lyricsJobId === jobId &&
    (state.lyricsStatus === "loaded" || state.lyricsStatus === "not_found")
  ) {
    return state.lyricsData;
  }

  lyricsAbortController?.abort();
  const controller = new AbortController();
  lyricsAbortController = controller;
  const generation = ++lyricsFetchGeneration;

  useAppStore.setState({
    lyricsStatus: "loading",
    lyricsJobId: jobId,
    ...(refresh ? {} : { lyricsData: null }),
  });

  try {
    const response = await fetchJobLyrics(jobId, {
      signal: controller.signal,
      refresh,
      duration: state.trackDurationSec,
    });
    if (controller.signal.aborted || generation !== lyricsFetchGeneration) {
      return null;
    }
    if (response.status !== "found" || !response.lyrics) {
      useAppStore.setState({
        lyricsStatus: "not_found",
        lyricsData: null,
        lyricsJobId: jobId,
      });
      return null;
    }
    const normalized = normalizeSpicyLyrics(response.lyrics);
    if (!normalized || normalized.lines.length === 0) {
      useAppStore.setState({
        lyricsStatus: "not_found",
        lyricsData: null,
        lyricsJobId: jobId,
      });
      return null;
    }
    const enriched: NormalizedLyrics = {
      ...normalized,
      ...(response.matched_title ? { title: response.matched_title } : {}),
      ...(response.matched_artist ? { artist: response.matched_artist } : {}),
    };
    useAppStore.setState({
      lyricsStatus: "loaded",
      lyricsData: enriched,
      lyricsJobId: jobId,
    });
    return enriched;
  } catch (err) {
    if (controller.signal.aborted || generation !== lyricsFetchGeneration) {
      return null;
    }
    console.warn(`Lyrics fetch failed: ${String(err)}`);
    useAppStore.setState({
      lyricsStatus: "error",
      lyricsData: null,
      lyricsJobId: jobId,
    });
    return null;
  } finally {
    if (lyricsAbortController === controller) {
      lyricsAbortController = null;
    }
  }
}

/**
 * Enables or disables the two-line karaoke lyrics bar and triggers a fetch if needed.
 */
export function setLyricsKaraokeEnabled(enabled: boolean): void {
  storeLyricsKaraokeEnabled(enabled);
  useAppStore.setState({ lyricsKaraokeEnabled: enabled });
  if (enabled) {
    void loadLyricsForCurrentTrack();
  }
}

/**
 * Opens or closes the left-side scrollable lyrics panel and triggers a fetch if needed.
 */
export function setLyricsPanelOpen(open: boolean): void {
  storeLyricsPanelOpen(open);
  useAppStore.setState({ lyricsPanelOpen: open });
  if (open) {
    void loadLyricsForCurrentTrack();
  }
}

/**
 * Enables or disables romanized/transliterated lyrics rendering and persists the preference.
 */
export function setLyricsRomanizationEnabled(enabled: boolean): void {
  storeLyricsRomanizationEnabled(enabled);
  useAppStore.setState({ lyricsRomanizationEnabled: enabled });
}

/**
 * Adjusts the current track's lyrics timing offset by `deltaSec` and persists it.
 */
export function adjustLyricsOffset(deltaSec: number): number {
  const next = clampLyricsOffsetSec(useAppStore.getState().lyricsOffsetSec + deltaSec);
  useAppStore.setState({ lyricsOffsetSec: next });
  storeLyricsOffsetForTrack(getCurrentTrackId(), next);
  return next;
}

/**
 * Resets the current track's lyrics timing offset back to 0s.
 */
export function resetLyricsOffset(): void {
  useAppStore.setState({ lyricsOffsetSec: 0 });
  storeLyricsOffsetForTrack(getCurrentTrackId(), 0);
}
