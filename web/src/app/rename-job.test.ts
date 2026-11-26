import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_KEY_STORAGE_KEY } from "./admin";
import { renameTrack } from "./api";
import { updateFavorites } from "./favorites-actions";
import type { FavoriteTrack } from "./favorites";
import { savePlaylist, type PlaylistState } from "./playlist";
import { getPendingRename, performRename } from "./rename-job";
import { useAppStore } from "./store";
import { showToast } from "./ui";

vi.mock("./api", () => ({ renameTrack: vi.fn() }));
vi.mock("./favorites-actions", () => ({ updateFavorites: vi.fn() }));
vi.mock("./playlist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./playlist")>()),
  savePlaylist: vi.fn(),
}));
vi.mock("./ui", () => ({ showToast: vi.fn() }));

const initialStoreState = useAppStore.getState();

function installLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  } as Storage;
}

function createFavorite(overrides?: Partial<FavoriteTrack>): FavoriteTrack {
  return {
    uniqueSongId: "track1",
    title: "Old Title",
    artist: "Old Artist",
    duration: 180,
    sourceType: "youtube",
    ...overrides,
  };
}

function createPlaylist(): PlaylistState {
  return {
    tracks: [
      {
        id: "track1",
        sourceType: "youtube",
        title: "Old Title",
        artist: "Old Artist",
        duration: 180,
      },
      {
        id: "other",
        sourceType: "youtube",
        title: "Other Song",
        artist: "Other Artist",
        duration: 200,
      },
    ],
    currentIndex: 0,
  };
}

describe("rename-job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installLocalStorage();
    useAppStore.setState(initialStoreState, true);
  });

  it("returns null from getPendingRename when no job is loaded", () => {
    expect(getPendingRename()).toBeNull();
  });

  it("captures live metadata and admin key in getPendingRename", () => {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    useAppStore.setState({
      lastJobId: "job1",
      lastTrackId: "track1",
      trackTitle: "Current Title",
      trackArtist: "Current Artist",
    });

    expect(getPendingRename()).toEqual({
      jobId: "job1",
      trackId: "track1",
      title: "Current Title",
      artist: "Current Artist",
      adminKey: "secret",
    });
  });

  it("renames the job and syncs store, top tracks cache, favorites, playlist, and toast", async () => {
    const resetTopSongsCache = vi.fn();
    vi.mocked(renameTrack).mockResolvedValueOnce({
      id: "job1",
      title: "Localized Title",
      artist: "Localized Artist",
    });
    useAppStore.setState({
      lastJobId: "job1",
      lastTrackId: "track1",
      trackTitle: "Old Title",
      trackArtist: "Old Artist",
      favorites: [
        createFavorite(),
        createFavorite({ uniqueSongId: "other", title: "Keep Me", artist: "Artist" }),
      ],
      playlist: createPlaylist(),
      resetTopSongsCache,
    });

    const ok = await performRename(
      {
        jobId: "job1",
        trackId: "track1",
        title: "Old Title",
        artist: "Old Artist",
        adminKey: "secret",
      },
      { title: "  Localized Title  ", artist: "  Localized Artist  " },
    );

    expect(ok).toBe(true);
    expect(renameTrack).toHaveBeenCalledWith(
      "job1",
      { title: "Localized Title", artist: "Localized Artist" },
      "secret",
    );
    expect(useAppStore.getState().trackTitle).toBe("Localized Title");
    expect(useAppStore.getState().trackArtist).toBe("Localized Artist");
    expect(resetTopSongsCache).toHaveBeenCalledTimes(1);
    expect(updateFavorites).toHaveBeenCalledWith([
      createFavorite({ title: "Localized Title", artist: "Localized Artist" }),
      createFavorite({ uniqueSongId: "other", title: "Keep Me", artist: "Artist" }),
    ]);
    const expectedPlaylist: PlaylistState = {
      tracks: [
        {
          id: "track1",
          sourceType: "youtube",
          title: "Localized Title",
          artist: "Localized Artist",
          duration: 180,
        },
        {
          id: "other",
          sourceType: "youtube",
          title: "Other Song",
          artist: "Other Artist",
          duration: 200,
        },
      ],
      currentIndex: 0,
    };
    expect(useAppStore.getState().playlist).toEqual(expectedPlaylist);
    expect(savePlaylist).toHaveBeenCalledWith(expectedPlaylist);
    expect(showToast).toHaveBeenCalledWith("Track renamed", { icon: "edit" });
  });

  it("does not overwrite live trackTitle/trackArtist if another job became active", async () => {
    vi.mocked(renameTrack).mockResolvedValueOnce({
      id: "job1",
      title: "Renamed Old",
      artist: "Renamed Artist",
    });
    useAppStore.setState({
      lastJobId: "job2",
      lastTrackId: "track2",
      trackTitle: "Different Song",
      trackArtist: "Different Artist",
    });

    const ok = await performRename(
      {
        jobId: "job1",
        trackId: "track1",
        title: "Old",
        artist: "Old",
        adminKey: "secret",
      },
      { title: "Renamed Old", artist: "Renamed Artist" },
    );

    expect(ok).toBe(true);
    expect(useAppStore.getState().trackTitle).toBe("Different Song");
    expect(useAppStore.getState().trackArtist).toBe("Different Artist");
  });

  it("shows an error toast and returns false on blank title, missing admin key, or API error", async () => {
    expect(
      await performRename(
        {
          jobId: "job1",
          trackId: "track1",
          title: "Old",
          artist: "Old",
          adminKey: "secret",
        },
        { title: "   ", artist: "Artist" },
      ),
    ).toBe(false);
    expect(renameTrack).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenLastCalledWith("Unable to rename track", {
      tone: "error",
    });

    expect(
      await performRename(
        {
          jobId: "job1",
          trackId: "track1",
          title: "Old",
          artist: "Old",
          adminKey: null,
        },
        { title: "New", artist: "Artist" },
      ),
    ).toBe(false);
    expect(renameTrack).not.toHaveBeenCalled();

    vi.mocked(renameTrack).mockRejectedValueOnce(new Error("Forbidden"));
    expect(
      await performRename(
        {
          jobId: "job1",
          trackId: "track1",
          title: "Old",
          artist: "Old",
          adminKey: "secret",
        },
        { title: "New", artist: "Artist" },
      ),
    ).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith("Unable to rename track", {
      tone: "error",
    });
  });
});
