import React from "react";
import {
  appendMixQueueTrack,
  createLocalMixTrackFromFile,
  fileTrackKey,
  moveMixQueueTrack,
  removeMixQueueTrack,
  type LocalMixTrack,
} from "./mixQueue";

type FileEntry = {
  file: File;
  handle: FileSystemFileHandle | null;
  meta?: {
    title?: string | null;
    artist?: string | null;
    durationSeconds?: number | null;
    fingerprint?: string | null;
  };
};

type AppState = {
  file: File | null;
  // Handle the file was opened through, when the browser provides one.
  fileHandle: FileSystemFileHandle | null;
  setFile: (file: File | null, handle?: FileSystemFileHandle | null) => void;
  isListenLoading: boolean;
  setIsListenLoading: (isLoading: boolean) => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (isOpen: boolean) => void;
  mixQueue: LocalMixTrack[];
  activeQueueIndex: number;
  mixAddSticky: boolean;
  setMixAddSticky: (sticky: boolean) => void;
  addToMixQueue: (track: LocalMixTrack) => { added: boolean; index: number };
  addFilesToMixQueue: (entries: FileEntry[], options?: { activateFirst?: boolean }) => void;
  removeFromMixQueue: (index: number) => void;
  moveMixQueueItem: (fromIndex: number, toIndex: number) => void;
  clearMixQueue: () => void;
  selectMixQueueIndex: (index: number) => void;
  updateMixQueueTrackMeta: (
    file: File,
    meta: {
      fingerprint?: string | null;
      title?: string | null;
      artist?: string | null;
      durationSeconds?: number | null;
    },
  ) => void;
};

const AppStateContext = React.createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = React.useState<{
    file: File | null;
    handle: FileSystemFileHandle | null;
  }>({ file: null, handle: null });
  const [queueState, setQueueState] = React.useState<{
    tracks: LocalMixTrack[];
    activeIndex: number;
  }>({ tracks: [], activeIndex: -1 });
  const [mixAddSticky, setMixAddSticky] = React.useState(false);

  const setFile = React.useCallback(
    (file: File | null, handle: FileSystemFileHandle | null = null) => {
      setSelection({ file, handle });
      if (!file) {
        return;
      }
      const key = fileTrackKey(file);
      setQueueState((prev) => {
        const existingIndex = prev.tracks.findIndex(
          (track) =>
            track.id === key ||
            (track.file !== null && fileTrackKey(track.file) === key),
        );
        if (existingIndex >= 0) {
          const next = prev.tracks.slice();
          next[existingIndex] = {
            ...next[existingIndex],
            file,
            fileHandle: handle ?? next[existingIndex].fileHandle,
          };
          return { tracks: next, activeIndex: existingIndex };
        }
        const entry = createLocalMixTrackFromFile(file, handle);
        if (prev.tracks.length <= 1) {
          return { tracks: [entry], activeIndex: 0 };
        }
        return {
          tracks: [...prev.tracks, entry],
          activeIndex: prev.tracks.length,
        };
      });
    },
    [],
  );

  const addToMixQueue = React.useCallback((track: LocalMixTrack) => {
    let outcome = { added: false, index: 0 };
    setQueueState((prev) => {
      const result = appendMixQueueTrack(prev.tracks, track);
      outcome = { added: result.added, index: result.index };
      const activeIndex = prev.activeIndex < 0 ? 0 : prev.activeIndex;
      return { tracks: result.tracks, activeIndex };
    });
    return outcome;
  }, []);

  const addFilesToMixQueue = React.useCallback(
    (entries: FileEntry[], options?: { activateFirst?: boolean }) => {
      if (entries.length === 0) {
        return;
      }
      const activateFirst = options?.activateFirst ?? false;
      setQueueState((prev) => {
        let nextTracks = prev.tracks.slice();
        let firstInsertedIndex = -1;
        for (const entry of entries) {
          const track = createLocalMixTrackFromFile(
            entry.file,
            entry.handle,
            entry.meta,
          );
          const result = appendMixQueueTrack(nextTracks, track);
          nextTracks = result.tracks;
          if (firstInsertedIndex < 0) {
            firstInsertedIndex = result.index;
          }
        }
        const activeIndex = activateFirst
          ? Math.max(0, firstInsertedIndex)
          : prev.activeIndex < 0
            ? 0
            : prev.activeIndex;
        return { tracks: nextTracks, activeIndex };
      });
      if (activateFirst) {
        setSelection({
          file: entries[0].file,
          handle: entries[0].handle,
        });
      }
    },
    [],
  );

  const removeFromMixQueue = React.useCallback((index: number) => {
    setQueueState((prev) =>
      removeMixQueueTrack(prev.tracks, prev.activeIndex, index),
    );
  }, []);

  const moveMixQueueItem = React.useCallback(
    (fromIndex: number, toIndex: number) => {
      setQueueState((prev) =>
        moveMixQueueTrack(prev.tracks, prev.activeIndex, fromIndex, toIndex),
      );
    },
    [],
  );

  const clearMixQueue = React.useCallback(() => {
    setQueueState((prev) => {
      const current = prev.tracks[prev.activeIndex];
      if (current) {
        return { tracks: [current], activeIndex: 0 };
      }
      return { tracks: [], activeIndex: -1 };
    });
  }, []);

  const selectMixQueueIndex = React.useCallback((index: number) => {
    setQueueState((prev) => {
      const target = prev.tracks[index];
      if (!target) {
        return prev;
      }
      if (target.file) {
        setSelection({ file: target.file, handle: target.fileHandle });
      }
      return { ...prev, activeIndex: index };
    });
  }, []);

  const updateMixQueueTrackMeta = React.useCallback(
    (
      file: File,
      meta: {
        fingerprint?: string | null;
        title?: string | null;
        artist?: string | null;
        durationSeconds?: number | null;
      },
    ) => {
      const key = fileTrackKey(file);
      setQueueState((prev) => {
        const idx = prev.tracks.findIndex(
          (track) =>
            track.file === file ||
            track.id === key ||
            (meta.fingerprint && track.fingerprint === meta.fingerprint),
        );
        if (idx < 0) {
          return prev;
        }
        const current = prev.tracks[idx];
        const nextTitle = meta.title?.trim() || current.title;
        const nextArtist = meta.artist?.trim() || current.artist;
        const nextFingerprint = meta.fingerprint ?? current.fingerprint;
        const nextDuration = meta.durationSeconds ?? current.durationSeconds;
        if (
          nextTitle === current.title &&
          nextArtist === current.artist &&
          nextFingerprint === current.fingerprint &&
          nextDuration === current.durationSeconds
        ) {
          return prev;
        }
        const next = prev.tracks.slice();
        next[idx] = {
          ...current,
          title: nextTitle,
          artist: nextArtist,
          fingerprint: nextFingerprint,
          durationSeconds: nextDuration,
        };
        return { ...prev, tracks: next };
      });
    },
    [],
  );

  const [isListenLoading, setIsListenLoading] = React.useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const value = React.useMemo(
    () => ({
      file: selection.file,
      fileHandle: selection.handle,
      setFile,
      isListenLoading,
      setIsListenLoading,
      isSettingsOpen,
      setIsSettingsOpen,
      mixQueue: queueState.tracks,
      activeQueueIndex: queueState.activeIndex,
      mixAddSticky,
      setMixAddSticky,
      addToMixQueue,
      addFilesToMixQueue,
      removeFromMixQueue,
      moveMixQueueItem,
      clearMixQueue,
      selectMixQueueIndex,
      updateMixQueueTrackMeta,
    }),
    [
      selection,
      setFile,
      isListenLoading,
      isSettingsOpen,
      queueState,
      mixAddSticky,
      addToMixQueue,
      addFilesToMixQueue,
      removeFromMixQueue,
      moveMixQueueItem,
      clearMixQueue,
      selectMixQueueIndex,
      updateMixQueueTrackMeta,
    ],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = React.useContext(AppStateContext);
  if (!ctx) {
    throw new Error("AppStateProvider missing");
  }
  return ctx;
}
