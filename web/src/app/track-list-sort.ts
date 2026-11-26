export type TrackListSortKey = "default" | "title" | "artist";

export type TrackListSort = {
  key: TrackListSortKey;
  direction: "asc" | "desc";
};

export const DEFAULT_TRACK_LIST_SORT: TrackListSort = {
  key: "default",
  direction: "asc",
};

export type IndexedTrackRow<T> = {
  item: T;
  rank: number;
};

/**
 * Normalizes a track artist string for table display, hiding blank or "unknown" values.
 */
export function displayTrackArtist(artist: string | null | undefined): string {
  const trimmed = (artist ?? "").trim();
  return trimmed !== "" && trimmed.toLowerCase() !== "unknown" ? trimmed : "";
}

/**
 * Computes the next sort state for a track list column header click.
 * Clicking the rank/default column always resets to the default ascending order.
 */
export function nextTrackListSort(
  prev: TrackListSort,
  key: TrackListSortKey,
): TrackListSort {
  if (key === "default") {
    return DEFAULT_TRACK_LIST_SORT;
  }
  if (prev.key !== key) {
    return { key, direction: "asc" };
  }
  return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
}

function compareTrackField(
  valueA: string,
  valueB: string,
): number {
  return valueA.toLowerCase().localeCompare(valueB.toLowerCase());
}

/**
 * Indexes items with their 1-based original rank and returns rows ordered by the active sort.
 */
export function sortTrackRows<T>(
  items: T[],
  sort: TrackListSort,
  getFields: (item: T) => { title: string; artist: string },
): IndexedTrackRow<T>[] {
  const indexed = items.map((item, index) => ({
    item,
    rank: index + 1,
  }));
  if (sort.key === "default") {
    return indexed;
  }

  const direction = sort.direction === "asc" ? 1 : -1;
  const sortKey = sort.key;
  return [...indexed].sort((a, b) => {
    const fieldsA = getFields(a.item);
    const fieldsB = getFields(b.item);

    const primaryA =
      sortKey === "title"
        ? fieldsA.title.trim()
        : displayTrackArtist(fieldsA.artist);
    const primaryB =
      sortKey === "title"
        ? fieldsB.title.trim()
        : displayTrackArtist(fieldsB.artist);
    const primary = compareTrackField(primaryA, primaryB);
    if (primary !== 0) {
      return primary * direction;
    }

    // Break ties with the complementary text column in ascending order, then original rank.
    const secondaryA =
      sortKey === "title"
        ? displayTrackArtist(fieldsA.artist)
        : fieldsA.title.trim();
    const secondaryB =
      sortKey === "title"
        ? displayTrackArtist(fieldsB.artist)
        : fieldsB.title.trim();
    const secondary = compareTrackField(secondaryA, secondaryB);
    if (secondary !== 0) {
      return secondary;
    }

    return a.rank - b.rank;
  });
}
