import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeSpicyLyrics } from "@forever-jukebox/shared/lyrics";
import { useAppStore } from "../../store";
import { LyricsKaraokeBar } from "./LyricsKaraokeBar";

type PredictedJumpStub = {
  fromIndex: number;
  toIndex: number;
  edgeId: number | null;
};

const h = vi.hoisted(() => ({
  playbackTime: 5.1,
  currentBeatIndex: 10,
  nextJump: null as PredictedJumpStub | null,
  getPredictedJumps: vi.fn((_count: number): PredictedJumpStub[] => []),
  canonizerCursor: null as {
    mainSeconds: number | null;
    otherSeconds: number | null;
    inUnison: boolean;
  } | null,
}));

vi.mock("../../runtime", () => ({
  getAppContext: vi.fn(() => ({
    player: { getCurrentTime: () => h.playbackTime },
    engine: {
      getCurrentBeatIndex: () => h.currentBeatIndex,
      getBeatAtTime: () => ({ which: h.currentBeatIndex }),
      getPredictedJumps: h.getPredictedJumps,
    },
    autocanonizer: {
      getLiveCursorTimes: () => h.canonizerCursor,
    },
  })),
}));

const initialState = useAppStore.getState();

function makeBeats(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 0.5,
    duration: 0.5,
    which: i,
    prev: null,
    next: null,
    overlappingSegments: [],
    neighbors: [],
    allNeighbors: [],
  }));
}

describe("LyricsKaraokeBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.playbackTime = 5.1;
    h.currentBeatIndex = 10;
    h.nextJump = null;
    h.canonizerCursor = null;
    h.getPredictedJumps.mockImplementation(() => (h.nextJump ? [h.nextJump] : []));
    useAppStore.setState(initialState, true);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders word-grouped syllables without flash classes, branch preview, and offset nudges", async () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 4.0,
              EndTime: 6.0,
              Syllables: [
                { Text: "Hel", IsPartOfWord: true, StartTime: 4.0, EndTime: 4.6 },
                { Text: "lo", IsPartOfWord: false, StartTime: 4.6, EndTime: 5.2 },
                { Text: "world", IsPartOfWord: false, StartTime: 5.2, EndTime: 6.0 },
              ],
            },
          },
          {
            Type: "Vocal",
            Lead: {
              StartTime: 8.0,
              EndTime: 10.0,
              Syllables: [{ Text: "Next", IsPartOfWord: false, StartTime: 8.0, EndTime: 10.0 }],
            },
          },
          {
            Type: "Vocal",
            Lead: {
              StartTime: 14.0,
              EndTime: 16.0,
              Syllables: [
                { Text: "Jumped", IsPartOfWord: false, StartTime: 14.0, EndTime: 15.0 },
                { Text: "lyric", IsPartOfWord: false, StartTime: 15.0, EndTime: 16.0 },
              ],
            },
          },
        ],
      },
    });

    h.nextJump = { fromIndex: 12, toIndex: 28, edgeId: 5 };

    act(() => {
      useAppStore.setState({
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        lyricsKaraokeEnabled: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
        lastTrackId: "track-1",
        branchLookaheadCount: 3,
        metronomeDetectedBeatsPerBar: 4,
        vizData: {
          beats: makeBeats(40),
          beatVisits: [],
          beatColors: [],
          edges: [],
          lastBranchPoint: 0,
          anchorEdgeId: null,
          userAnchorEdgeId: null,
          putBackAnchorEdgeId: null,
        },
      });
    });

    render(<LyricsKaraokeBar />);

    const bar = document.getElementById("lyrics-karaoke-bar");
    expect(bar).not.toBeNull();
    expect(bar?.querySelector(".lyrics-karaoke-active")?.textContent).toBe("Hello world");

    const words = bar?.querySelectorAll(".lyrics-karaoke-active .lyrics-word");
    expect(words).toHaveLength(2);
    expect(words?.[0]?.textContent).toBe("Hello");
    expect(words?.[1]?.textContent).toBe("world");
    expect(bar?.querySelector(".lyrics-syllable.is-active")).toBeNull();
    expect(bar?.querySelector(".lyrics-syllable.is-complete")).toBeNull();

    expect(h.getPredictedJumps).toHaveBeenCalledWith(3);

    const nextEl = bar?.querySelector(".lyrics-karaoke-next");
    expect(nextEl?.classList.contains("is-visible")).toBe(true);
    expect(nextEl?.classList.contains("is-branch-preview")).toBe(true);
    expect(nextEl?.textContent).toContain("Jumped lyric");

    const plusBtn = bar?.querySelectorAll(".lyrics-offset-btn")[1] as HTMLButtonElement;
    await userEvent.click(plusBtn);
    expect(useAppStore.getState().lyricsOffsetSec).toBe(0.1);
  });

  it("tweens finished lines upward out of the bar and cleans up after animationEnd", () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          { Type: "Vocal", Text: "First line", StartTime: 4.0, EndTime: 6.0 },
          { Type: "Vocal", Text: "Second line", StartTime: 8.0, EndTime: 10.0 },
        ],
      },
    });

    h.playbackTime = 5.0;

    act(() => {
      useAppStore.setState({
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        lyricsKaraokeEnabled: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
        lastTrackId: "track-1",
      });
    });

    render(<LyricsKaraokeBar />);
    const bar = document.getElementById("lyrics-karaoke-bar")!;
    expect(bar.querySelector(".lyrics-karaoke-active")?.textContent).toBe("First line");
    expect(bar.querySelector(".lyrics-karaoke-exiting")).toBeNull();

    // Advance into an instrumental gap -> "First line" tweens upward out.
    h.playbackTime = 6.8;
    act(() => {
      useAppStore.setState({ lyricsOffsetSec: 0.05 });
    });

    const exiting = bar.querySelector(".lyrics-karaoke-exiting");
    expect(exiting).not.toBeNull();
    expect(exiting?.textContent).toBe("First line");
    expect(bar.querySelector(".lyrics-karaoke-next-line")?.textContent).toBe("Second line");

    fireEvent.animationEnd(exiting!);
    expect(bar.querySelector(".lyrics-karaoke-exiting")).toBeNull();
  });

  it("renders dedicated Blue/Green lanes with in-place previews scaling to full size without crossing rows", () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Line",
        Content: [
          { Type: "Vocal", Text: "Main voice line", StartTime: 3.0, EndTime: 6.0 },
          { Type: "Vocal", Text: "Canon voice line", StartTime: 11.0, EndTime: 14.0 },
        ],
      },
    });

    // Both voices resting within 2.5s of their upcoming lines -> previews stay in their own rows.
    h.canonizerCursor = { mainSeconds: 1.5, otherSeconds: 9.5, inUnison: false };

    act(() => {
      useAppStore.setState({
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "autocanonizer",
        autocanonizerMixEnabled: false,
        lyricsKaraokeEnabled: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        isRunning: true,
      });
    });

    render(<LyricsKaraokeBar />);
    const bar = document.getElementById("lyrics-karaoke-bar")!;
    expect(bar.classList.contains("is-canonizer-lyrics")).toBe(true);

    const row1Preview = bar.querySelector(".lyrics-karaoke-current .is-lane-preview");
    const row2Preview = bar.querySelector(".is-canon-other-lane .is-lane-preview");
    expect(row1Preview?.textContent).toBe("Main voice line");
    expect(row2Preview?.textContent).toBe("Canon voice line");

    // Advance into active singing -> same DOM nodes transition in-place to .is-lane-active.
    h.canonizerCursor = { mainSeconds: 3.5, otherSeconds: 11.5, inUnison: false };
    act(() => {
      useAppStore.setState({ lyricsOffsetSec: 0.05 });
    });

    const row1Active = bar.querySelector(".lyrics-karaoke-current .is-lane-active.lyrics-voice-main");
    const row2Active = bar.querySelector(".is-canon-other-lane .is-lane-active.lyrics-voice-other");
    expect(row1Active).toBe(row1Preview);
    expect(row2Active).toBe(row2Preview);
    expect(row1Active?.textContent).toBe("Main voice line");
    expect(row2Active?.textContent).toBe("Canon voice line");

    // Unison clears Row 2 via downward exit tween and shows dual Blue+Green dots on Row 1.
    h.canonizerCursor = { mainSeconds: 3.5, otherSeconds: 3.5, inUnison: true };
    act(() => {
      useAppStore.setState({ lyricsOffsetSec: 0.1 });
    });
    expect(bar.querySelectorAll(".lyrics-voice-main .lyrics-voice-dot")).toHaveLength(2);
    expect(bar.querySelector(".lyrics-voice-other")).toBeNull();
    const otherExit = bar.querySelector(".is-canon-other-lane .is-canonizer-other-exit");
    expect(otherExit?.textContent).toBe("Canon voice line");
    fireEvent.animationEnd(otherExit!);
    expect(bar.querySelector(".is-canon-other-lane .is-canonizer-other-exit")).toBeNull();
  });

  it("renders romanized active syllables and preview lines when romanization is enabled", () => {
    const lyrics = normalizeSpicyLyrics({
      Body: {
        Type: "Syllable",
        HasTransliterations: true,
        Content: [
          {
            Type: "Vocal",
            Lead: {
              StartTime: 4.0,
              EndTime: 6.0,
              Syllables: [
                {
                  Text: "星",
                  TransliteratedText: "Ho",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: true,
                  StartTime: 4.0,
                  EndTime: 4.8,
                },
                {
                  Text: "を",
                  TransliteratedText: "shi",
                  IsPartOfWord: true,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 4.8,
                  EndTime: 5.4,
                },
                {
                  Text: "見る",
                  TransliteratedText: "miru",
                  IsPartOfWord: false,
                  TransliteratedIsPartOfWord: false,
                  StartTime: 5.4,
                  EndTime: 6.0,
                },
              ],
            },
          },
          {
            Type: "Vocal",
            Lead: {
              StartTime: 7.0,
              EndTime: 9.0,
              TransliteratedText: "Yoru ni",
              Syllables: [
                {
                  Text: "夜に",
                  IsPartOfWord: false,
                  StartTime: 7.0,
                  EndTime: 9.0,
                },
              ],
            },
          },
        ],
      },
    });

    h.playbackTime = 5.5;
    act(() => {
      useAppStore.setState({
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "jukebox",
        multiTrackEnabled: false,
        lyricsKaraokeEnabled: true,
        lyricsRomanizationEnabled: true,
        lyricsStatus: "loaded",
        lyricsData: lyrics,
        lyricsOffsetSec: 0,
      });
    });

    render(<LyricsKaraokeBar />);
    const bar = document.getElementById("lyrics-karaoke-bar")!;
    expect(bar.querySelector(".lyrics-karaoke-active")?.textContent).toBe("Hoshi miru");
    expect(bar.querySelectorAll(".lyrics-karaoke-active .lyrics-word")).toHaveLength(2);
    expect(bar.querySelector(".lyrics-karaoke-next-line")?.textContent).toBe("Yoru ni");
  });

  it("hides outside supported modes", () => {
    act(() => {
      useAppStore.setState({
        appConfig: { allow_user_upload: false, allow_user_url: false, allow_lyrics: true },
        playMode: "wubmachine",
        lyricsKaraokeEnabled: true,
      });
    });
    render(<LyricsKaraokeBar />);
    expect(document.getElementById("lyrics-karaoke-bar")).toBeNull();
  });
});
