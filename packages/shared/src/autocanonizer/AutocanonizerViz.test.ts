import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutocanonizerViz } from "./AutocanonizerViz";

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
    quadraticCurveTo: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    lineWidth: 0,
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
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
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    remove: vi.fn(),
  } as unknown as HTMLCanvasElement;
}

function setMockDocument() {
  const ctx = createMockCtx();
  (globalThis as any).window = {
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
  };
  (globalThis as any).document = {
    documentElement: {},
    createElement: (tag: string) => {
      if (tag === "canvas") {
        return createMockCanvas(ctx);
      }
      return {};
    },
  } as Document;
}

function createContainer() {
  return {
    append: vi.fn(),
    getBoundingClientRect: () => ({ width: 300, height: 300 }),
  } as unknown as HTMLElement;
}

describe("AutocanonizerViz", () => {
  beforeEach(() => {
    setMockDocument();
  });

  it("toggles visibility", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    viz.setVisible(false);
    const inner = viz as unknown as { baseCanvas: HTMLCanvasElement; overlayCanvas: HTMLCanvasElement };
    expect(inner.baseCanvas.style.display).toBe("none");
    expect(inner.overlayCanvas.style.display).toBe("none");
  });

  it("accepts layout updates", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    const beatA = {
      which: 0,
      start: 0,
      duration: 1,
      volume: 0.5,
      median_volume: 0.5,
      color: "#fff",
      section: 0,
    } as any;
    const beatB = {
      which: 1,
      start: 1,
      duration: 1,
      volume: 0.5,
      median_volume: 0.5,
      color: "#fff",
      section: 1,
    } as any;
    beatA.other = beatB;
    beatA.otherGain = 1;
    beatB.other = beatA;
    beatB.otherGain = 1;
    viz.setData(
      [beatA, beatB],
      2,
      [
        { start: 0, duration: 1 },
        { start: 1, duration: 1 },
      ]
    );
    const inner = viz as unknown as { beats: unknown[] };
    expect(inner.beats.length).toBe(2);
  });

  it("keeps section strips below beats while branches track the cursor line", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    viz.setVisible(true);
    const beats = Array.from({ length: 4 }, (_, which) => ({
      which,
      start: which,
      duration: 1,
      volume: 1,
      median_volume: 1,
      color: "rgb(255, 255, 255)",
      section: which,
      otherGain: 1,
    })) as any[];
    beats[0].other = beats[0];
    beats[1].other = beats[3];
    beats[2].other = beats[1];
    beats[3].other = beats[2];
    viz.setData(
      beats,
      4,
      beats.map((beat) => ({ start: beat.start, duration: beat.duration })),
    );
    const inner = viz as unknown as {
      layoutMetrics: { topPad: number; tileHeight: number; vPad: number };
      layouts: Array<{ y: number; height: number }>;
      connections: Array<{ startY: number } | null>;
      baseCtx: CanvasRenderingContext2D;
    };
    const sectionY =
      inner.layoutMetrics.topPad +
      inner.layoutMetrics.tileHeight -
      inner.layoutMetrics.vPad;
    const branchCursorY = sectionY + 16 - 8 / 2;
    const maxBeatBottom = Math.max(
      ...inner.layouts.map((layout) => layout.y + layout.height),
    );
    const branch = inner.connections.find(Boolean);
    expect(maxBeatBottom).toBeCloseTo(sectionY, 5);
    expect(branch?.startY).toBeCloseTo(branchCursorY, 5);
    expect(inner.baseCtx.fillStyle).toBe("hsl(141, 80%, 55%)");
  });

  it("tracks current index updates", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    const beat = {
      which: 0,
      start: 0,
      duration: 1,
      volume: 0.5,
      median_volume: 0.5,
      color: "#fff",
      section: 0,
    } as any;
    beat.other = beat;
    beat.otherGain = 1;
    viz.setData([beat], 1, [{ start: 0, duration: 1 }]);
    viz.setCurrentIndex(0, false);
    const inner = viz as unknown as { currentIndex: number };
    expect(inner.currentIndex).toBe(0);
  });

  it("renders upright top beats and upside-down bottom beats with upward arcs in dual mode", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    viz.setVisible(true);

    const otherBeats = Array.from({ length: 4 }, (_, which) => ({
      which,
      start: which * 0.5,
      duration: 0.5,
      volume: 1,
      median_volume: 1,
      color: "rgb(200, 200, 200)",
      section: which,
      otherGain: 1,
    })) as any[];
    otherBeats.forEach((beat) => {
      beat.other = beat;
    });

    const mainBeats = Array.from({ length: 4 }, (_, which) => ({
      which,
      start: which,
      duration: 1,
      volume: 1,
      median_volume: 1,
      color: "rgb(100, 150, 255)",
      section: which,
      otherGain: 1,
    })) as any[];
    mainBeats[0].other = otherBeats[0];
    mainBeats[1].other = otherBeats[3];
    mainBeats[2].other = otherBeats[1];
    mainBeats[3].other = otherBeats[2];

    viz.setDualData(
      mainBeats,
      4,
      mainBeats.map((beat) => ({ start: beat.start, duration: beat.duration })),
      otherBeats,
      2,
      otherBeats.map((beat) => ({ start: beat.start, duration: beat.duration })),
    );

    const inner = viz as unknown as {
      layoutMetrics: { mainSectionY: number; otherSectionY: number; otherBaseY: number };
      layouts: Array<{ y: number; height: number }>;
      otherLayouts: Array<{ x: number; y: number; width: number; height: number }>;
      connections: Array<{ startY: number; cy: number } | null>;
    };

    const { mainSectionY, otherSectionY, otherBaseY } = inner.layoutMetrics;
    expect(otherSectionY).toBeGreaterThan(mainSectionY);
    for (const layout of inner.layouts) {
      expect(layout.y + layout.height).toBeCloseTo(mainSectionY, 5);
    }
    for (const layout of inner.otherLayouts) {
      expect(layout.y).toBeCloseTo(otherBaseY, 5);
      expect(layout.y + layout.height).toBeGreaterThan(otherBaseY);
    }

    const branch = inner.connections.find(Boolean);
    expect(branch).toBeTruthy();
    expect(branch!.startY).toBeGreaterThan(mainSectionY);
    expect(branch!.cy).toBeLessThan(branch!.startY);

    const onSelect = vi.fn();
    viz.setOnSelect(onSelect);
    const clickTarget = inner.otherLayouts[3];
    const clickHandler = (viz as unknown as { handleClick: (event: MouseEvent) => void })
      .handleClick;
    clickHandler({
      clientX: clickTarget.x + clickTarget.width / 2,
      clientY: clickTarget.y + clickTarget.height / 2,
    } as MouseEvent);
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
