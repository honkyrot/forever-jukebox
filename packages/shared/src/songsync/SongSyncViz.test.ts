import { beforeEach, describe, expect, it, vi } from "vitest";
import { SongSyncViz, SONG_SYNC_TRACK_COLORS } from "./SongSyncViz";

function createMockCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    lineWidth: 0,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;
}

function createMockCanvas(ctx: CanvasRenderingContext2D) {
  return {
    style: {},
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 300 }),
    remove: vi.fn(),
  } as unknown as HTMLCanvasElement;
}

describe("SongSyncViz", () => {
  beforeEach(() => {
    const ctx = createMockCtx();
    (globalThis as any).window = { devicePixelRatio: 1 };
    (globalThis as any).document = {
      documentElement: {},
      createElement: () => createMockCanvas(ctx),
    };
  });

  it("scales lane widths proportionally to track durations and supports click-to-seek", () => {
    const container = {
      append: vi.fn(),
      getBoundingClientRect: () => ({ width: 600, height: 300 }),
    } as unknown as HTMLElement;
    const viz = new SongSyncViz(container);
    viz.setVisible(true);

    const makeBeats = (count: number) =>
      Array.from({ length: count }, (_, which) => ({
        which,
        start: which,
        duration: 1,
        prev: null,
        next: null,
        overlappingSegments: [],
        neighbors: [],
        allNeighbors: [],
        color: "#88f",
      }));

    viz.setData(
      [
        {
          trackIndex: 0,
          title: "JP Full",
          duration: 4,
          tempo: 170,
          beats: makeBeats(4),
          color: SONG_SYNC_TRACK_COLORS[0],
          isMaster: true,
          muted: false,
          solo: false,
        },
        {
          trackIndex: 1,
          title: "EN Short",
          duration: 2,
          tempo: 170,
          beats: makeBeats(2),
          color: SONG_SYNC_TRACK_COLORS[1],
          isMaster: false,
          muted: false,
          solo: false,
        },
      ],
      0,
      [
        [0, 1, 2, 3],
        [0, 1, null, null],
      ],
    );

    const inner = viz as unknown as {
      laneLayouts: Array<{ startX: number; endX: number; y: number; beatX: number[] }>;
      handleClick: (event: MouseEvent) => void;
    };
    const longSpan = inner.laneLayouts[0].endX - inner.laneLayouts[0].startX;
    const shortSpan = inner.laneLayouts[1].endX - inner.laneLayouts[1].startX;
    expect(shortSpan / longSpan).toBeCloseTo(0.5, 2);

    const onSelect = vi.fn();
    viz.setOnSelect(onSelect);
    inner.handleClick({
      clientX: inner.laneLayouts[1].beatX[1],
      clientY: inner.laneLayouts[1].y,
    } as MouseEvent);
    expect(onSelect).toHaveBeenCalledWith(1, 1);

    viz.update({
      masterBeatIndex: 2,
      beatIndicesByTrack: [2, null],
    });
    viz.destroy();
  });
});
