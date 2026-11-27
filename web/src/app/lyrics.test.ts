// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustLyricsOffset,
  clampLyricsOffsetSec,
  clearTrackLyrics,
  loadLyricsForCurrentTrack,
  resetLyricsOffset,
  resolveStoredLyricsKaraokeEnabled,
  resolveStoredLyricsOffsetForTrack,
  resolveStoredLyricsPanelOpen,
  resolveStoredLyricsRomanizationEnabled,
  setLyricsKaraokeEnabled,
  setLyricsPanelOpen,
  setLyricsRomanizationEnabled,
} from "./lyrics";
import { fetchJobLyrics } from "./api";
import { useAppStore } from "./store";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchJobLyrics: vi.fn(),
}));

const initialState = useAppStore.getState();

describe("lyrics store & persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAppStore.setState(initialState, true);
    clearTrackLyrics();
  });

  afterEach(() => {
    clearTrackLyrics();
  });

  it("persists karaoke, panel, and romanization toggles in localStorage", () => {
    expect(resolveStoredLyricsKaraokeEnabled()).toBe(false);
    expect(resolveStoredLyricsPanelOpen()).toBe(false);
    expect(resolveStoredLyricsRomanizationEnabled()).toBe(false);

    setLyricsKaraokeEnabled(true);
    setLyricsPanelOpen(true);
    setLyricsRomanizationEnabled(true);

    expect(resolveStoredLyricsKaraokeEnabled()).toBe(true);
    expect(resolveStoredLyricsPanelOpen()).toBe(true);
    expect(resolveStoredLyricsRomanizationEnabled()).toBe(true);
    expect(useAppStore.getState().lyricsKaraokeEnabled).toBe(true);
    expect(useAppStore.getState().lyricsPanelOpen).toBe(true);
    expect(useAppStore.getState().lyricsRomanizationEnabled).toBe(true);

    setLyricsRomanizationEnabled(false);
    expect(resolveStoredLyricsRomanizationEnabled()).toBe(false);
    expect(useAppStore.getState().lyricsRomanizationEnabled).toBe(false);
  });

  it("clamps and persists per-track sync offsets", () => {
    expect(clampLyricsOffsetSec(99)).toBe(30);
    expect(clampLyricsOffsetSec(-99)).toBe(-30);
    expect(clampLyricsOffsetSec(0.1 + 0.2)).toBe(0.3);

    useAppStore.setState({ lastTrackId: "track-1", lyricsOffsetSec: 0 });
    expect(adjustLyricsOffset(0.1)).toBe(0.1);
    expect(adjustLyricsOffset(0.5)).toBe(0.6);
    expect(resolveStoredLyricsOffsetForTrack("track-1")).toBe(0.6);

    resetLyricsOffset();
    expect(useAppStore.getState().lyricsOffsetSec).toBe(0);
    expect(resolveStoredLyricsOffsetForTrack("track-1")).toBe(0);
  });

  it("fetches and normalizes lyrics when enabled in single-track jukebox mode", async () => {
    vi.mocked(fetchJobLyrics).mockResolvedValueOnce({
      status: "found",
      matched_title: "Song",
      matched_artist: "Artist",
      lyrics: {
        Type: "Line",
        Content: [{ Type: "Vocal", Text: "Hello world", StartTime: 1.5, EndTime: 4.0 }],
      },
    });

    useAppStore.setState({
      appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
      playMode: "jukebox",
      multiTrackEnabled: false,
      lastJobId: "job-123",
      trackDurationSec: 180,
      lyricsKaraokeEnabled: true,
    });

    const result = await loadLyricsForCurrentTrack();
    expect(fetchJobLyrics).toHaveBeenCalledWith("job-123", {
      signal: expect.any(AbortSignal),
      refresh: false,
      duration: 180,
    });
    expect(result?.type).toBe("line");
    expect(result?.lines[0].text).toBe("Hello world");
    expect(useAppStore.getState().lyricsStatus).toBe("loaded");
  });

  it("marks not_found when API returns not_found and clears cleanly on abort/reset", async () => {
    vi.mocked(fetchJobLyrics).mockResolvedValueOnce({ status: "not_found" });

    useAppStore.setState({
      appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
      playMode: "jukebox",
      multiTrackEnabled: false,
      lastJobId: "job-404",
      lyricsPanelOpen: true,
    });

    const result = await loadLyricsForCurrentTrack();
    expect(result).toBeNull();
    expect(useAppStore.getState().lyricsStatus).toBe("not_found");

    clearTrackLyrics();
    expect(useAppStore.getState().lyricsStatus).toBe("idle");
    expect(useAppStore.getState().lyricsJobId).toBeNull();
  });
});
