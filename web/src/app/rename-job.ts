import { getAdminKey } from "./admin";
import { renameTrack } from "./api";
import { findCurrentFavorite } from "./favorites";
import { updateFavorites } from "./favorites-actions";
import i18n from "./i18n";
import { savePlaylist } from "./playlist";
import { useAppStore } from "./store";
import { showToast } from "./ui";

export type PendingRename = {
  jobId: string;
  trackId: string | null;
  title: string;
  artist: string;
  adminKey: string | null;
};

/**
 * Captures the active job identity, metadata, and admin key before opening the rename modal.
 */
export function getPendingRename(): PendingRename | null {
  const state = useAppStore.getState();
  const jobId = state.lastJobId;
  if (!jobId) {
    return null;
  }
  return {
    jobId,
    trackId: state.lastTrackId,
    title: state.trackTitle ?? "",
    artist: state.trackArtist ?? "",
    adminKey: getAdminKey(),
  };
}

/**
 * Renames a track on the backend and syncs the updated title/artist across local store,
 * favorites, cached track lists, and saved playlist entries.
 */
export async function performRename(
  pending: PendingRename,
  next: { title: string; artist: string },
): Promise<boolean> {
  const title = next.title.trim();
  const artist = next.artist.trim();
  if (!title || !pending.adminKey) {
    showToast(i18n.t("rename.failed"), { tone: "error" });
    return false;
  }
  try {
    const updated = await renameTrack(
      pending.jobId,
      { title, artist },
      pending.adminKey,
    );
    const state = useAppStore.getState();
    // Only update live playback metadata if the user is still viewing the renamed job.
    if (state.lastJobId === pending.jobId) {
      useAppStore.setState({
        trackTitle: updated.title,
        trackArtist: updated.artist,
      });
    }
    state.resetTopSongsCache();

    const currentFavorite =
      state.lastJobId === pending.jobId
        ? findCurrentFavorite(state.favorites, {
            lastTrackId: state.lastTrackId,
            lastJobId: state.lastJobId,
            lastSourceId: state.lastSourceId,
            lastSourceProvider: state.lastSourceProvider,
          })
        : null;
    let favoritesChanged = false;
    const nextFavorites = state.favorites.map((item) => {
      const matchesPending =
        item.uniqueSongId === pending.jobId ||
        (pending.trackId !== null && item.uniqueSongId === pending.trackId) ||
        currentFavorite?.uniqueSongId === item.uniqueSongId;
      if (!matchesPending) {
        return item;
      }
      if (item.title === updated.title && item.artist === updated.artist) {
        return item;
      }
      favoritesChanged = true;
      return {
        ...item,
        title: updated.title,
        artist: updated.artist,
      };
    });
    if (favoritesChanged) {
      updateFavorites(nextFavorites);
    }

    let playlistChanged = false;
    const nextTracks = state.playlist.tracks.map((track) => {
      const matchesPending =
        track.id === pending.jobId ||
        (pending.trackId !== null && track.id === pending.trackId);
      if (!matchesPending) {
        return track;
      }
      if (track.title === updated.title && track.artist === updated.artist) {
        return track;
      }
      playlistChanged = true;
      return {
        ...track,
        title: updated.title,
        artist: updated.artist,
      };
    });
    if (playlistChanged) {
      const nextPlaylist = { ...state.playlist, tracks: nextTracks };
      useAppStore.setState({ playlist: nextPlaylist });
      savePlaylist(nextPlaylist);
    }

    showToast(i18n.t("rename.renamed"), { icon: "edit" });
    return true;
  } catch {
    showToast(i18n.t("rename.failed"), { tone: "error" });
    return false;
  }
}
