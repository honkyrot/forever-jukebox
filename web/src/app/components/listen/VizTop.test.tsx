import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "../../store";
import { VizTop } from "./VizTop";
import { VISUALIZATION_LABELS } from "../../constants";

const h = vi.hoisted(() => ({
  setActiveVisualization: vi.fn(),
  setCanonizerFinish: vi.fn(),
  setPlayMode: vi.fn(),
  loadAutocanonizerMix: vi.fn(),
  disableAutocanonizerMix: vi.fn(),
  setAutocanonizerMixAlignment: vi.fn(),
  setAutocanonizerQuadMode: vi.fn(),
  setAutocanonizerQuadBranchMode: vi.fn(),
  swapAutocanonizerMixSongs: vi.fn(),
  trackEvent: vi.fn(),
  getCount: vi.fn(() => 6),
}));

vi.mock("../../playback-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playback-ui")>()),
  setActiveVisualization: h.setActiveVisualization,
  setCanonizerFinish: h.setCanonizerFinish,
  setPlayMode: h.setPlayMode,
}));
vi.mock("../../playback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playback")>()),
  loadAutocanonizerMix: h.loadAutocanonizerMix,
  disableAutocanonizerMix: h.disableAutocanonizerMix,
  setAutocanonizerMixAlignment: h.setAutocanonizerMixAlignment,
  setAutocanonizerQuadMode: h.setAutocanonizerQuadMode,
  setAutocanonizerQuadBranchMode: h.setAutocanonizerQuadBranchMode,
  swapAutocanonizerMixSongs: h.swapAutocanonizerMixSongs,
}));
vi.mock("../../analytics", () => ({
  trackEvent: h.trackEvent,
}));
vi.mock("../../runtime", () => ({
  getAppContext: vi.fn(() => ({ jukebox: { getCount: h.getCount } })),
}));

describe("VizTop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getCount.mockReturnValue(6);
    act(() => {
      useAppStore.setState({
        activeTabId: "play",
        playMode: "jukebox",
        activeVizIndex: 1,
        audioLoaded: true,
        analysisLoaded: true,
        audioModePreparing: false,
        multiTrackEnabled: false,
        autocanonizerMixEnabled: false,
        autocanonizerMixAlignment: "cover-sync",
        autocanonizerQuadMode: false,
        autocanonizerQuadBranchMode: "synced",
        playlistAddSticky: false,
        playlist: { tracks: [], currentIndex: -1 },
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("reports the visualization label, not the index, on switch", async () => {
    render(<VizTop />);
    await userEvent.selectOptions(document.getElementById("viz-select")!, "2");

    expect(h.trackEvent).toHaveBeenCalledWith("select_viz", { viz: "Galaxy" });
    expect(h.setActiveVisualization).toHaveBeenCalledWith(2);
  });

  it("falls back to the index for visualizations beyond the label list", async () => {
    const beyondIndex = VISUALIZATION_LABELS.length;
    h.getCount.mockReturnValue(beyondIndex + 1);
    render(<VizTop />);
    await userEvent.selectOptions(
      document.getElementById("viz-select")!,
      String(beyondIndex),
    );

    expect(h.trackEvent).toHaveBeenCalledWith("select_viz", {
      viz: String(beyondIndex),
    });
  });

  it("does not report while the selector is disabled", async () => {
    act(() => {
      useAppStore.setState({ audioLoaded: false });
    });
    render(<VizTop />);
    const select = document.getElementById("viz-select") as HTMLSelectElement;

    expect(select.disabled).toBe(true);
    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it("sends the user to the tracks list with sticky add mode when Mix Songs is clicked with 1 track", async () => {
    render(<VizTop />);
    const mixBtn = document.getElementById("multi-track-mix-toggle");
    expect(mixBtn).not.toBeNull();

    await userEvent.click(mixBtn!);

    expect(useAppStore.getState().playlistAddSticky).toBe(true);
    expect(useAppStore.getState().activeTabId).toBe("top");
  });

  it("shows Mix 2 Songs in autocanonizer mode and switches alignment modes when active", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        playlist: {
          tracks: [
            { id: "a", sourceType: "youtube", title: "A", artist: "", duration: null },
            { id: "b", sourceType: "youtube", title: "B", artist: "", duration: null },
          ],
          currentIndex: 0,
        },
      });
    });
    render(<VizTop />);
    const mixBtn = document.getElementById("multi-track-mix-toggle")!;
    expect(mixBtn.textContent).toBe("Mix 2 Songs");
    expect(document.getElementById("canonizer-mix-swap")).toBeNull();

    await userEvent.click(mixBtn);
    expect(h.loadAutocanonizerMix).toHaveBeenCalled();

    act(() => {
      useAppStore.setState({ autocanonizerMixEnabled: true });
    });
    expect(mixBtn.textContent).toBe("Unmix Songs");

    const alignmentGroup = document.getElementById("canonizer-mix-alignment-group")!;
    const coverBtn = document.getElementById("canonizer-alignment-cover-sync")!;
    const foldBtn = document.getElementById("canonizer-alignment-section-fold")!;
    const swapBtn = document.getElementById("canonizer-mix-swap")!;
    expect(
      swapBtn.compareDocumentPosition(alignmentGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(coverBtn.getAttribute("aria-pressed")).toBe("true");
    expect(coverBtn.classList.contains("is-active")).toBe(true);
    expect(coverBtn.getAttribute("title")).toBeTruthy();
    expect(foldBtn.getAttribute("aria-pressed")).toBe("false");
    expect(foldBtn.classList.contains("is-active")).toBe(false);
    expect(foldBtn.getAttribute("title")).toBeTruthy();
    expect(swapBtn.textContent).toBe("Flip Songs");
    expect(swapBtn.getAttribute("title")).toBeTruthy();

    await userEvent.click(foldBtn);
    expect(h.setAutocanonizerMixAlignment).toHaveBeenCalledWith(
      expect.anything(),
      "section-fold",
    );

    await userEvent.click(swapBtn);
    expect(h.swapAutocanonizerMixSongs).toHaveBeenCalledWith(expect.anything());

    await userEvent.click(mixBtn);
    expect(h.disableAutocanonizerMix).toHaveBeenCalled();
  });

  it("toggles 4-Voice quad mode and switches between Synced and Independent branching", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: true,
        autocanonizerQuadMode: false,
        autocanonizerQuadBranchMode: "synced",
      });
    });
    render(<VizTop />);
    const quadToggle = document.getElementById("canonizer-quad-toggle")!;
    expect(quadToggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.getElementById("canonizer-mix-alignment-group")).not.toBeNull();
    expect(document.getElementById("canonizer-quad-branch-group")).toBeNull();

    await userEvent.click(quadToggle);
    expect(h.setAutocanonizerQuadMode).toHaveBeenCalledWith(expect.anything(), true);

    act(() => {
      useAppStore.setState({ autocanonizerQuadMode: true });
    });
    expect(quadToggle.classList.contains("is-active")).toBe(true);
    expect(document.getElementById("canonizer-mix-alignment-group")).toBeNull();
    const syncedBtn = document.getElementById("canonizer-quad-branch-synced")!;
    const indepBtn = document.getElementById("canonizer-quad-branch-independent")!;
    expect(syncedBtn.classList.contains("is-active")).toBe(true);
    expect(indepBtn.classList.contains("is-active")).toBe(false);

    await userEvent.click(indepBtn);
    expect(h.setAutocanonizerQuadBranchMode).toHaveBeenCalledWith(
      expect.anything(),
      "independent",
    );
  });

  it("exposes Song Sync mode in the mode selector and renders its loop toggle", async () => {
    act(() => {
      useAppStore.setState({ playMode: "songsync" });
    });
    render(<VizTop />);
    const songsyncOption = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#play-mode-select option"),
    ).find((opt) => opt.value === "songsync");
    expect(songsyncOption).toBeDefined();
    expect(document.getElementById("songsync-loop")).not.toBeNull();
    expect(document.getElementById("multi-track-mix-toggle")).toBeNull();
  });

  it("shows Karaoke and Lyrics toggles in single-track jukebox mode when allow_lyrics is enabled", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "jukebox",
        multiTrackEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        appConfig: {
          allow_user_upload: false,
          allow_user_url: false,
          allow_lyrics: true,
        },
        lyricsKaraokeEnabled: false,
        lyricsPanelOpen: false,
      });
    });

    render(<VizTop />);
    const karaokeBtn = document.getElementById("lyrics-karaoke-toggle")!;
    const panelBtn = document.getElementById("lyrics-panel-toggle")!;
    expect(karaokeBtn).not.toBeNull();
    expect(panelBtn).not.toBeNull();
    expect(karaokeBtn.getAttribute("aria-pressed")).toBe("false");
    expect(panelBtn.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(karaokeBtn);
    await userEvent.click(panelBtn);
    expect(useAppStore.getState().lyricsKaraokeEnabled).toBe(true);
    expect(useAppStore.getState().lyricsPanelOpen).toBe(true);
  });

  it("shows Karaoke and Lyrics toggles in single-song autocanonizer mode but hides them in 2-song mix", () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: false,
        audioLoaded: true,
        analysisLoaded: true,
        appConfig: {
          allow_user_upload: false,
          allow_user_url: false,
          allow_lyrics: true,
        },
      });
    });

    render(<VizTop />);
    expect(document.getElementById("lyrics-karaoke-toggle")).not.toBeNull();
    expect(document.getElementById("lyrics-panel-toggle")).not.toBeNull();

    act(() => {
      useAppStore.setState({ autocanonizerMixEnabled: true });
    });
    expect(document.getElementById("lyrics-karaoke-toggle")).toBeNull();
    expect(document.getElementById("lyrics-panel-toggle")).toBeNull();
  });
});
