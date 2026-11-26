import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_KEY_STORAGE_KEY } from "../admin";
import { dismissTrackReport, fetchReportedTracks, fetchTopSongs } from "../api";
import { useAppStore } from "../store";
import { TopTracksPanel } from "./TopTracksPanel";

vi.mock("../api", () => ({
  fetchTopSongs: vi.fn(async () => [
    {
      id: "a3f3c0dc73c6476c9db95c227f9206f2",
      source_id: "abc123def45",
      source_provider: "youtube",
      title: "Song",
      artist: "Artist",
    },
  ]),
  fetchTrendingSongs: vi.fn(async () => []),
  fetchRecentSongs: vi.fn(async () => {
    throw new Error("boom");
  }),
  fetchReportedTracks: vi.fn(async () => [
    {
      id: "b4f3c0dc73c6476c9db95c227f9206f3",
      title: "Bad Song",
      artist: "Artist",
      source_provider: "youtube",
      reason: "bad_audio",
      reported_at: "2026-09-01T12:00:00.000000+00:00",
    },
  ]),
  dismissTrackReport: vi.fn(async () => {}),
}));

const h = vi.hoisted(() => ({
  selectTrack: vi.fn(),
  addToPlaylist: vi.fn(),
  selectFavorite: vi.fn(),
  removeFavoriteWithToast: vi.fn(),
  refreshFavoritesFromSync: vi.fn(async () => {}),
  enterSyncCode: vi.fn(async () => "replaced" as const),
  createSyncCode: vi.fn(async () => "alpha-bravo-charlie"),
}));

vi.mock("../track-select", () => ({ selectTrack: h.selectTrack }));
vi.mock("../playlist-actions", () => ({ addToPlaylist: h.addToPlaylist }));
vi.mock("../favorites-actions", () => ({
  selectFavorite: h.selectFavorite,
  removeFavoriteWithToast: h.removeFavoriteWithToast,
  refreshFavoritesFromSync: h.refreshFavoritesFromSync,
  enterSyncCode: h.enterSyncCode,
  createSyncCode: h.createSyncCode,
}));

describe("TopTracksPanel", () => {
  beforeEach(() => {
    localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    act(() => {
      useAppStore.setState({
        activeTabId: "top",
        topSongsTab: "top",
        favorites: [],
        favoritesSyncCode: null,
        favoritesSort: { key: "title", direction: "asc" },
        appConfig: null,
      });
      useAppStore.getState().resetTopSongsCache();
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides the reported subtab without an admin key", () => {
    render(<TopTracksPanel />);
    expect(document.querySelector('[data-top-subtab="reported"]')).toBeNull();
    expect(document.getElementById("reported-songs")).toBeNull();
  });

  it("lists reported tracks for admins and dismisses a report", async () => {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    const user = userEvent.setup();
    render(<TopTracksPanel />);
    expect(fetchReportedTracks).not.toHaveBeenCalled();

    await user.click(
      document.querySelector<HTMLElement>('[data-top-subtab="reported"]')!,
    );
    const link = await screen.findByText("Bad Song");
    expect(fetchReportedTracks).toHaveBeenCalledWith("secret");
    const item = link.closest("tr")!;
    expect(item.querySelector(".track-rank-cell")?.textContent).toBe("1");
    expect(item.querySelector(".track-artist-cell")?.textContent).toBe("Artist");
    expect(item.textContent).toContain(
      "Bad audio (poor quality, cut off, or incomplete)",
    );
    expect(item.textContent).toContain(
      new Date("2026-09-01T12:00:00.000000+00:00").toLocaleDateString(),
    );
    expect(item.querySelector(".playlist-add-button")).toBeNull();

    await user.click(link);
    expect(h.selectTrack).toHaveBeenCalledWith(
      "b4f3c0dc73c6476c9db95c227f9206f3",
      expect.objectContaining({ title: "Bad Song" }),
    );

    await user.click(item.querySelector<HTMLElement>(".reported-dismiss")!);
    expect(h.selectTrack).toHaveBeenCalledTimes(1);
    expect(dismissTrackReport).toHaveBeenCalledWith(
      "b4f3c0dc73c6476c9db95c227f9206f3",
      "secret",
    );
    await waitFor(() => {
      expect(screen.queryByText("Bad Song")).toBeNull();
    });
    expect(document.getElementById("reported-songs")?.textContent).toBe(
      "No reported tracks.",
    );
  });

  it("loads the top list lazily and renders job-id links", async () => {
    render(<TopTracksPanel />);
    const link = await screen.findByText("Song");
    const row = link.closest("tr")!;
    expect(row.querySelector(".track-rank-cell")?.textContent).toBe("1");
    expect(row.querySelector(".track-artist-cell")?.textContent).toBe("Artist");
    expect(link.getAttribute("href")).toBe(
      "/listen/a3f3c0dc73c6476c9db95c227f9206f2",
    );
    await userEvent.click(link);
    expect(h.selectTrack).toHaveBeenCalledWith(
      "a3f3c0dc73c6476c9db95c227f9206f2",
      expect.objectContaining({
        id: "a3f3c0dc73c6476c9db95c227f9206f2",
        sourceType: "youtube",
        title: "Song",
      }),
    );
  });

  it("adds rows to the playlist", async () => {
    render(<TopTracksPanel />);
    await screen.findByText("Song");
    await userEvent.click(screen.getByLabelText("Add Song to playlist"));
    expect(h.addToPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a3f3c0dc73c6476c9db95c227f9206f2" }),
      "top",
    );
    expect(h.selectTrack).not.toHaveBeenCalled();
  });

  it("updates the title and refresh control per subtab", async () => {
    render(<TopTracksPanel />);
    const title = document.getElementById("top-list-title");
    const refresh = document.getElementById("top-list-refresh");
    expect(title?.textContent).toBe("Top 25");
    expect(refresh?.getAttribute("aria-label")).toBe("Refresh Top 25");
    act(() => {
      useAppStore.setState({ topSongsTab: "recent" });
    });
    expect(title?.textContent).toBe("Last 25 Played");
    expect(refresh?.getAttribute("aria-label")).toBe("Refresh Last 25 Played");
    expect(refresh?.classList.contains("hidden")).toBe(false);
    act(() => {
      useAppStore.setState({ topSongsTab: "favorites" });
    });
    // The favorites title carries a count badge ("<count> / <max>") next to
    // the label, so assert the label and the badge separately.
    expect(title?.textContent).toContain("Favorites");
    expect(title?.querySelector(".favorites-count")?.textContent).toBe(
      "0 / 150",
    );
    expect(refresh?.classList.contains("hidden")).toBe(true);
  });

  it("shows an error message when a list fails to load", async () => {
    render(<TopTracksPanel />);
    act(() => {
      useAppStore.setState({ topSongsTab: "recent" });
    });
    await waitFor(() => {
      expect(
        document.getElementById("recent-songs")?.textContent,
      ).toContain("Recent plays unavailable:");
    });
  });

  it("refreshes the active list on demand", async () => {
    const api = await import("../api");
    render(<TopTracksPanel />);
    await screen.findByText("Song");
    expect(api.fetchTopSongs).toHaveBeenCalledTimes(1);
    await userEvent.click(document.getElementById("top-list-refresh")!);
    await waitFor(() => {
      expect(api.fetchTopSongs).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps loaded list data across unmount and remount", async () => {
    const api = await import("../api");
    const { unmount } = render(<TopTracksPanel />);
    await screen.findByText("Song");
    unmount();

    render(<TopTracksPanel />);
    expect(screen.getByText("Song")).toBeTruthy();
    expect(api.fetchTopSongs).toHaveBeenCalledTimes(1);
  });

  it("renders, filters, sorts and removes favorites", async () => {
    act(() => {
      useAppStore.setState({
        topSongsTab: "favorites",
        favorites: [
          {
            uniqueSongId: "fav1",
            title: "Alpha",
            artist: "Zed",
            duration: null,
            sourceType: "youtube",
          },
          {
            uniqueSongId: "fav2",
            title: "Beta",
            artist: "Ann",
            duration: null,
            sourceType: "youtube",
            tuningParams: "jb=1",
          },
        ],
      });
    });
    render(<TopTracksPanel />);
    const rows = () =>
      Array.from(document.querySelectorAll(".favorite-row")).map(
        (row) => row.querySelector("a")?.textContent?.trim(),
      );
    expect(rows()).toEqual(["Alpha", "Beta tune"]);

    // sort by title desc
    await userEvent.click(screen.getByText("Title"));
    expect(rows()).toEqual(["Beta tune", "Alpha"]);

    // filter
    await userEvent.type(
      screen.getByLabelText("Search favorites"),
      "alpha",
    );
    expect(rows()).toEqual(["Alpha"]);
    await userEvent.clear(screen.getByLabelText("Search favorites"));

    // select a row
    await userEvent.click(screen.getByText("Alpha"));
    expect(h.selectFavorite).toHaveBeenCalledWith(
      "fav1",
      "youtube",
    );

    // remove
    await userEvent.click(
      screen.getByLabelText("Remove Alpha from Favorites"),
    );
    expect(h.removeFavoriteWithToast).toHaveBeenCalledWith("fav1");
  });

  it("keeps the favorites sort across unmount and remount", async () => {
    act(() => {
      useAppStore.setState({
        topSongsTab: "favorites",
        favorites: [
          {
            uniqueSongId: "fav1",
            title: "Alpha",
            artist: "Zed",
            duration: null,
            sourceType: "youtube",
          },
          {
            uniqueSongId: "fav2",
            title: "Beta",
            artist: "Ann",
            duration: null,
            sourceType: "youtube",
          },
        ],
      });
    });
    const rows = () =>
      Array.from(document.querySelectorAll(".favorite-row")).map(
        (row) => row.querySelector("a")?.textContent?.trim(),
      );
    const { unmount } = render(<TopTracksPanel />);
    await userEvent.click(screen.getByText("Artist"));
    expect(rows()).toEqual(["Beta", "Alpha"]);
    unmount();

    render(<TopTracksPanel />);
    expect(rows()).toEqual(["Beta", "Alpha"]);
  });

  it("shows sync controls only on favorites with sync allowed", async () => {
    act(() => {
      useAppStore.setState({
        topSongsTab: "favorites",
        appConfig: { allow_favorites_sync: true } as never,
        favoritesSyncCode: null,
      });
    });
    render(<TopTracksPanel />);
    const syncButton = document.getElementById("favorites-sync-button")!;
    expect(syncButton.classList.contains("hidden")).toBe(false);
    expect(syncButton.querySelector(".favorites-sync-icon")?.textContent).toBe(
      "cloud_off",
    );

    await userEvent.click(syncButton);
    const menu = document.getElementById("favorites-sync-menu")!;
    expect(menu.classList.contains("hidden")).toBe(false);
    // no code yet: refresh hidden, create labelled "Create sync code"
    expect(
      menu
        .querySelector('[data-favorites-sync="refresh"]')
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(
      menu.querySelector('[data-favorites-sync="create"]')?.textContent,
    ).toBe("Create sync code");

    // open the create modal and create a code
    await userEvent.click(menu.querySelector('[data-favorites-sync="create"]')!);
    const createModal = document.getElementById("favorites-sync-create-modal")!;
    expect(createModal.classList.contains("open")).toBe(true);
    await userEvent.click(
      document.getElementById("favorites-sync-create-button")!,
    );
    await waitFor(() => {
      expect(
        document.getElementById("favorites-sync-create-output")?.textContent,
      ).toBe("alpha-bravo-charlie");
    });
  });

  it("submits a sync code through the enter modal", async () => {
    act(() => {
      useAppStore.setState({
        topSongsTab: "favorites",
        appConfig: { allow_favorites_sync: true } as never,
        favoritesSyncCode: "old-code-here",
      });
    });
    render(<TopTracksPanel />);
    await userEvent.click(document.getElementById("favorites-sync-button")!);
    await userEvent.click(
      document.querySelector('[data-favorites-sync="enter"]')!,
    );
    const enterModal = document.getElementById("favorites-sync-enter-modal")!;
    expect(enterModal.classList.contains("open")).toBe(true);
    await userEvent.type(
      document.getElementById("favorites-sync-enter-input")!,
      "alpha-bravo-charlie",
    );
    await userEvent.click(
      document.getElementById("favorites-sync-enter-button")!,
    );
    await waitFor(() => {
      expect(h.enterSyncCode).toHaveBeenCalledWith(
        "alpha-bravo-charlie",
      );
      expect(enterModal.classList.contains("open")).toBe(false);
    });
  });

  it("filters tracks on the search subtab with playlist add buttons", async () => {
    render(<TopTracksPanel />);
    await userEvent.click(
      document.querySelector<HTMLElement>('[data-top-subtab="search"]')!,
    );
    const input = document.getElementById("track-search-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const list = document.getElementById("search-tracks-songs")!;
    await within(list).findByText("Song");
    expect(list.querySelector(".track-artist-cell")?.textContent).toBe("Artist");
    expect(within(list).getByLabelText("Add Song to playlist")).toBeTruthy();

    await userEvent.type(input, "nomatch");
    expect(within(list).queryByText("Song")).toBeNull();

    await userEvent.clear(input);
    await within(list).findByText("Song");
  });

  it("sorts normal track lists by Title and Artist while keeping rank numbers and resetting on #", async () => {
    vi.mocked(fetchTopSongs).mockResolvedValueOnce([
      {
        id: "id-1",
        source_provider: "youtube",
        title: "Zebra",
        artist: "Miles",
        play_count: 10,
      },
      {
        id: "id-2",
        source_provider: "youtube",
        title: "Alpha",
        artist: "Zed",
        play_count: 5,
      },
      {
        id: "id-3",
        source_provider: "youtube",
        title: "Beta",
        artist: "Unknown",
        play_count: 1,
      },
    ]);

    const user = userEvent.setup();
    render(<TopTracksPanel />);
    await screen.findByText("Zebra");
    const container = document.getElementById("top-songs")!;

    const rowSummary = () =>
      Array.from(container.querySelectorAll("tbody tr")).map((row) => [
        row.querySelector(".track-rank-cell")?.textContent?.trim(),
        row.querySelector(".track-title-cell a")?.textContent?.trim(),
        row.querySelector(".track-artist-cell")?.textContent?.trim(),
      ]);

    expect(rowSummary()).toEqual([
      ["1", "Zebra", "Miles"],
      ["2", "Alpha", "Zed"],
      ["3", "Beta", ""],
    ]);

    // Title asc then desc keeps original 1-based rank.
    await user.click(container.querySelector('[data-track-sort="title"]')!);
    expect(rowSummary()).toEqual([
      ["2", "Alpha", "Zed"],
      ["3", "Beta", ""],
      ["1", "Zebra", "Miles"],
    ]);

    await user.click(container.querySelector('[data-track-sort="title"]')!);
    expect(rowSummary()).toEqual([
      ["1", "Zebra", "Miles"],
      ["3", "Beta", ""],
      ["2", "Alpha", "Zed"],
    ]);

    // Artist asc then desc.
    await user.click(container.querySelector('[data-track-sort="artist"]')!);
    expect(rowSummary()).toEqual([
      ["3", "Beta", ""],
      ["1", "Zebra", "Miles"],
      ["2", "Alpha", "Zed"],
    ]);

    // Clicking "#" resets to default rank order and repeated clicks never reverse it.
    await user.click(container.querySelector('[data-track-sort="default"]')!);
    expect(rowSummary()).toEqual([
      ["1", "Zebra", "Miles"],
      ["2", "Alpha", "Zed"],
      ["3", "Beta", ""],
    ]);
    await user.click(container.querySelector('[data-track-sort="default"]')!);
    expect(rowSummary()).toEqual([
      ["1", "Zebra", "Miles"],
      ["2", "Alpha", "Zed"],
      ["3", "Beta", ""],
    ]);

    // Clicking the Artist cell selects the row.
    await user.click(
      container.querySelectorAll<HTMLElement>(".track-artist-cell")[0],
    );
    expect(h.selectTrack).toHaveBeenCalledWith(
      "id-1",
      expect.objectContaining({ id: "id-1", title: "Zebra", artist: "Miles" }),
    );
  });

  it("renders Plays column on All tab and resets column sort when dropdown changes", async () => {
    vi.mocked(fetchTopSongs)
      .mockResolvedValueOnce([
        {
          id: "id-1",
          source_provider: "youtube",
          title: "Song",
          artist: "Artist",
          play_count: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "all-1",
          source_provider: "youtube",
          title: "Zebra",
          artist: "Miles",
          play_count: 42,
        },
        {
          id: "all-2",
          source_provider: "youtube",
          title: "Alpha",
          artist: "Ann",
          play_count: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "all-2",
          source_provider: "youtube",
          title: "Alpha",
          artist: "Ann",
          play_count: 1,
        },
        {
          id: "all-1",
          source_provider: "youtube",
          title: "Zebra",
          artist: "Miles",
          play_count: 42,
        },
      ]);

    const user = userEvent.setup();
    render(<TopTracksPanel />);
    await user.click(
      document.querySelector<HTMLElement>('[data-top-subtab="all-time"]')!,
    );

    await screen.findByText("Zebra");
    const allContainer = document.getElementById("all-time-songs")!;
    expect(within(allContainer).getByText("Plays")).toBeTruthy();
    expect(within(allContainer).getByText("42 plays")).toBeTruthy();
    expect(within(allContainer).getByText("1 play")).toBeTruthy();

    await user.click(allContainer.querySelector('[data-track-sort="title"]')!);
    expect(
      allContainer
        .querySelector('[data-track-sort="title"]')
        ?.closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");

    await user.selectOptions(
      document.getElementById("all-time-sort")!,
      "newest",
    );
    await waitFor(() => {
      expect(
        document
          .getElementById("all-time-songs")
          ?.querySelector('[data-track-sort="default"]')
          ?.closest("th")
          ?.getAttribute("aria-sort"),
      ).toBe("ascending");
    });
  });
});
