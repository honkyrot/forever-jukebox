import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeSpicyLyrics } from "@forever-jukebox/shared/lyrics";
import { useAppStore } from "../../store";
import { LyricsPanel } from "./LyricsPanel";

const h = vi.hoisted(() => ({
  seek: vi.fn(),
  syncToPlaybackPosition: vi.fn(),
  update: vi.fn(),
  playbackTime: 2.5,
  currentBeatIndex: 4,
  canonizerCursor: null as {
    mainSeconds: number | null;
    otherSeconds: number | null;
    inUnison: boolean;
  } | null,
  findBeatIndexByTime: vi.fn(() => 6),
  startAutocanonizerPlayback: vi.fn(),
}));

vi.mock("../../runtime", () => ({
  getAppContext: vi.fn(() => ({
    player: {
      getCurrentTime: () => h.playbackTime,
      seek: h.seek,
    },
    engine: {
      getCurrentBeatIndex: () => h.currentBeatIndex,
      getBeatAtTime: () => ({ which: h.currentBeatIndex }),
      getPredictedJumps: () => [],
      syncToPlaybackPosition: h.syncToPlaybackPosition,
    },
    autocanonizer: {
      getLiveCursorTimes: () => h.canonizerCursor,
      findBeatIndexByTime: h.findBeatIndexByTime,
    },
    jukebox: {
      update: h.update,
    },
  })),
}));

vi.mock("../../playback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playback")>()),
  syncPredictedJumps: vi.fn(),
  startAutocanonizerPlayback: h.startAutocanonizerPlayback,
}));

const initialState = useAppStore.getState();

describe("LyricsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.playbackTime = 2.5;
    h.currentBeatIndex = 4;
    h.canonizerCursor = null;
    useAppStore.setState(initialState, true);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders scrollable lyrics, collapses via edge tab, adjusts offset, and seeks on line click", async () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        SongWriters: ["Writer One"],
        Content: [
          { Type: "Vocal", Text: "First verse line", StartTime: 2.0, EndTime: 5.0 },
          { Type: "Vocal", Text: "Second verse line", StartTime: 8.0, EndTime: 11.0 },
        ],
      },
    });

    act(() => {
      useAppStore.setState({
        activeTabId: "play",
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        lyricsPanelOpen: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
        lastTrackId: "track-1",
        trackTitle: "Suzie",
        trackArtist: "Hourhand",
      });
    });

    render(<LyricsPanel />);

    const panel = document.getElementById("lyrics-side-panel");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("First verse line");
    expect(panel?.textContent).toContain("Second verse line");
    expect(panel?.textContent).toContain("Writer One");

    const lines = panel?.querySelectorAll(".lyrics-panel-line") ?? [];
    expect(lines[0]?.classList.contains("is-active")).toBe(true);

    // Click second line -> seeks audio and syncs engine.
    await userEvent.click(lines[1] as HTMLButtonElement);
    expect(h.seek).toHaveBeenCalledWith(8.0);
    expect(h.syncToPlaybackPosition).toHaveBeenCalled();

    // Collapse & expand via edge tab.
    const collapseTab = document.getElementById("lyrics-panel-collapse-tab")!;
    await userEvent.click(collapseTab);
    expect(panel?.classList.contains("is-collapsed")).toBe(true);
    await userEvent.click(collapseTab);
    expect(panel?.classList.contains("is-collapsed")).toBe(false);

    // Close button hides the panel in store.
    await userEvent.click(document.getElementById("lyrics-panel-close")!);
    expect(useAppStore.getState().lyricsPanelOpen).toBe(false);
  });

  it("color-codes Main (Blue), Canon (Green), and unison lines in autocanonizer mode and seeks via startAutocanonizerPlayback", async () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          { Type: "Vocal", Text: "Line A", StartTime: 2.0, EndTime: 5.0 },
          { Type: "Vocal", Text: "Line B", StartTime: 8.0, EndTime: 11.0 },
        ],
      },
    });

    h.canonizerCursor = { mainSeconds: 3.0, otherSeconds: 9.0, inUnison: false };

    act(() => {
      useAppStore.setState({
        activeTabId: "play",
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "autocanonizer",
        autocanonizerMixEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        lyricsPanelOpen: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
        isRunning: true,
      });
    });

    render(<LyricsPanel />);
    const panel = document.getElementById("lyrics-side-panel")!;
    expect(panel.querySelector(".lyrics-panel-legend")).not.toBeNull();

    let lines = panel.querySelectorAll(".lyrics-panel-line");
    expect(lines[0]?.classList.contains("is-canon-main")).toBe(true);
    expect(lines[1]?.classList.contains("is-canon-other")).toBe(true);

    // Clicking Line B seeks Autocanonizer via findBeatIndexByTime + startAutocanonizerPlayback.
    await userEvent.click(lines[1] as HTMLButtonElement);
    expect(h.findBeatIndexByTime).toHaveBeenCalledWith(8.0);
    expect(h.startAutocanonizerPlayback).toHaveBeenCalledWith(
      expect.anything(),
      6,
      { resetSession: false },
    );

    // Unison marks the shared line with .is-canon-both.
    h.canonizerCursor = { mainSeconds: 3.0, otherSeconds: 3.0, inUnison: true };
    act(() => {
      useAppStore.setState({ lyricsOffsetSec: 0.05 });
    });
    lines = panel.querySelectorAll(".lyrics-panel-line");
    expect(lines[0]?.classList.contains("is-canon-both")).toBe(true);
  });

  it("toggles romanized lyrics on transliterated tracks and disables when unavailable", async () => {
    const japaneseLyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        HasTransliterations: true,
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 2.0,
              EndTime: 4.0,
              Syllables: [
                {
                  Text: "星",
                  TransliteratedText: "Ho",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: true,
                  StartTime: 2.0,
                  EndTime: 2.6,
                },
                {
                  Text: "を",
                  TransliteratedText: "shi",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 2.6,
                  EndTime: 3.2,
                },
                {
                  Text: "見る",
                  TransliteratedText: "miru",
                  IsPartOfWord: false,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 3.2,
                  EndTime: 4.0,
                },
              ],
            },
          },
          {
            Type: "Vocal",
            Lead: {
              StartTime: 6.0,
              EndTime: 8.0,
              Syllables: [
                {
                  Text: "夜",
                  TransliteratedText: "Yoru",
                  IsPartOfWord: false,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 6.0,
                  EndTime: 8.0,
                },
              ],
            },
          },
        ],
      },
    });

    act(() => {
      useAppStore.setState({
        activeTabId: "play",
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        lyricsPanelOpen: true,
        lyricsRomanizationEnabled: false,
        lyricsStatus: "loaded",
        lyricsData: japaneseLyrics,
        lyricsOffsetSec: 0,
      });
    });

    render(<LyricsPanel />);
    const toggle = document.getElementById(
      "lyrics-romanization-toggle",
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    const panel = document.getElementById("lyrics-side-panel")!;
    expect(panel.textContent).toContain("星を見る");
    expect(panel.textContent).toContain("夜");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(useAppStore.getState().lyricsRomanizationEnabled).toBe(true);
    expect(localStorage.getItem("fj-lyrics-romanization-enabled")).toBe("1");
    expect(panel.textContent).toContain("Hoshi miru");
    expect(panel.textContent).toContain("Yoru");
    expect(panel.querySelectorAll(".lyrics-panel-line.is-active .lyrics-word")).toHaveLength(2);

    // Track without transliterations disables the toggle gracefully without erasing preference.
    const plainLyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [{ Type: "Vocal", Text: "English only", StartTime: 2.0, EndTime: 4.0 }],
      },
    });
    act(() => {
      useAppStore.setState({ lyricsData: plainLyrics });
    });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(panel.textContent).toContain("English only");
    expect(useAppStore.getState().lyricsRomanizationEnabled).toBe(true);
  });

  it("renders concurrent background vocals with independent syllable sweep in the side panel", () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 2.0,
              EndTime: 4.5,
              Syllables: [
                { Text: "I", IsPartOfWord: false, StartTime: 2.0, EndTime: 2.2 },
                { Text: "banged", IsPartOfWord: false, StartTime: 2.2, EndTime: 2.6 },
                { Text: "the", IsPartOfWord: false, StartTime: 2.6, EndTime: 2.8 },
                { Text: "drums", IsPartOfWord: false, StartTime: 2.8, EndTime: 4.5 },
              ],
            },
            Background: [
              {
                StartTime: 2.0,
                EndTime: 4.5,
                Syllables: [
                  { Text: "威", IsPartOfWord: true, StartTime: 2.0, EndTime: 3.0 },
                  { Text: "武", IsPartOfWord: false, StartTime: 3.0, EndTime: 4.5 },
                ],
              },
            ],
          },
        ],
      },
    });

    h.playbackTime = 2.5;
    act(() => {
      useAppStore.setState({
        activeTabId: "play",
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        lyricsPanelOpen: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
      });
    });

    render(<LyricsPanel />);
    const panel = document.getElementById("lyrics-side-panel")!;
    const leadEl = panel.querySelector(".lyrics-panel-line.is-active .lyrics-panel-lead");
    const bgEl = panel.querySelector(".lyrics-panel-line.is-active .lyrics-panel-bg");
    expect(leadEl?.textContent).toBe("I banged the drums");
    expect(bgEl?.textContent).toBe("威武");
    expect(bgEl?.classList.contains("is-bg-active")).toBe(true);
    const bgSyllables = bgEl?.querySelectorAll(".lyrics-syllable");
    expect(bgSyllables).toHaveLength(2);
    expect((bgSyllables?.[0] as HTMLElement).style.getPropertyValue("--syllable-progress")).toBe("50%");
  });
});
