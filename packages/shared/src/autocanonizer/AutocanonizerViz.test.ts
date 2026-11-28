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
      layoutMetrics: { topPad: number; height: number; tileHeight: number; vPad: number };
      layouts: Array<{ y: number; height: number }>;
      connections: Array<{ startY: number; cy: number } | null>;
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
    const branches = inner.connections.filter(
      (c): c is { startY: number; cy: number } => Boolean(c),
    );
    const branch = branches[0];
    const deepestApex = Math.max(
      ...branches.map((c) => 0.5 * (c.startY + c.cy)),
    );
    const bottomY = inner.layoutMetrics.topPad + inner.layoutMetrics.height;
    // The drawn arc at i=1 has |delta|=2 while maxDelta=3 (from skipped i=0).
    const expectedApex = branchCursorY + (2 / 3) * (bottomY - 10 - branchCursorY);
    expect(maxBeatBottom).toBeCloseTo(sectionY, 5);
    expect(branch?.startY).toBeCloseTo(branchCursorY, 5);
    expect(deepestApex).toBeCloseTo(expectedApex, 5);
    expect(deepestApex).toBeLessThan(bottomY - 10);
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

  it("renders downward green arcs and upward gold arcs in 4-voice quad mode", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    viz.setVisible(true);

    const otherBeats = Array.from({ length: 4 }, (_, which) => ({
      which,
      start: which,
      duration: 1,
      volume: 1,
      median_volume: 1,
      color: "rgb(255, 184, 0)",
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
      color: "rgb(79, 143, 255)",
      section: which,
      otherGain: 1,
      pink: otherBeats[which],
      pinkGain: 1,
      gold: otherBeats[(which + 2) % 4],
      goldGain: 1,
    })) as any[];
    mainBeats[0].other = mainBeats[0];
    mainBeats[1].other = mainBeats[3];
    mainBeats[2].other = mainBeats[1];
    mainBeats[3].other = mainBeats[2];
    mainBeats[1].gold = otherBeats[3];
    mainBeats[2].gold = otherBeats[0];

    viz.setDualData(
      mainBeats,
      4,
      mainBeats.map((beat) => ({ start: beat.start, duration: beat.duration })),
      otherBeats,
      4,
      otherBeats.map((beat) => ({ start: beat.start, duration: beat.duration })),
      true,
    );

    const inner = viz as unknown as {
      connections: Array<{ startY: number; cy: number } | null>;
      goldConnections: Array<{ startY: number; cy: number } | null>;
    };
    const greenArc = inner.connections.find(Boolean);
    const goldArc = inner.goldConnections.find(Boolean);
    expect(greenArc).toBeTruthy();
    expect(goldArc).toBeTruthy();
    // Green arcs curve downward from Song 1; Gold arcs curve upward from Song 2.
    expect(greenArc!.cy).toBeGreaterThan(greenArc!.startY);
    expect(goldArc!.cy).toBeLessThan(goldArc!.startY);
  });

  it("scales dual-lane widths proportionally to the longer track duration", () => {
    const container = createContainer();
    const viz = new AutocanonizerViz(container);
    viz.setVisible(true);

    const makeBeats = (count: number, dur: number) =>
      Array.from({ length: count }, (_, which) => ({
        which,
        start: which * dur,
        duration: dur,
        volume: 1,
        median_volume: 1,
        color: "#fff",
        section: 0,
        otherGain: 1,
      })) as any[];

    const mainBeats = makeBeats(4, 1); // 4s total
    const otherBeats = makeBeats(2, 1); // 2s total (half length)
    mainBeats.forEach((b, i) => {
      b.other = otherBeats[i % 2];
    });
    otherBeats.forEach((b) => {
      b.other = b;
    });

    viz.setDualData(
      mainBeats,
      4,
      [{ start: 0, duration: 4 }],
      otherBeats,
      2,
      [{ start: 0, duration: 2 }],
    );

    const inner = viz as unknown as {
      layouts: Array<{ x: number; width: number }>;
      otherLayouts: Array<{ x: number; width: number }>;
    };
    const mainEnd =
      inner.layouts[inner.layouts.length - 1].x +
      inner.layouts[inner.layouts.length - 1].width;
    const otherEnd =
      inner.otherLayouts[inner.otherLayouts.length - 1].x +
      inner.otherLayouts[inner.otherLayouts.length - 1].width;
    const mainSpan = mainEnd - inner.layouts[0].x;
    const otherSpan = otherEnd - inner.otherLayouts[0].x;
    expect(otherSpan / mainSpan).toBeCloseTo(0.5, 2);
  });

  it("renders downward gold arcs and finish-out cursors in single-song 3-voice trio mode", () => {
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
      goldGain: which === 1 ? 0 : 1,
    })) as any[];
    beats[0].other = beats[0];
    beats[1].other = beats[2];
    beats[2].other = beats[3];
    beats[3].other = beats[1];
    beats[0].gold = beats[2];
    beats[1].gold = beats[1];
    beats[2].gold = beats[0];
    beats[3].gold = beats[2];

    viz.setData(
      beats,
      4,
      beats.map((beat) => ({ start: beat.start, duration: beat.duration })),
      true,
    );

    const inner = viz as unknown as {
      connections: Array<{ startY: number; cy: number } | null>;
      goldConnections: Array<{ startY: number; cy: number } | null>;
      forcedOtherIndex: number | null;
      forcedGoldIndex: number | null;
      inFinishOut: boolean;
    };
    const greenArc = inner.connections.find(Boolean);
    const goldArc = inner.goldConnections.find(Boolean);
    expect(greenArc).toBeTruthy();
    expect(goldArc).toBeTruthy();
    expect(goldArc!.cy).toBeGreaterThan(goldArc!.startY);
    // Muted beat 1 suppresses gold arcs touching it.
    expect(inner.goldConnections[0]).toBeNull();
    expect(inner.goldConnections[1]).toBeNull();

    viz.setFinishOutIndices(2, 3);
    expect(inner.inFinishOut).toBe(true);
    expect(inner.forcedOtherIndex).toBe(2);
    expect(inner.forcedGoldIndex).toBe(3);

    viz.setFinishOutIndices(null, 3);
    expect(inner.forcedOtherIndex).toBeNull();
    expect(inner.forcedGoldIndex).toBe(3);
  });

  it("renders downward pink arcs and finish-out cursors in single-song 4-voice mode", () => {
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
      goldGain: 1,
      pinkGain: which === 1 ? 0 : 1,
    })) as any[];
    beats[0].other = beats[0];
    beats[1].other = beats[2];
    beats[2].other = beats[3];
    beats[3].other = beats[1];
    beats[0].gold = beats[2];
    beats[1].gold = beats[0];
    beats[2].gold = beats[3];
    beats[3].gold = beats[1];
    beats[0].pink = beats[3];
    beats[1].pink = beats[1];
    beats[2].pink = beats[0];
    beats[3].pink = beats[2];

    viz.setData(
      beats,
      4,
      beats.map((beat) => ({ start: beat.start, duration: beat.duration })),
      4,
    );

    const inner = viz as unknown as {
      goldConnections: Array<{ startY: number; cy: number } | null>;
      pinkConnections: Array<{ startY: number; cy: number } | null>;
      forcedOtherIndex: number | null;
      forcedGoldIndex: number | null;
      forcedPinkIndex: number | null;
      inFinishOut: boolean;
    };
    const pinkArc = inner.pinkConnections.find(Boolean);
    expect(inner.goldConnections.find(Boolean)).toBeTruthy();
    expect(pinkArc).toBeTruthy();
    expect(pinkArc!.cy).toBeGreaterThan(pinkArc!.startY);
    // Muted pink on beat 1 suppresses pink arcs touching beat 1.
    expect(inner.pinkConnections[0]).toBeNull();
    expect(inner.pinkConnections[1]).toBeNull();

    viz.setFinishOutIndices(2, 3, 1);
    expect(inner.inFinishOut).toBe(true);
    expect(inner.forcedOtherIndex).toBe(2);
    expect(inner.forcedGoldIndex).toBe(3);
    expect(inner.forcedPinkIndex).toBe(1);
  });
});
