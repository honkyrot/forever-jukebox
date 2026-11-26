import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACK_LIST_SORT,
  displayTrackArtist,
  nextTrackListSort,
  sortTrackRows,
} from "./track-list-sort";

type SampleTrack = {
  id: string;
  title: string;
  artist: string;
};

const SAMPLE_TRACKS: SampleTrack[] = [
  { id: "1", title: "Zebra", artist: "Miles" },
  { id: "2", title: "Alpha", artist: "Zed" },
  { id: "3", title: "Beta", artist: "Ann" },
  { id: "4", title: "Gamma", artist: "Unknown" },
];

describe("displayTrackArtist", () => {
  it("hides blank, whitespace, and unknown artists while trimming valid names", () => {
    expect(displayTrackArtist("")).toBe("");
    expect(displayTrackArtist("   ")).toBe("");
    expect(displayTrackArtist(null)).toBe("");
    expect(displayTrackArtist(undefined)).toBe("");
    expect(displayTrackArtist("unknown")).toBe("");
    expect(displayTrackArtist("  Unknown  ")).toBe("");
    expect(displayTrackArtist("  ProjectMoon Official  ")).toBe(
      "ProjectMoon Official",
    );
  });
});

describe("nextTrackListSort", () => {
  it("starts ascending on Title/Artist, toggles direction, and resets strictly on default", () => {
    const titleAsc = nextTrackListSort(DEFAULT_TRACK_LIST_SORT, "title");
    expect(titleAsc).toEqual({ key: "title", direction: "asc" });

    const titleDesc = nextTrackListSort(titleAsc, "title");
    expect(titleDesc).toEqual({ key: "title", direction: "desc" });

    const artistAsc = nextTrackListSort(titleDesc, "artist");
    expect(artistAsc).toEqual({ key: "artist", direction: "asc" });

    const artistDesc = nextTrackListSort(artistAsc, "artist");
    expect(artistDesc).toEqual({ key: "artist", direction: "desc" });

    const resetFromArtist = nextTrackListSort(artistDesc, "default");
    expect(resetFromArtist).toEqual({ key: "default", direction: "asc" });

    // Repeated clicks on "#" stay in default ascending order and never reverse.
    const resetAgain = nextTrackListSort(resetFromArtist, "default");
    expect(resetAgain).toEqual({ key: "default", direction: "asc" });
  });
});

describe("sortTrackRows", () => {
  it("preserves original 1-based rank across Title and Artist sorts and restores default order", () => {
    const defaultRows = sortTrackRows(
      SAMPLE_TRACKS,
      DEFAULT_TRACK_LIST_SORT,
      (item) => item,
    );
    expect(defaultRows.map((row) => [row.rank, row.item.title])).toEqual([
      [1, "Zebra"],
      [2, "Alpha"],
      [3, "Beta"],
      [4, "Gamma"],
    ]);

    const titleAsc = sortTrackRows(
      SAMPLE_TRACKS,
      { key: "title", direction: "asc" },
      (item) => item,
    );
    expect(titleAsc.map((row) => [row.rank, row.item.title])).toEqual([
      [2, "Alpha"],
      [3, "Beta"],
      [4, "Gamma"],
      [1, "Zebra"],
    ]);

    const titleDesc = sortTrackRows(
      SAMPLE_TRACKS,
      { key: "title", direction: "desc" },
      (item) => item,
    );
    expect(titleDesc.map((row) => [row.rank, row.item.title])).toEqual([
      [1, "Zebra"],
      [4, "Gamma"],
      [3, "Beta"],
      [2, "Alpha"],
    ]);

    const artistAsc = sortTrackRows(
      SAMPLE_TRACKS,
      { key: "artist", direction: "asc" },
      (item) => item,
    );
    // "Unknown" normalizes to "" so it sorts before named artists in ascending order.
    expect(artistAsc.map((row) => [row.rank, row.item.artist])).toEqual([
      [4, "Unknown"],
      [3, "Ann"],
      [1, "Miles"],
      [2, "Zed"],
    ]);

    const artistDesc = sortTrackRows(
      SAMPLE_TRACKS,
      { key: "artist", direction: "desc" },
      (item) => item,
    );
    expect(artistDesc.map((row) => [row.rank, row.item.artist])).toEqual([
      [2, "Zed"],
      [1, "Miles"],
      [3, "Ann"],
      [4, "Unknown"],
    ]);
  });

  it("breaks ties by complementary column ascending and then original rank", () => {
    const ties: SampleTrack[] = [
      { id: "a", title: "Same", artist: "Zed" },
      { id: "b", title: "Same", artist: "Ann" },
      { id: "c", title: "Same", artist: "Ann" },
    ];
    const sorted = sortTrackRows(
      ties,
      { key: "title", direction: "desc" },
      (item) => item,
    );
    expect(sorted.map((row) => [row.rank, row.item.id])).toEqual([
      [2, "b"],
      [3, "c"],
      [1, "a"],
    ]);
  });
});
