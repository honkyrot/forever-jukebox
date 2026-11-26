export type LocalMixTrack = {
  id: string;
  title: string;
  artist?: string;
  durationSeconds?: number | null;
  fingerprint?: string | null;
  file: File | null;
  fileHandle: FileSystemFileHandle | null;
};

/**
 * Strips a trailing file extension from an audio filename for display.
 */
export function stripAudioExtension(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return "";
  }
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
}

/**
 * Builds a deterministic identity key for an in-memory local File.
 */
export function fileTrackKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Constructs a LocalMixTrack from a File and optional handle/metadata.
 */
export function createLocalMixTrackFromFile(
  file: File,
  handle: FileSystemFileHandle | null = null,
  meta?: {
    title?: string | null;
    artist?: string | null;
    durationSeconds?: number | null;
    fingerprint?: string | null;
  },
): LocalMixTrack {
  const id = meta?.fingerprint || fileTrackKey(file);
  const title = meta?.title?.trim() || stripAudioExtension(file.name) || file.name;
  return {
    id,
    title,
    artist: meta?.artist?.trim() || undefined,
    durationSeconds: meta?.durationSeconds ?? null,
    fingerprint: meta?.fingerprint ?? null,
    file,
    fileHandle: handle,
  };
}

/**
 * Appends a track to the queue unless an equivalent fingerprint or file key is already queued.
 */
export function appendMixQueueTrack(
  tracks: readonly LocalMixTrack[],
  incoming: LocalMixTrack,
): { tracks: LocalMixTrack[]; added: boolean; index: number } {
  const existingIndex = tracks.findIndex(
    (track) =>
      track.id === incoming.id ||
      (incoming.fingerprint && track.fingerprint === incoming.fingerprint) ||
      (track.file &&
        incoming.file &&
        fileTrackKey(track.file) === fileTrackKey(incoming.file)),
  );
  if (existingIndex >= 0) {
    const next = tracks.slice();
    const prev = next[existingIndex];
    next[existingIndex] = {
      ...prev,
      file: incoming.file ?? prev.file,
      fileHandle: incoming.fileHandle ?? prev.fileHandle,
      fingerprint: incoming.fingerprint ?? prev.fingerprint,
      title: incoming.title || prev.title,
      artist: incoming.artist ?? prev.artist,
      durationSeconds: incoming.durationSeconds ?? prev.durationSeconds,
    };
    return { tracks: next, added: false, index: existingIndex };
  }
  return {
    tracks: [...tracks, incoming],
    added: true,
    index: tracks.length,
  };
}

/**
 * Reorders an item in the mix queue while keeping `activeIndex` pointing at the same track.
 */
export function moveMixQueueTrack(
  tracks: readonly LocalMixTrack[],
  activeIndex: number,
  fromIndex: number,
  toIndex: number,
): { tracks: LocalMixTrack[]; activeIndex: number } {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tracks.length ||
    toIndex >= tracks.length
  ) {
    return { tracks: tracks.slice(), activeIndex };
  }
  const next = tracks.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  let nextActive = activeIndex;
  if (activeIndex === fromIndex) {
    nextActive = toIndex;
  } else if (fromIndex < activeIndex && toIndex >= activeIndex) {
    nextActive = activeIndex - 1;
  } else if (fromIndex > activeIndex && toIndex <= activeIndex) {
    nextActive = activeIndex + 1;
  }
  return { tracks: next, activeIndex: nextActive };
}

/**
 * Removes an item at `removeIndex`, clamping or adjusting `activeIndex`.
 */
export function removeMixQueueTrack(
  tracks: readonly LocalMixTrack[],
  activeIndex: number,
  removeIndex: number,
): { tracks: LocalMixTrack[]; activeIndex: number } {
  if (removeIndex < 0 || removeIndex >= tracks.length) {
    return { tracks: tracks.slice(), activeIndex };
  }
  const next = tracks.slice();
  next.splice(removeIndex, 1);
  if (next.length === 0) {
    return { tracks: [], activeIndex: -1 };
  }
  let nextActive = activeIndex;
  if (removeIndex < activeIndex) {
    nextActive = activeIndex - 1;
  } else if (activeIndex >= next.length) {
    nextActive = next.length - 1;
  }
  return { tracks: next, activeIndex: nextActive };
}
