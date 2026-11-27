import type { JukeboxEngine } from "../engine";
import type {
  Edge,
  PredictedJump,
  QuantumBase,
  TrackSliceMeta,
} from "../engine/types";
import {
  moveCustomAnchorEnd,
  type CustomAnchor,
  type CustomAnchorEnd,
} from "../engine/selection";
import { beatPairMatch } from "../engine/graph";
import { computePitchBeatColors } from "../engine/beatColors";
import {
  ANCHOR_HIGHLIGHT_COLOR,
  ANCHOR_MATCH_COLORS,
  BEAT_AVOID_RADIUS_PX,
  BEAT_SELECT_RADIUS_PX,
  EDGE_SELECT_RADIUS_PX,
  MAX_EDGE_SAMPLES,
  MAX_EDGES_BASE,
} from "../constants/visualization";
import {
  computeMatrixSimilarityGrid,
  createMatrixControlPointResolver,
  createMatrixPositioner,
  createRingsPositioner,
  createRosePositioner,
  getMatrixBounds,
  type MatrixSimilarityGrid,
} from "./extraLayouts";

type VizData = NonNullable<ReturnType<JukeboxEngine["getVisualizationData"]>>;

type LastUpdate = {
  index: number;
  animate: boolean;
  previousIndex: number | null;
};

type Point = { x: number; y: number };

interface VisualizationData {
  beats: QuantumBase[];
  beatVisits: readonly number[];
  beatColors: readonly string[];
  edges: Edge[];
  lastBranchPoint: number;
  anchorEdgeId: number | null;
  userAnchorEdgeId: number | null;
  tracks?: TrackSliceMeta[];
}

const BEAT_DOT_RADIUS_PX = 2;
const BEAT_CURSOR_RADIUS_PX = 10;

// Classic layout proportions, as fractions of min(width, height).
const CLASSIC_RADIUS_RATIO = 0.4;
const TILE_MAX_HEIGHT_RATIO = 0.1;
const TILE_MAX_WIDTH_RATIO = 0.03;
const TILE_MARKER_MIN_WIDTH_PX = 3;
const BEAT_HOVER_ALPHA = 0.6;
const HOVER_BRANCH_LINE_WIDTH_PX = 1.8;
// Canvas drops zero-length lines along with their round caps.
const TILE_MIN_LINE_LENGTH_PX = 0.01;
// A tile with n visits is n + TILE_BASE_STEPS steps long, of TILE_MAX_STEPS at full height.
const TILE_BASE_STEPS = 4;
const TILE_MAX_STEPS = 12;
// The jump line fades in fixed alpha steps, one overlay redraw per step.
const JUMP_FADE_MS = 1000;
const JUMP_FADE_STEPS = 12;
// Fixed per-branch ROYGBIV hues (Red -> Orange -> Yellow -> Green -> Cyan -> Blue -> Violet -> Magenta).
const PREDICTED_JUMP_RAINBOW_HUES = [4, 28, 50, 132, 188, 224, 272, 318] as const;
// Base edges are stroked in this many layers; overlaps across layers build up alpha.
const EDGE_LAYERS = 4;

interface JumpLine {
  from: number;
  to: number;
  at: number;
  control: [number, number] | null;
}

/**
 * Compares two predicted-jump lists by coordinates and edge id so repeated
 * identical syncs do not restart the flowing overlay animation.
 */
function predictedJumpsEqual(
  left: readonly PredictedJump[],
  right: readonly PredictedJump[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (
      left[i].fromIndex !== right[i].fromIndex ||
      left[i].toIndex !== right[i].toIndex ||
      left[i].edgeId !== right[i].edgeId ||
      left[i].sequenceIndex !== right[i].sequenceIndex
    ) {
      return false;
    }
  }
  return true;
}

export type AnchorEditState = CustomAnchor & { active: CustomAnchorEnd };
type AnchorEditHandler = (state: AnchorEditState) => void;

export type VisualEffectMode = "0" | "1" | "2" | "3" | "4";

export type VisualPreferences = {
  visualEffectMode: VisualEffectMode;
  useSquareBeats: boolean;
  useAltSeekShape: boolean;
};

export function readStoredVisualPreferences(): VisualPreferences {
  if (typeof localStorage === "undefined") {
    return {
      visualEffectMode: "0",
      useSquareBeats: false,
      useAltSeekShape: false,
    };
  }
  const rawMode = localStorage.getItem("visualEffectMode");
  const visualEffectMode: VisualEffectMode =
    rawMode === "1" || rawMode === "2" || rawMode === "3" || rawMode === "4"
      ? rawMode
      : "0";
  return {
    visualEffectMode,
    useSquareBeats: localStorage.getItem("useSquareBeats") === "true",
    useAltSeekShape: localStorage.getItem("useAltSeekShape") === "true",
  };
}

const ANCHOR_HANDLE_RADIUS_PX = 7;
const ANCHOR_ACTIVE_RING_RADIUS_PX = 12;
const ANCHOR_ARROW_LENGTH_PX = 11;
const ANCHOR_HANDLE_HIT_MOUSE_PX = 12;
const ANCHOR_HANDLE_HIT_TOUCH_PX = 22;

type Positioner = (
  data: VisualizationData,
  width: number,
  height: number
) => Array<{ x: number; y: number }>;

type EdgeControlPointResolver = (args: {
  edge: Edge | null;
  from: { x: number; y: number };
  to: { x: number; y: number };
  fromIndex: number;
  toIndex: number;
  data: VisualizationData;
  center: { x: number; y: number };
}) => [number, number];

type CanvasVizOptions = {
  enableInteraction?: boolean;
  forceBendEdges?: boolean;
  edgeControlPointResolver?: EdgeControlPointResolver;
  beatTiles?: boolean;
  matrixMode?: boolean;
  background?: { inner: string; outer: string };
};

type VisualizationDefinition = {
  positioner: Positioner;
  options?: Omit<CanvasVizOptions, "enableInteraction">;
};

class CanvasViz {
  private readonly container: HTMLElement;
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly tileCanvas: HTMLCanvasElement | null = null;
  private readonly tileCtx: CanvasRenderingContext2D | null = null;

  private size = { width: 0, height: 0 };
  private dpr = 0;
  private data: VisualizationData | null = null;
  private positions: Array<{ x: number; y: number }> = [];
  private center = { x: 0, y: 0 };
  private readonly bendCache = new Map<string, boolean>();

  private currentIndex = -1;
  private jumpLine: JumpLine | null = null;
  private selectedEdge: Edge | null = null;
  private predictedJumps: PredictedJump[] = [];
  private predictedJumpControls: Array<[number, number] | null> = [];
  private overlayTimerId: number | null = null;
  private overlayRafId: number | null = null;
  private jumpFadeColors: string[] = [];
  private readonly background: CanvasVizOptions["background"];
  private backgroundFill: CanvasGradient | null = null;
  private paintedVisits: number[] = [];
  private tileScale = 1;
  private hoveredBeat: number | null = null;

  private onSelect: ((index: number) => void) | null = null;
  private onEdgeSelect: ((edge: Edge | null) => void) | null = null;
  // Non-null while the user edits the custom anchor; holds beat indexes, never pixels.
  private anchorEdit: AnchorEditState | null = null;
  private anchorDrag: { pointerId: number; origin: AnchorEditState } | null = null;
  private onAnchorEditChange: AnchorEditHandler | null = null;
  private onAnchorEditCommit: AnchorEditHandler | null = null;

  private readonly positioner: Positioner;
  private readonly forceBendEdges: boolean;
  private readonly edgeControlPointResolver: EdgeControlPointResolver | null;
  private readonly matrixMode: boolean;
  private visible = true;
  private anchorHighlightEnabled = false;
  private visualPreferences: VisualPreferences = readStoredVisualPreferences();
  private pitchColors: Array<string | null> = [];
  private matrixGrid: MatrixSimilarityGrid | null = null;

  private edgeGeometry = new WeakMap<
    Edge,
    { bend: boolean; control: [number, number] | null }
  >();
  private readonly theme = {
    edgeStroke: "rgba(74, 199, 255, 0.12)",
    beatFill: "rgba(255, 215, 130, 0.55)",
    edgeSelected: "#ff5b5b",
    beatHighlight: "#ffd46a",
    beatHighlightRgb: null as { r: number; g: number; b: number } | null,
  };

  constructor(
    container: HTMLElement,
    positioner: Positioner,
    options: CanvasVizOptions = {}
  ) {
    this.container = container;
    this.positioner = positioner;
    this.forceBendEdges = options.forceBendEdges ?? false;
    this.edgeControlPointResolver = options.edgeControlPointResolver ?? null;
    this.matrixMode = options.matrixMode ?? false;
    this.background = options.background;
    this.baseCanvas = document.createElement("canvas");
    this.overlayCanvas = document.createElement("canvas");
    const baseCtx = this.baseCanvas.getContext("2d", { alpha: !this.background });
    const overlayCtx = this.overlayCanvas.getContext("2d");
    if (!baseCtx || !overlayCtx) {
      throw new Error("Canvas not supported");
    }
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;
    if (options.beatTiles) {
      this.tileCanvas = document.createElement("canvas");
      const tileCtx = this.tileCanvas.getContext("2d");
      if (!tileCtx) {
        throw new Error("Canvas not supported");
      }
      this.tileCtx = tileCtx;
    }
    this.container.append(...this.canvases);
    this.applyCanvasStyles();
    this.updateTheme();
    this.resize();
    if (options.enableInteraction !== false) {
      this.overlayCanvas.addEventListener("click", this.handleCanvasClick);
      this.overlayCanvas.addEventListener("pointermove", this.handlePointerMove);
      this.overlayCanvas.addEventListener("pointerleave", this.handlePointerLeave);
      this.overlayCanvas.addEventListener("pointerdown", this.handlePointerDown);
      this.overlayCanvas.addEventListener("pointerup", this.handlePointerUp);
      this.overlayCanvas.addEventListener("pointercancel", this.handlePointerCancel);
      this.overlayCanvas.addEventListener("touchstart", this.handleTouchStart, { passive: false });
    }
  }

  setVisible(visible: boolean) {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    const display = visible ? "block" : "none";
    for (const canvas of this.canvases) {
      canvas.style.display = display;
    }
    if (visible && this.data) {
      this.drawBase();
      this.drawTiles();
      this.drawOverlay();
    } else if (visible) {
      this.drawBase();
    } else {
      this.clearHoveredBeat();
      this.cancelOverlayAnimation();
    }
  }

  setData(data: VisualizationData) {
    this.data = data;
    this.pitchColors = computePitchBeatColors(data.beats);
    this.matrixGrid = this.matrixMode
      ? computeMatrixSimilarityGrid(data.beats)
      : null;
    this.clearHoveredBeat();
    this.computePositions();
    this.computeEdgeGeometry();
    this.drawBase();
    this.drawTiles();
    this.drawOverlay();
  }

  refresh() {
    if (!this.data) {
      return;
    }
    this.updateTheme();
    this.drawBase();
    this.drawTiles();
    this.drawOverlay();
  }

  update(currentIndex: number, lastJumped: boolean, previousIndex: number | null) {
    this.syncTiles();
    if (currentIndex === this.currentIndex && !lastJumped) {
      return;
    }
    this.currentIndex = currentIndex;
    if (lastJumped && previousIndex !== null) {
      this.jumpLine = {
        from: previousIndex,
        to: currentIndex,
        at: performance.now(),
        control: this.resolveJumpControl(previousIndex, currentIndex),
      };
    }
    this.drawOverlay();
  }

  reset() {
    this.currentIndex = -1;
    this.jumpLine = null;
    this.selectedEdge = null;
    this.predictedJumps = [];
    this.predictedJumpControls = [];
    this.cancelOverlayAnimation();
    this.syncTiles();
    this.drawOverlay();
  }

  destroy() {
    // An unfinished drag reverts, so a layout switch never leaves an uncommitted pair.
    this.cancelAnchorDrag();
    this.overlayCanvas.removeEventListener("click", this.handleCanvasClick);
    this.overlayCanvas.removeEventListener("pointermove", this.handlePointerMove);
    this.overlayCanvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.overlayCanvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.overlayCanvas.removeEventListener("pointerup", this.handlePointerUp);
    this.overlayCanvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.overlayCanvas.removeEventListener("touchstart", this.handleTouchStart);
    // Removed canvases hold their bitmaps until GC, too long on low-memory devices.
    for (const canvas of this.canvases) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    this.data = null;
    this.positions = [];
    this.pitchColors = [];
    this.matrixGrid = null;
    this.predictedJumps = [];
    this.predictedJumpControls = [];
    this.edgeGeometry = new WeakMap();
    this.bendCache.clear();
    this.cancelOverlayAnimation();
  }

  setOnSelect(handler: (index: number) => void) {
    this.onSelect = handler;
  }

  setOnEdgeSelect(handler: (edge: Edge | null) => void) {
    this.onEdgeSelect = handler;
  }

  setSelectedEdge(edge: Edge | null) {
    this.selectedEdge = edge;
    this.drawOverlay();
  }

  /**
   * Updates the ordered list of upcoming predicted jumps to render on the overlay.
   */
  setPredictedJumps(jumps: readonly PredictedJump[]) {
    if (predictedJumpsEqual(this.predictedJumps, jumps)) {
      return;
    }
    this.predictedJumps = jumps.map((jump) => ({ ...jump }));
    this.syncPredictedJumpControls();
    this.drawOverlay();
  }

  setAnchorHighlightEnabled(enabled: boolean) {
    if (enabled === this.anchorHighlightEnabled) {
      return;
    }
    this.anchorHighlightEnabled = enabled;
    this.drawBase();
  }

  setOnAnchorEditChange(handler: AnchorEditHandler) {
    this.onAnchorEditChange = handler;
  }

  setOnAnchorEditCommit(handler: AnchorEditHandler) {
    this.onAnchorEditCommit = handler;
  }

  // Apps echo each drag step back here, so hover and cursor reset only when edit mode turns on or off.
  setAnchorEdit(state: AnchorEditState | null) {
    const current = this.anchorEdit;
    if (
      state &&
      current &&
      state.src === current.src &&
      state.dest === current.dest &&
      state.active === current.active
    ) {
      return;
    }
    const modeChanged = (state === null) !== (current === null);
    this.anchorEdit = state ? { ...state } : null;
    if (!state) {
      this.anchorDrag = null;
    }
    if (modeChanged) {
      this.clearHoveredBeat();
    }
    this.drawOverlay();
  }

  resizeNow() {
    this.resize();
  }

  // In stacking order, bottom to top.
  private get canvases() {
    return this.tileCanvas
      ? [this.baseCanvas, this.tileCanvas, this.overlayCanvas]
      : [this.baseCanvas, this.overlayCanvas];
  }

  private applyCanvasStyles() {
    for (const canvas of this.canvases) {
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
  }

  private resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (
      rect.width === this.size.width &&
      rect.height === this.size.height &&
      dpr === this.dpr
    ) {
      return;
    }
    this.dpr = dpr;
    this.size = { width: rect.width, height: rect.height };
    this.clearHoveredBeat();
    for (const canvas of this.canvases) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.tileCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.background) {
      const x = rect.width / 2;
      const y = rect.height / 2;
      this.backgroundFill = this.baseCtx.createRadialGradient(x, y, 0, x, y, Math.min(x, y));
      this.backgroundFill.addColorStop(0, this.background.inner);
      this.backgroundFill.addColorStop(1, this.background.outer);
    }
    if (this.data) {
      this.computePositions();
      this.computeEdgeGeometry();
      this.drawBase();
      this.drawTiles();
      this.drawOverlay();
    } else {
      this.drawBase();
    }
  }

  private computePositions() {
    if (!this.data) {
      return;
    }
    const { width, height } = this.size;
    this.positions = this.positioner(this.data, width, height);
    this.center = { x: width / 2, y: height / 2 };
    this.bendCache.clear();
    if (this.jumpLine) {
      this.jumpLine.control = this.resolveJumpControl(this.jumpLine.from, this.jumpLine.to);
    }
    this.syncPredictedJumpControls();
  }

  private syncPredictedJumpControls() {
    this.predictedJumpControls = this.predictedJumps.map((jump) =>
      this.resolveJumpControl(jump.fromIndex, jump.toIndex),
    );
  }

  private computeEdgeGeometry() {
    if (!this.data) {
      return;
    }
    this.edgeGeometry = new WeakMap();
    for (const edge of this.data.edges) {
      if (edge.deleted) {
        continue;
      }
      const from = this.positions[edge.src.which];
      const to = this.positions[edge.dest.which];
      if (!from || !to) {
        continue;
      }
      this.edgeGeometry.set(
        edge,
        this.resolveEdgeGeometry(edge, from, to, edge.src.which, edge.dest.which)
      );
    }
  }

  private updateTheme() {
    const styles = getComputedStyle(document.documentElement);
    this.theme.edgeStroke =
      styles.getPropertyValue("--edge-stroke").trim() || this.theme.edgeStroke;
    this.theme.beatFill =
      styles.getPropertyValue("--beat-fill").trim() || this.theme.beatFill;
    this.theme.edgeSelected =
      styles.getPropertyValue("--edge-selected").trim() ||
      this.theme.edgeSelected;
    this.theme.beatHighlight =
      styles.getPropertyValue("--beat-highlight").trim() ||
      this.theme.beatHighlight;
    this.theme.beatHighlightRgb = this.parseThemeColor(this.theme.beatHighlight);
    this.jumpFadeColors = Array.from({ length: JUMP_FADE_STEPS }, (_, step) =>
      this.resolveBeatHighlightColor(1 - step / JUMP_FADE_STEPS)
    );
  }

  private parseThemeColor(color: string) {
    const value = color.trim();
    if (value.startsWith("#")) {
      const hex = value.slice(1);
      const normalized =
        hex.length === 3
          ? hex
              .split("")
              .map((ch) => ch + ch)
              .join("")
          : hex.slice(0, 6);
      const r = Number.parseInt(normalized.slice(0, 2), 16);
      const g = Number.parseInt(normalized.slice(2, 4), 16);
      const b = Number.parseInt(normalized.slice(4, 6), 16);
      if (
        Number.isFinite(r) &&
        Number.isFinite(g) &&
        Number.isFinite(b)
      ) {
        return { r, g, b };
      }
    }
    const match = /rgba?\(([^)]+)\)/i.exec(value);
    if (match) {
      const parts = match[1].split(",").map((val) => Number.parseFloat(val));
      if (parts.length >= 3 && parts.every((val) => Number.isFinite(val))) {
        return { r: parts[0], g: parts[1], b: parts[2] };
      }
    }
    return null;
  }

  /**
   * Resolves a beat's color from an external color array, applying optional
   * alpha transparency and falling back when unavailable.
   */
  private resolveColorEntry(
    color: string | null | undefined,
    alpha: number,
    fallback: string
  ): string {
    if (!color) {
      return fallback;
    }
    const normalizedAlpha = Math.min(Math.max(alpha, 0), 1);
    // Return the raw beat color when fully opaque to preserve exact hex values.
    if (normalizedAlpha >= 1) {
      return color;
    }
    const rgb = this.parseThemeColor(color);
    if (!rgb) {
      return color;
    }
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${normalizedAlpha})`;
  }

  /**
   * Resolves a beat's upstream timbre-based color from `beatColors`,
   * applying optional alpha transparency and falling back when unavailable.
   */
  private resolveEngineBeatColor(
    beatIndex: number,
    alpha: number,
    fallback: string
  ): string {
    return this.resolveColorEntry(
      this.data?.beatColors?.[beatIndex],
      alpha,
      fallback
    );
  }

  /**
   * Resolves a beat's Circle-of-Fifths pitch color from `pitchColors`,
   * applying optional alpha transparency and falling back when unavailable.
   */
  private resolvePitchBeatColor(
    beatIndex: number,
    alpha: number,
    fallback: string
  ): string {
    return this.resolveColorEntry(
      this.pitchColors[beatIndex],
      alpha,
      fallback
    );
  }

  /**
   * Resolves the Classic layout tile color for a beat, switching to pitch colors
   * when Pitch mode is active.
   */
  private resolveTileColor(index: number): string {
    const engineColor = this.data?.beatColors?.[index] || this.theme.beatFill;
    if (this.visualPreferences.visualEffectMode === "4") {
      return this.resolvePitchBeatColor(index, 1, engineColor);
    }
    return engineColor;
  }

  setVisualPreferences(prefs: VisualPreferences) {
    this.visualPreferences = prefs;
    this.drawBase();
    this.drawTiles();
    this.drawOverlay();
  }

  // An opaque base starts black, so its background is painted even before data arrives.
  private drawBase() {
    if (!this.visible || (!this.data && !this.backgroundFill)) {
      return;
    }
    const { width, height } = this.size;
    if (this.backgroundFill) {
      this.baseCtx.fillStyle = this.backgroundFill;
      this.baseCtx.fillRect(0, 0, width, height);
    } else {
      this.baseCtx.clearRect(0, 0, width, height);
    }
    if (!this.data) {
      return;
    }
    this.baseCtx.save();
    this.baseCtx.lineWidth = 1;

    const isMultiTrack = (this.data.tracks?.length ?? 0) >= 2;
    if (isMultiTrack) {
      this.drawMultiTrackLanes();
    } else if (this.matrixMode) {
      this.drawMatrixBase(width, height);
      this.baseCtx.restore();
      return;
    }

    const edges = this.data.edges;
    const step =
      edges.length > MAX_EDGES_BASE
        ? Math.ceil(edges.length / MAX_EDGES_BASE)
        : 1;

    const { visualEffectMode, useSquareBeats } = this.visualPreferences;
    let maxDistance = 0;
    if (visualEffectMode === "2") {
      for (const e of edges) {
        if (!e.deleted && e.distance > maxDistance) {
          maxDistance = e.distance;
        }
      }
    }

    if (visualEffectMode === "0") {
      // Edges are split into layers by source beat, one path each, so overlapping edges build up alpha.
      this.baseCtx.strokeStyle = this.theme.edgeStroke;
      for (let layer = 0; layer < EDGE_LAYERS; layer += 1) {
        let drawn = false;
        this.baseCtx.beginPath();
        for (let i = 0; i < edges.length; i += step) {
          const edge = edges[i];
          if (edge.deleted || edge.src.which % EDGE_LAYERS !== layer) {
            continue;
          }
          const from = this.positions[edge.src.which];
          const to = this.positions[edge.dest.which];
          if (!from || !to) {
            continue;
          }
          const geometry = this.getEdgeGeometry(edge);
          this.baseCtx.moveTo(from.x, from.y);
          if (geometry?.bend && geometry.control) {
            this.baseCtx.quadraticCurveTo(
              geometry.control[0],
              geometry.control[1],
              to.x,
              to.y
            );
          } else {
            this.baseCtx.lineTo(to.x, to.y);
          }
          drawn = true;
        }
        if (drawn) {
          this.baseCtx.stroke();
        }
      }
    } else {
      for (let i = 0; i < edges.length; i += step) {
        const edge = edges[i];
        if (edge.deleted) {
          continue;
        }
        const from = this.positions[edge.src.which];
        const to = this.positions[edge.dest.which];
        if (!from || !to) {
          continue;
        }
        if (visualEffectMode === "1") {
          const gradient = this.baseCtx.createLinearGradient(
            from.x,
            from.y,
            to.x,
            to.y
          );
          let hue1 = (edge.src.which / Math.max(1, this.positions.length)) * 360;
          let hue2 = (edge.dest.which / Math.max(1, this.positions.length)) * 360;
          if (Math.abs(hue1 - hue2) > 180) {
            if (hue1 < hue2) {
              hue1 += 360;
            } else {
              hue2 += 360;
            }
          }
          gradient.addColorStop(0, `hsla(${hue1 % 360}, 100%, 65%, 0.6)`);
          gradient.addColorStop(
            0.5,
            `hsla(${((hue1 + hue2) / 2) % 360}, 100%, 65%, 0.6)`
          );
          gradient.addColorStop(1, `hsla(${hue2 % 360}, 100%, 65%, 0.6)`);
          this.baseCtx.strokeStyle = gradient;
        } else if (visualEffectMode === "2") {
          const similarity =
            maxDistance > 0 ? 1 - edge.distance / maxDistance : 1;
          const hue = similarity * 140;
          this.baseCtx.strokeStyle = `hsla(${hue}, 100%, 50%, 0.7)`;
        } else if (visualEffectMode === "3") {
          this.baseCtx.strokeStyle = this.resolveEngineBeatColor(
            edge.src.which,
            0.6,
            this.theme.edgeStroke
          );
        } else {
          this.baseCtx.strokeStyle = this.resolvePitchBeatColor(
            edge.src.which,
            0.6,
            this.theme.edgeStroke
          );
        }
        const geometry = this.getEdgeGeometry(edge);
        this.baseCtx.beginPath();
        this.baseCtx.moveTo(from.x, from.y);
        if (geometry?.bend && geometry.control) {
          this.baseCtx.quadraticCurveTo(
            geometry.control[0],
            geometry.control[1],
            to.x,
            to.y
          );
        } else {
          this.baseCtx.lineTo(to.x, to.y);
        }
        this.baseCtx.stroke();
      }
    }

    const highlightedAnchorEdgeId =
      this.data.userAnchorEdgeId ??
      (this.anchorHighlightEnabled ? this.data.anchorEdgeId : null);
    if (highlightedAnchorEdgeId !== null) {
      for (const edge of edges) {
        if (edge.deleted || edge.id !== highlightedAnchorEdgeId) {
          continue;
        }
        this.drawEdge(this.baseCtx, edge, ANCHOR_HIGHLIGHT_COLOR, 1.8);
        break;
      }
    }

    if (!this.tileCanvas) {
      if (isMultiTrack && visualEffectMode === "0" && !useSquareBeats) {
        for (let i = 0; i < this.positions.length; i += 1) {
          const p = this.positions[i];
          this.baseCtx.fillStyle =
            this.data.beatColors?.[i] || this.theme.beatFill;
          this.baseCtx.beginPath();
          this.baseCtx.arc(p.x, p.y, BEAT_DOT_RADIUS_PX, 0, Math.PI * 2);
          this.baseCtx.fill();
        }
      } else if (visualEffectMode === "0" && !useSquareBeats) {
        this.baseCtx.fillStyle = this.theme.beatFill;
        this.baseCtx.beginPath();
        for (const p of this.positions) {
          this.baseCtx.moveTo(p.x + BEAT_DOT_RADIUS_PX, p.y);
          this.baseCtx.arc(p.x, p.y, BEAT_DOT_RADIUS_PX, 0, Math.PI * 2);
        }
        this.baseCtx.fill();
      } else {
        this.baseCtx.fillStyle = this.theme.beatFill;
        for (let i = 0; i < this.positions.length; i += 1) {
          if (visualEffectMode === "1") {
            this.baseCtx.fillStyle = `hsl(${(i / Math.max(1, this.positions.length)) * 360}, 100%, 65%)`;
          } else if (visualEffectMode === "2") {
            let bestDistance = maxDistance;
            for (const e of edges) {
              if (!e.deleted && e.src.which === i && e.distance < bestDistance) {
                bestDistance = e.distance;
              }
            }
            const similarity =
              maxDistance > 0 ? 1 - bestDistance / maxDistance : 1;
            const hue = similarity * 140;
            this.baseCtx.fillStyle = `hsla(${hue}, 100%, 65%, 0.8)`;
          } else if (visualEffectMode === "3") {
            this.baseCtx.fillStyle = this.resolveEngineBeatColor(
              i,
              1,
              this.theme.beatFill
            );
          } else if (visualEffectMode === "4") {
            this.baseCtx.fillStyle = this.resolvePitchBeatColor(
              i,
              1,
              this.theme.beatFill
            );
          }
          const p = this.positions[i];
          if (useSquareBeats) {
            this.baseCtx.save();
            this.baseCtx.translate(p.x, p.y);
            const angle = Math.atan2(p.y - this.center.y, p.x - this.center.x);
            this.baseCtx.rotate(angle);
            this.baseCtx.fillRect(-2, -2, 4, 4);
            this.baseCtx.restore();
          } else {
            this.baseCtx.beginPath();
            this.baseCtx.arc(p.x, p.y, BEAT_DOT_RADIUS_PX, 0, Math.PI * 2);
            this.baseCtx.fill();
          }
        }
      }
    }
    this.baseCtx.restore();
  }

  private drawTiles() {
    if (!this.tileCtx || !this.data || !this.visible) {
      return;
    }
    const { beatVisits: visits } = this.data;
    this.paintedVisits = [...visits];
    this.tileScale = resolveTileScale(visits.reduce((max, n) => Math.max(max, n), 0));
    this.tileCtx.clearRect(0, 0, this.size.width, this.size.height);
    for (let i = 0; i < visits.length; i += 1) {
      this.paintTile(this.tileCtx, i, this.resolveTileColor(i));
    }
  }

  // Repaints only tiles whose count changed, unless the scale moved, which resizes every tile.
  private syncTiles() {
    if (!this.tileCtx || !this.data || !this.visible) {
      return;
    }
    const { beatVisits: visits } = this.data;
    const changed: number[] = [];
    let maxVisits = 0;
    for (let i = 0; i < visits.length; i += 1) {
      maxVisits = Math.max(maxVisits, visits[i]);
      if (visits[i] !== this.paintedVisits[i]) {
        changed.push(i);
      }
    }
    if (resolveTileScale(maxVisits) !== this.tileScale) {
      this.drawTiles();
      return;
    }
    for (const index of changed) {
      if (visits[index] < this.paintedVisits[index]) {
        this.eraseTile(this.tileCtx, index);
      }
      this.paintTile(this.tileCtx, index, this.resolveTileColor(index));
      this.paintedVisits[index] = visits[index];
    }
  }

  private tileLevel(index: number) {
    const visits = this.data?.beatVisits[index] ?? 0;
    if (visits === 0) {
      return 0;
    }
    return ((visits + TILE_BASE_STEPS) * this.tileScale) / TILE_MAX_STEPS;
  }

  private tileHeight(level: number) {
    return Math.min(this.size.width, this.size.height) * TILE_MAX_HEIGHT_RATIO * level;
  }

  private paintTile(ctx: CanvasRenderingContext2D, index: number, color: string) {
    this.strokeTile(ctx, index, this.tileHeight(this.tileLevel(index)), color);
  }

  // A tile that shrinks has to be removed first, since painting only covers its new length.
  private eraseTile(ctx: CanvasRenderingContext2D, index: number) {
    ctx.globalCompositeOperation = "destination-out";
    this.strokeTile(ctx, index, this.tileHeight(1), "#000");
    ctx.globalCompositeOperation = "source-over";
  }

  // Tiles span at least the beat dot's diameter, centered on the ring, or their own width when
  // wider. Round caps extend past the line ends, so the line is inset to stay within that span.
  private strokeTile(
    ctx: CanvasRenderingContext2D,
    index: number,
    height: number,
    color: string,
    minWidthPx = 0,
  ) {
    const count = this.positions.length;
    const slot = (Math.PI * 2) / count;
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const radius = Math.min(this.size.width, this.size.height) * CLASSIC_RADIUS_RATIO;
    const width = Math.min(
      Math.max(slot * radius, minWidthPx),
      Math.min(this.size.width, this.size.height) * TILE_MAX_WIDTH_RATIO,
    );
    const cap = width / 2;
    const start = Math.min(radius, radius - BEAT_DOT_RADIUS_PX + cap);
    const end = Math.max(
      start + TILE_MIN_LINE_LENGTH_PX,
      radius + Math.max(height, BEAT_DOT_RADIUS_PX) - cap,
    );
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(
      this.center.x + Math.cos(angle) * start,
      this.center.y + Math.sin(angle) * start,
    );
    ctx.lineTo(
      this.center.x + Math.cos(angle) * end,
      this.center.y + Math.sin(angle) * end,
    );
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  // Marks the current or hovered beat on the overlay, so the tile layer only changes on visits.
  private drawTileMarker(index: number, color: string) {
    this.strokeTile(
      this.overlayCtx,
      index,
      this.tileHeight(1),
      color,
      TILE_MARKER_MIN_WIDTH_PX,
    );
  }

  // The band runs from the beat ring to full tile height, so short tiles stay easy to hit.
  private tileIndexAt(x: number, y: number) {
    const count = this.positions.length;
    if (count === 0) {
      return null;
    }
    const radius = Math.min(this.size.width, this.size.height) * CLASSIC_RADIUS_RATIO;
    const distance = Math.hypot(x - this.center.x, y - this.center.y);
    if (
      distance < radius - BEAT_SELECT_RADIUS_PX ||
      distance > radius + this.tileHeight(1)
    ) {
      return null;
    }
    const turn =
      (Math.atan2(y - this.center.y, x - this.center.x) + Math.PI / 2) / (Math.PI * 2);
    return Math.round((turn + 1) * count) % count;
  }

  private beatIndexAt(x: number, y: number) {
    if (this.tileCanvas) {
      return this.tileIndexAt(x, y);
    }
    if (this.matrixMode && this.positions.length > 0) {
      const bounds = getMatrixBounds(this.size.width, this.size.height);
      if (
        bounds.side > 0 &&
        x >= bounds.left &&
        x <= bounds.left + bounds.side &&
        y >= bounds.top &&
        y <= bounds.top + bounds.side
      ) {
        if (this.positions.length === 1) {
          return 0;
        }
        const ratio = (x - bounds.left) / bounds.side;
        return Math.max(
          0,
          Math.min(
            this.positions.length - 1,
            Math.round(ratio * (this.positions.length - 1)),
          ),
        );
      }
    }
    let bestIndex: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.positions.length; i += 1) {
      const p = this.positions[i];
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    return bestDist <= BEAT_SELECT_RADIUS_PX ? bestIndex : null;
  }

  private drawBeatCursor(point: Point, color: string, index?: number) {
    this.overlayCtx.fillStyle = color;
    if (
      this.visualPreferences.useAltSeekShape &&
      index !== undefined &&
      this.positions.length > 0
    ) {
      const nextIndex =
        index + 1 < this.positions.length ? index + 1 : index;
      const next = this.positions[nextIndex];
      const angle = next
        ? Math.atan2(next.y - point.y, next.x - point.x)
        : 0;
      this.overlayCtx.save();
      this.overlayCtx.translate(point.x, point.y);
      this.overlayCtx.rotate(angle);
      this.overlayCtx.fillRect(-2, -10, 4, 20);
      this.overlayCtx.restore();
      return;
    }
    this.overlayCtx.beginPath();
    this.overlayCtx.arc(point.x, point.y, BEAT_CURSOR_RADIUS_PX, 0, Math.PI * 2);
    this.overlayCtx.fill();
  }

  private drawOverlay() {
    const { width, height } = this.size;
    this.cancelOverlayAnimation();
    this.overlayCtx.clearRect(0, 0, width, height);
    if (!this.data || !this.visible) {
      return;
    }
    const now = performance.now();
    const hasAnimatedLookahead =
      this.predictedJumps.length > 0 && !this.prefersReducedMotion();
    if (this.predictedJumps.length > 0) {
      this.drawPredictedJumps(now);
    }
    if (this.selectedEdge && !this.selectedEdge.deleted) {
      this.drawEdge(
        this.overlayCtx,
        this.selectedEdge,
        this.theme.edgeSelected,
        2.5
      );
      if (this.matrixMode) {
        const cell = this.getMatrixCellPoint(
          this.selectedEdge.src.which,
          this.selectedEdge.dest.which,
        );
        if (cell) {
          this.overlayCtx.fillStyle = this.theme.edgeSelected;
          this.overlayCtx.beginPath();
          this.overlayCtx.arc(cell.x, cell.y, 4.5, 0, Math.PI * 2);
          this.overlayCtx.fill();
        }
      }
    }
    if (this.anchorEdit) {
      this.drawAnchorEditor(this.anchorEdit);
    }
    if (this.hoveredBeat !== null) {
      if (this.matrixMode) {
        this.drawMatrixCrosshair(
          this.hoveredBeat,
          this.resolveBeatHighlightColor(0.25),
          this.theme.beatHighlight,
        );
      } else {
        for (const edge of this.data.beats[this.hoveredBeat].neighbors) {
          if (!edge.deleted) {
            this.drawEdge(
              this.overlayCtx,
              edge,
              this.theme.beatHighlight,
              HOVER_BRANCH_LINE_WIDTH_PX,
            );
          }
        }
      }
      const hoverColor = this.resolveBeatHighlightColor(BEAT_HOVER_ALPHA);
      if (this.tileCanvas) {
        this.drawTileMarker(this.hoveredBeat, hoverColor);
      } else {
        this.drawBeatCursor(this.positions[this.hoveredBeat], hoverColor);
      }
    }
    if (this.currentIndex < 0) {
      if (hasAnimatedLookahead) {
        this.scheduleOverlayFrame();
      }
      return;
    }
    const current = this.positions[this.currentIndex];
    if (current) {
      if (this.matrixMode) {
        this.drawMatrixCrosshair(
          this.currentIndex,
          this.resolveBeatHighlightColor(0.35),
          this.theme.beatHighlight,
        );
      }
      let cursorColor = this.theme.beatHighlight;
      if (this.visualPreferences.visualEffectMode === "1") {
        const progress =
          this.currentIndex / Math.max(1, this.positions.length);
        cursorColor = `hsl(${progress * 360}, 100%, 70%)`;
      } else if (
        this.visualPreferences.visualEffectMode === "3" &&
        !this.tileCanvas
      ) {
        // Keep Classic's tile marker in the theme highlight so it stays visible
        // over full-height tiles already painted with the same beat color.
        cursorColor = this.resolveEngineBeatColor(
          this.currentIndex,
          1,
          this.theme.beatHighlight
        );
      } else if (
        this.visualPreferences.visualEffectMode === "4" &&
        !this.tileCanvas
      ) {
        cursorColor = this.resolvePitchBeatColor(
          this.currentIndex,
          1,
          this.theme.beatHighlight
        );
      }
      if (this.tileCanvas) {
        this.drawTileMarker(this.currentIndex, cursorColor);
      } else {
        this.drawBeatCursor(current, cursorColor, this.currentIndex);
      }
    }
    let fadeDelayMs: number | null = null;
    if (this.jumpLine) {
      const age = now - this.jumpLine.at;
      const step = Math.floor((age * JUMP_FADE_STEPS) / JUMP_FADE_MS);
      if (step < JUMP_FADE_STEPS) {
        const from = this.positions[this.jumpLine.from];
        const to = this.positions[this.jumpLine.to];
        if (from && to) {
          const jumpColor = this.jumpFadeColors[step];
          if (this.matrixMode) {
            // Highlight the jump as a crisp L-path through the (to.x, from.y) cell.
            this.overlayCtx.strokeStyle = jumpColor;
            this.overlayCtx.lineWidth = 2;
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(from.x, from.y);
            this.overlayCtx.lineTo(to.x, from.y);
            this.overlayCtx.lineTo(to.x, to.y);
            this.overlayCtx.stroke();
            this.overlayCtx.fillStyle = jumpColor;
            this.overlayCtx.beginPath();
            this.overlayCtx.arc(to.x, from.y, 4, 0, Math.PI * 2);
            this.overlayCtx.fill();
          } else if (this.jumpLine.control) {
            this.drawBentLineWithControl(
              this.overlayCtx,
              from,
              to,
              this.jumpLine.control,
              jumpColor,
              2
            );
          } else {
            this.overlayCtx.strokeStyle = jumpColor;
            this.overlayCtx.lineWidth = 2;
            this.overlayCtx.beginPath();
            this.overlayCtx.moveTo(from.x, from.y);
            this.overlayCtx.lineTo(to.x, to.y);
            this.overlayCtx.stroke();
          }
        }
        fadeDelayMs = ((step + 1) * JUMP_FADE_MS) / JUMP_FADE_STEPS - age;
      } else {
        this.jumpLine = null;
      }
    }
    const scheduledRaf = hasAnimatedLookahead
      ? this.scheduleOverlayFrame()
      : false;
    if (!scheduledRaf && fadeDelayMs !== null) {
      this.requestOverlayAnimation(fadeDelayMs);
    }
  }

  /**
   * Renders predicted upcoming jumps back-to-front as soft flowing ROYGBIV pipes
   * (1st = Red, 2nd = Orange, 3rd = Yellow, ...).
   */
  private drawPredictedJumps(now: number) {
    const ctx = this.overlayCtx;
    const isLightTheme =
      typeof document !== "undefined" &&
      Boolean(document.body?.classList?.contains("theme-light"));
    const timeSec = this.prefersReducedMotion() ? 0 : now / 1000;

    const coreWidth = 3.2;
    const glowWidth = coreWidth * 2.8;
    const pulseWidth = coreWidth * 0.48;
    const flowSpeed = 52;

    for (let rank = this.predictedJumps.length - 1; rank >= 0; rank -= 1) {
      const jump = this.predictedJumps[rank];
      const from = this.positions[jump.fromIndex];
      const to = this.positions[jump.toIndex];
      if (!from || !to || (from.x === to.x && from.y === to.y)) {
        continue;
      }
      const control = this.predictedJumpControls[rank] ?? null;
      const colorCount = PREDICTED_JUMP_RAINBOW_HUES.length;
      const rawSequenceIndex = jump.sequenceIndex ?? rank;
      const colorIndex =
        ((rawSequenceIndex % colorCount) + colorCount) % colorCount;
      const hue = PREDICTED_JUMP_RAINBOW_HUES[colorIndex];

      const buildPipeStroke = (
        baseLightness: number,
        lightnessBoost: number,
        saturation: number,
        baseAlpha: number,
      ): string | CanvasGradient => {
        if (typeof ctx.createLinearGradient === "function") {
          const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
          for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
            // Subtracting time shifts the brightness pulse forward from takeoff to landing.
            const wave =
              0.5 + 0.5 * Math.sin(stop * Math.PI * 2 - timeSec * 4.2);
            const stopLightness = Math.min(
              96,
              baseLightness + wave * lightnessBoost,
            );
            const stopAlpha = Math.min(1, baseAlpha * (0.78 + 0.22 * wave));
            gradient.addColorStop(
              stop,
              `hsla(${hue}, ${saturation}%, ${stopLightness.toFixed(1)}%, ${stopAlpha.toFixed(3)})`,
            );
          }
          return gradient;
        }
        return `hsla(${hue}, ${saturation}%, ${baseLightness}%, ${baseAlpha})`;
      };

      const tracePath = () => {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        if (control) {
          ctx.quadraticCurveTo(control[0], control[1], to.x, to.y);
        } else {
          ctx.lineTo(to.x, to.y);
        }
      };

      const chordLen = Math.hypot(to.x - from.x, to.y - from.y);
      const approxLen = control
        ? (chordLen +
            Math.hypot(control[0] - from.x, control[1] - from.y) +
            Math.hypot(to.x - control[0], to.y - control[1])) *
          0.5
        : chordLen;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Pass 1: soft outer halo sleeve in the branch's assigned ROYGBIV hue.
      const glowLightness = isLightTheme ? (hue === 50 ? 46 : 52) : 60;
      ctx.strokeStyle = buildPipeStroke(
        glowLightness,
        8,
        96,
        isLightTheme ? 0.18 : 0.24,
      );
      ctx.lineWidth = glowWidth;
      tracePath();
      ctx.stroke();

      // Pass 2: soft flowing pipe body in the branch's assigned ROYGBIV hue.
      const coreLightness = isLightTheme ? (hue === 50 ? 44 : 48) : 58;
      ctx.strokeStyle = buildPipeStroke(
        coreLightness,
        isLightTheme ? 10 : 14,
        95,
        isLightTheme ? 0.9 : 0.86,
      );
      ctx.lineWidth = coreWidth;
      tracePath();
      ctx.stroke();

      // Pass 3: flowing luminous inner stream gliding from jump source to destination.
      if (typeof ctx.setLineDash === "function") {
        const dashLen = Math.max(10, Math.min(26, approxLen * 0.14));
        const gapLen = dashLen * 1.45;
        const cycle = dashLen + gapLen;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = -((timeSec * flowSpeed) % cycle);
        ctx.strokeStyle = buildPipeStroke(
          isLightTheme ? 92 : 86,
          6,
          100,
          isLightTheme ? 0.85 : 0.8,
        );
        ctx.lineWidth = pulseWidth;
        tracePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Endpoint beads clarify takeoff and landing positions in the branch color.
      ctx.fillStyle = `hsla(${hue}, 95%, ${isLightTheme ? 48 : 66}%, ${isLightTheme ? 0.88 : 0.82})`;
      ctx.beginPath();
      ctx.arc(from.x, from.y, coreWidth * 0.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `hsla(${hue}, 100%, ${isLightTheme ? 54 : 78}%, ${isLightTheme ? 0.96 : 0.94})`;
      ctx.beginPath();
      ctx.arc(to.x, to.y, coreWidth * 0.95, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private scheduleOverlayFrame(): boolean {
    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      this.overlayRafId = window.requestAnimationFrame(() => {
        this.overlayRafId = null;
        this.drawOverlay();
      });
      return true;
    }
    return false;
  }

  // Redraws the overlay at the next fade step boundary.
  private requestOverlayAnimation(delayMs: number) {
    this.overlayTimerId = window.setTimeout(() => {
      this.overlayTimerId = null;
      this.drawOverlay();
    }, Math.ceil(delayMs));
  }

  private cancelOverlayAnimation() {
    if (this.overlayTimerId !== null) {
      window.clearTimeout(this.overlayTimerId);
      this.overlayTimerId = null;
    }
    if (this.overlayRafId !== null) {
      if (
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(this.overlayRafId);
      }
      this.overlayRafId = null;
    }
  }

  private resolveBeatHighlightColor(alpha: number) {
    if (this.theme.beatHighlightRgb) {
      const { r, g, b } = this.theme.beatHighlightRgb;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return this.theme.beatHighlight;
  }

  private drawAnchorEditor(state: AnchorEditState) {
    const from = this.positions[state.src];
    const to = this.positions[state.dest];
    if (!from || !to) {
      return;
    }
    const ctx = this.overlayCtx;
    const beats = this.data?.beats;
    const lineColor =
      beats?.[state.src] && beats[state.dest]
        ? ANCHOR_MATCH_COLORS[beatPairMatch(beats[state.src], beats[state.dest]).quality]
        : ANCHOR_HIGHLIGHT_COLOR;
    const geometry = this.resolveEdgeGeometry(null, from, to, state.src, state.dest);
    if (geometry.bend && geometry.control) {
      this.drawBentLineWithControl(ctx, from, to, geometry.control, lineColor, 3);
    } else {
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    // The arrowhead marks the landing end, along the curve's final tangent, tip at the handle edge.
    const tail = geometry.control ? { x: geometry.control[0], y: geometry.control[1] } : from;
    const angle = Math.atan2(to.y - tail.y, to.x - tail.x);
    const tipX = to.x - Math.cos(angle) * (ANCHOR_HANDLE_RADIUS_PX + 1);
    const tipY = to.y - Math.sin(angle) * (ANCHOR_HANDLE_RADIUS_PX + 1);
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    for (const side of [-1, 1]) {
      ctx.lineTo(
        tipX - Math.cos(angle + side * 0.45) * ANCHOR_ARROW_LENGTH_PX,
        tipY - Math.sin(angle + side * 0.45) * ANCHOR_ARROW_LENGTH_PX,
      );
    }
    ctx.fill();
    const ends: Array<[CustomAnchorEnd, Point, string]> = [
      ["src", from, ANCHOR_HIGHLIGHT_COLOR],
      ["dest", to, this.theme.beatHighlight],
    ];
    for (const [end, point, color] of ends) {
      if (end === state.active) {
        ctx.strokeStyle = this.theme.beatHighlight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, ANCHOR_ACTIVE_RING_RADIUS_PX, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, ANCHOR_HANDLE_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private pointerPosition(event: { clientX: number; clientY: number }): Point {
    const rect = this.overlayCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private anchorHandleAt(point: Point, pointerType: string): CustomAnchorEnd | null {
    if (!this.anchorEdit) {
      return null;
    }
    const radius =
      pointerType === "mouse" ? ANCHOR_HANDLE_HIT_MOUSE_PX : ANCHOR_HANDLE_HIT_TOUCH_PX;
    let best: CustomAnchorEnd | null = null;
    let bestDist = radius;
    for (const end of ["src", "dest"] as const) {
      const p = this.positions[this.anchorEdit[end]];
      const d = p ? Math.hypot(p.x - point.x, p.y - point.y) : Infinity;
      if (d <= bestDist) {
        bestDist = d;
        best = end;
      }
    }
    return best;
  }

  // Snaps to the nearest beat with no radius limit, so a drag never loses its handle.
  private nearestBeatIndex(point: Point): number | null {
    let bestIndex: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.positions.length; i += 1) {
      const p = this.positions[i];
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.anchorEdit || !this.data || !this.visible || this.anchorDrag) {
      return;
    }
    const end = this.anchorHandleAt(this.pointerPosition(event), event.pointerType);
    if (!end) {
      return;
    }
    event.preventDefault();
    try {
      this.overlayCanvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best effort; the drag still works while the pointer stays on the canvas.
    }
    this.anchorDrag = { pointerId: event.pointerId, origin: { ...this.anchorEdit } };
    this.anchorEdit = { ...this.anchorEdit, active: end };
    this.overlayCanvas.style.cursor = "grabbing";
    this.drawOverlay();
    this.onAnchorEditChange?.({ ...this.anchorEdit });
  };

  // A touch on a handle must not scroll the page; a swipe anywhere else still does.
  private readonly handleTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (
      this.anchorEdit &&
      this.visible &&
      touch &&
      this.anchorHandleAt(this.pointerPosition(touch), "touch")
    ) {
      event.preventDefault();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (!this.anchorDrag || event.pointerId !== this.anchorDrag.pointerId || !this.anchorEdit) {
      return;
    }
    this.releaseAnchorPointer(event.pointerId);
    this.anchorDrag = null;
    this.overlayCanvas.style.cursor = "grab";
    this.onAnchorEditCommit?.({ ...this.anchorEdit });
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (this.anchorDrag && event.pointerId === this.anchorDrag.pointerId) {
      this.releaseAnchorPointer(event.pointerId);
      this.cancelAnchorDrag();
    }
  };

  private releaseAnchorPointer(pointerId: number) {
    try {
      this.overlayCanvas.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone.
    }
  }

  private cancelAnchorDrag() {
    if (!this.anchorDrag) {
      return;
    }
    const origin = this.anchorDrag.origin;
    this.anchorDrag = null;
    this.anchorEdit = { ...origin };
    this.overlayCanvas.style.cursor = "";
    this.drawOverlay();
    this.onAnchorEditChange?.({ ...origin });
  }

  private moveAnchorDrag(event: PointerEvent) {
    const state = this.anchorEdit;
    if (!state || !this.data) {
      return;
    }
    const index = this.nearestBeatIndex(this.pointerPosition(event));
    if (index === null) {
      return;
    }
    const next = moveCustomAnchorEnd(this.data.beats.length, state, state.active, index);
    if (next.src === state.src && next.dest === state.dest) {
      return;
    }
    this.anchorEdit = { ...next, active: state.active };
    this.drawOverlay();
    this.onAnchorEditChange?.({ ...this.anchorEdit });
  }

  private readonly handleCanvasClick = (event: MouseEvent) => {
    if (!this.data || !this.visible || this.anchorEdit) {
      return;
    }
    const rect = this.overlayCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // In Matrix mode, clicking an off-diagonal branch cell takes priority over
    // seeking inside the matrix square.
    if (this.matrixMode && this.onEdgeSelect) {
      const bestCellEdge = this.findNearestEdgeAt(x, y, EDGE_SELECT_RADIUS_PX);
      if (bestCellEdge) {
        const nextEdge = this.selectedEdge === bestCellEdge ? null : bestCellEdge;
        this.onEdgeSelect(nextEdge);
        return;
      }
    }
    if (this.onSelect) {
      const beatIndex = this.beatIndexAt(x, y);
      if (beatIndex !== null) {
        if (this.onEdgeSelect && this.selectedEdge) {
          this.onEdgeSelect(null);
        }
        this.onSelect(beatIndex);
        return;
      }
    }
    if (this.onEdgeSelect) {
      const bestEdge = this.findNearestEdgeAt(x, y, EDGE_SELECT_RADIUS_PX);
      if (bestEdge) {
        const nextEdge = this.selectedEdge === bestEdge ? null : bestEdge;
        this.onEdgeSelect(nextEdge);
        return;
      }
      if (this.selectedEdge) {
        this.onEdgeSelect(null);
      }
    }
  };

  /**
   * Finds the nearest active edge to `(x, y)` within `thresholdPx`, matching
   * off-diagonal branch cells in Matrix mode or edge curves otherwise.
   */
  private findNearestEdgeAt(
    x: number,
    y: number,
    thresholdPx: number,
  ): Edge | null {
    if (!this.data) {
      return null;
    }
    let bestEdge: Edge | null = null;
    let bestEdgeDist = Infinity;
    for (const edge of this.data.edges) {
      if (edge.deleted) {
        continue;
      }
      const from = this.positions[edge.src.which];
      const to = this.positions[edge.dest.which];
      if (!from || !to) {
        continue;
      }
      let dist: number;
      if (this.matrixMode) {
        dist = Math.hypot(x - to.x, y - from.y);
      } else {
        const geometry = this.getEdgeGeometry(edge);
        if (!geometry) {
          continue;
        }
        dist =
          geometry.bend && geometry.control
            ? distanceToQuadratic(
                { x, y },
                from,
                { x: geometry.control[0], y: geometry.control[1] },
                to,
              )
            : distanceToSegment(x, y, from.x, from.y, to.x, to.y);
      }
      if (dist < bestEdgeDist) {
        bestEdgeDist = dist;
        bestEdge = edge;
      }
    }
    return bestEdge && bestEdgeDist <= thresholdPx ? bestEdge : null;
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.data || !this.visible) {
      return;
    }
    if (this.anchorDrag) {
      if (event.pointerId === this.anchorDrag.pointerId) {
        this.moveAnchorDrag(event);
      }
      return;
    }
    if (this.anchorEdit) {
      const over = this.anchorHandleAt(this.pointerPosition(event), event.pointerType);
      this.overlayCanvas.style.cursor = over ? "grab" : "";
      return;
    }
    if (event.pointerType === "touch") {
      this.setHoveredBeat(null);
      return;
    }
    const rect = this.overlayCanvas.getBoundingClientRect();
    this.setHoveredBeat(
      this.beatIndexAt(event.clientX - rect.left, event.clientY - rect.top),
    );
  };

  private readonly handlePointerLeave = () => {
    this.setHoveredBeat(null);
  };

  private clearHoveredBeat() {
    this.hoveredBeat = null;
    this.overlayCanvas.style.cursor = "";
  }

  private setHoveredBeat(index: number | null) {
    if (index === this.hoveredBeat) {
      return;
    }
    this.hoveredBeat = index;
    this.overlayCanvas.style.cursor = index === null ? "" : "pointer";
    this.drawOverlay();
  }

  private drawEdge(
    ctx: CanvasRenderingContext2D,
    edge: Edge,
    color: string,
    lineWidth: number
  ) {
    const from = this.positions[edge.src.which];
    const to = this.positions[edge.dest.which];
    if (!from || !to) {
      return;
    }
    const geometry = this.getEdgeGeometry(edge);
    if (geometry?.bend && geometry.control) {
      this.drawBentLineWithControl(ctx, from, to, geometry.control, color, lineWidth);
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  private getEdgeGeometry(
    edge: Edge
  ): { bend: boolean; control: [number, number] | null } | null {
    const cached = this.edgeGeometry.get(edge);
    if (cached) {
      return cached;
    }
    const from = this.positions[edge.src.which];
    const to = this.positions[edge.dest.which];
    if (!from || !to) {
      return null;
    }
    const next = this.resolveEdgeGeometry(
      edge,
      from,
      to,
      edge.src.which,
      edge.dest.which
    );
    this.edgeGeometry.set(edge, next);
    return next;
  }

  private resolveEdgeGeometry(
    edge: Edge | null,
    from: { x: number; y: number },
    to: { x: number; y: number },
    fromIndex: number,
    toIndex: number
  ): { bend: boolean; control: [number, number] | null } {
    if (!this.data) {
      return { bend: false, control: null };
    }
    if (this.edgeControlPointResolver) {
      return {
        bend: true,
        control: this.edgeControlPointResolver({
          edge,
          from,
          to,
          fromIndex,
          toIndex,
          data: this.data,
          center: this.center,
        }),
      };
    }
    const bend = this.shouldBendEdge(from, to, fromIndex, toIndex);
    return {
      bend,
      control: bend ? this.getBendControlPoint(from, to) : null,
    };
  }

  // Control point of the jump line, or null for a straight line.
  private resolveJumpControl(fromIndex: number, toIndex: number) {
    const from = this.positions[fromIndex];
    const to = this.positions[toIndex];
    return from && to ? this.resolveEdgeGeometry(null, from, to, fromIndex, toIndex).control : null;
  }

  private shouldBendEdge(
    from: { x: number; y: number },
    to: { x: number; y: number },
    fromIndex?: number,
    toIndex?: number
  ) {
    if (this.forceBendEdges) {
      return true;
    }
    if (fromIndex !== undefined && toIndex !== undefined) {
      const min = Math.min(fromIndex, toIndex);
      const max = Math.max(fromIndex, toIndex);
      const key = `${min}:${max}`;
      const cached = this.bendCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const computed = this.computeShouldBend(from, to);
      this.bendCache.set(key, computed);
      return computed;
    }
    return this.computeShouldBend(from, to);
  }

  private computeShouldBend(from: { x: number; y: number }, to: { x: number; y: number }) {
    const step = Math.max(1, Math.ceil(this.positions.length / MAX_EDGE_SAMPLES));
    for (let i = 0; i < this.positions.length; i += step) {
      const p = this.positions[i];
      if (!p) {
        continue;
      }
      if ((p.x === from.x && p.y === from.y) || (p.x === to.x && p.y === to.y)) {
        continue;
      }
      const dist = distanceToSegment(p.x, p.y, from.x, from.y, to.x, to.y);
      if (dist <= BEAT_AVOID_RADIUS_PX) {
        return true;
      }
    }
    return false;
  }

  private drawBentLineWithControl(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
    control: [number, number],
    color: string,
    lineWidth: number
  ) {
    const [cx, cy] = control;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.stroke();
  }

  private getBendControlPoint(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): [number, number] {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const dirX = this.center.x - mid.x;
    const dirY = this.center.y - mid.y;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen === 0) {
      return [mid.x, mid.y];
    }
    const normX = dirX / dirLen;
    const normY = dirY / dirLen;
    const centerDist = Math.hypot(this.center.x - mid.x, this.center.y - mid.y);
    return [
      mid.x + normX * (centerDist * 0.5),
      mid.y + normY * (centerDist * 0.5),
    ];
  }

  /**
   * Renders horizontal timeline rails and song labels for stacked multi-track playback.
   */
  private drawMultiTrackLanes() {
    const tracks = this.data?.tracks;
    if (!tracks || tracks.length < 2) {
      return;
    }
    const ctx = this.baseCtx;
    ctx.save();
    for (const track of tracks) {
      if (track.beatCount <= 0) {
        continue;
      }
      const startPos = this.positions[track.startBeatIndex];
      const endPos =
        this.positions[track.startBeatIndex + track.beatCount - 1];
      if (!startPos || !endPos) {
        continue;
      }
      ctx.strokeStyle = this.theme.edgeStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startPos.x, startPos.y);
      ctx.lineTo(endPos.x, endPos.y);
      ctx.stroke();

      const labelParts: string[] = [];
      labelParts.push(
        track.title?.trim() || `Track ${track.trackIndex + 1}`,
      );
      if (typeof track.tempo === "number" && Number.isFinite(track.tempo)) {
        labelParts.push(`${Math.round(track.tempo)} BPM`);
      }
      if (typeof ctx.fillText === "function") {
        ctx.fillStyle = this.theme.beatHighlight;
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText(labelParts.join(" · "), startPos.x, startPos.y - 12);
      }
    }
    ctx.restore();
  }

  /**
   * Resolves the matrix cell coordinate `(colBeat.x, rowBeat.y)` for a pair of beats.
   */
  private getMatrixCellPoint(rowBeat: number, colBeat: number): Point | null {
    const rowPos = this.positions[rowBeat];
    const colPos = this.positions[colBeat];
    if (!rowPos || !colPos) {
      return null;
    }
    return { x: colPos.x, y: rowPos.y };
  }

  /**
   * Resolves the color of a beat or edge under the active `visualEffectMode`.
   */
  private resolveModeBeatColor(
    beatIndex: number,
    alpha: number,
    fallback: string,
    similarityRatio = 1,
  ): string {
    const mode = this.visualPreferences.visualEffectMode;
    if (mode === "1") {
      const hue = (beatIndex / Math.max(1, this.positions.length)) * 360;
      return `hsla(${hue}, 100%, 65%, ${alpha})`;
    }
    if (mode === "2") {
      const hue = similarityRatio * 140;
      return `hsla(${hue}, 100%, 55%, ${alpha})`;
    }
    if (mode === "3") {
      return this.resolveEngineBeatColor(beatIndex, alpha, fallback);
    }
    if (mode === "4") {
      return this.resolvePitchBeatColor(beatIndex, alpha, fallback);
    }
    return fallback;
  }

  /**
   * Draws the Self-Similarity Matrix base layer: frame, similarity heatmap,
   * section gridlines, diagonal beats, and off-diagonal branch dots.
   */
  private drawMatrixBase(width: number, height: number) {
    if (!this.data) {
      return;
    }
    const bounds = getMatrixBounds(width, height);
    if (bounds.side <= 0) {
      return;
    }
    const ctx = this.baseCtx;
    const { left, top, side } = bounds;
    const { visualEffectMode, useSquareBeats } = this.visualPreferences;
    const edges = this.data.edges;
    const count = this.positions.length;

    let maxDistance = 0;
    for (const e of edges) {
      if (!e.deleted && e.distance > maxDistance) {
        maxDistance = e.distance;
      }
    }

    // 1. Heatmap cells from downsampled chroma + timbre self-similarity.
    if (this.matrixGrid && typeof ctx.fillRect === "function") {
      const { size, values, repBeats } = this.matrixGrid;
      const cellSize = side / size;
      const drawSize = Math.max(1, Math.ceil(cellSize));
      const baseRgb = this.theme.beatHighlightRgb;

      for (let r = 0; r < size; r += 1) {
        const repBeat = repBeats[r];
        for (let c = 0; c < size; c += 1) {
          const intensity = values[r * size + c];
          if (intensity <= 0.08) {
            continue;
          }
          const alpha = intensity * (visualEffectMode === "2" ? 0.6 : 0.55);
          if (visualEffectMode === "0") {
            ctx.fillStyle = baseRgb
              ? `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${(intensity * 0.42).toFixed(3)})`
              : `rgba(74, 199, 255, ${(intensity * 0.42).toFixed(3)})`;
          } else {
            const fallback = baseRgb
              ? `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${alpha.toFixed(3)})`
              : `rgba(74, 199, 255, ${alpha.toFixed(3)})`;
            ctx.fillStyle = this.resolveModeBeatColor(
              repBeat,
              alpha,
              fallback,
              intensity,
            );
          }
          ctx.fillRect(
            left + c * cellSize,
            top + r * cellSize,
            drawSize,
            drawSize,
          );
        }
      }
    }

    // 2. Square frame, main diagonal, and faint section boundary hairlines.
    ctx.strokeStyle = this.theme.edgeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + side, top);
    ctx.lineTo(left + side, top + side);
    ctx.lineTo(left, top + side);
    ctx.lineTo(left, top);
    ctx.moveTo(left, top);
    ctx.lineTo(left + side, top + side);

    let prevSection = this.data.beats[0]?.parent?.parent ?? null;
    for (let i = 1; i < count; i += 1) {
      const sec = this.data.beats[i]?.parent?.parent ?? null;
      if (sec !== null && sec !== prevSection) {
        const pos = this.positions[i];
        if (pos) {
          ctx.moveTo(left, pos.y);
          ctx.lineTo(left + side, pos.y);
          ctx.moveTo(pos.x, top);
          ctx.lineTo(pos.x, top + side);
        }
      }
      prevSection = sec;
    }
    ctx.stroke();

    // 3. Plot non-deleted branch edges at their off-diagonal cell `(to.x, from.y)`.
    const dotRadius = Math.max(
      1.8,
      Math.min(3.5, (side / Math.max(40, count)) * 1.4),
    );
    const step =
      edges.length > MAX_EDGES_BASE
        ? Math.ceil(edges.length / MAX_EDGES_BASE)
        : 1;
    for (let i = 0; i < edges.length; i += step) {
      const edge = edges[i];
      if (edge.deleted) {
        continue;
      }
      const cell = this.getMatrixCellPoint(edge.src.which, edge.dest.which);
      if (!cell) {
        continue;
      }
      const similarity =
        maxDistance > 0 ? 1 - edge.distance / maxDistance : 1;
      const fallback = this.resolveBeatHighlightColor(0.8);
      ctx.fillStyle =
        visualEffectMode === "0"
          ? fallback
          : this.resolveModeBeatColor(edge.src.which, 0.85, fallback, similarity);
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Highlight the pinned/default anchor edge cell.
    const highlightedAnchorEdgeId =
      this.data.userAnchorEdgeId ??
      (this.anchorHighlightEnabled ? this.data.anchorEdgeId : null);
    if (highlightedAnchorEdgeId !== null) {
      for (const edge of edges) {
        if (edge.deleted || edge.id !== highlightedAnchorEdgeId) {
          continue;
        }
        const cell = this.getMatrixCellPoint(edge.src.which, edge.dest.which);
        if (cell) {
          ctx.fillStyle = ANCHOR_HIGHLIGHT_COLOR;
          ctx.beginPath();
          ctx.arc(cell.x, cell.y, dotRadius + 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
    }

    // 5. Diagonal beat markers.
    for (let i = 0; i < count; i += 1) {
      const p = this.positions[i];
      if (!p) {
        continue;
      }
      let bestDistance = maxDistance;
      if (visualEffectMode === "2") {
        for (const e of edges) {
          if (!e.deleted && e.src.which === i && e.distance < bestDistance) {
            bestDistance = e.distance;
          }
        }
      }
      const similarity =
        maxDistance > 0 ? 1 - bestDistance / maxDistance : 1;
      ctx.fillStyle = this.resolveModeBeatColor(
        i,
        visualEffectMode === "2" ? 0.8 : 1,
        this.theme.beatFill,
        similarity,
      );
      if (useSquareBeats && typeof ctx.fillRect === "function") {
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, BEAT_DOT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Draws row/column crosshair lines and highlights outgoing branch cells on
   * the Matrix overlay for a hovered or active beat.
   */
  private drawMatrixCrosshair(
    beatIndex: number,
    lineColor: string,
    cellColor: string,
  ) {
    const pos = this.positions[beatIndex];
    const beat = this.data?.beats[beatIndex];
    if (!pos || !beat) {
      return;
    }
    const bounds = getMatrixBounds(this.size.width, this.size.height);
    if (bounds.side <= 0) {
      return;
    }
    const ctx = this.overlayCtx;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pos.x, bounds.top);
    ctx.lineTo(pos.x, bounds.top + bounds.side);
    ctx.moveTo(bounds.left, pos.y);
    ctx.lineTo(bounds.left + bounds.side, pos.y);
    ctx.stroke();

    ctx.fillStyle = cellColor;
    for (const edge of beat.neighbors) {
      if (edge.deleted) {
        continue;
      }
      const cell = this.getMatrixCellPoint(beatIndex, edge.dest.which);
      if (!cell) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Tiles hold their size as counts rise, halving together when one would pass full height.
function resolveTileScale(maxVisits: number) {
  let scale = 1;
  while ((maxVisits + TILE_BASE_STEPS) * scale > TILE_MAX_STEPS) {
    scale /= 2;
  }
  return scale;
}

function createArcDiagramPositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const paddingX = 30;
    const timelineY = height * 0.5;
    const span = Math.max(0, width - paddingX * 2);
    if (count <= 0) {
      return [];
    }
    if (count === 1) {
      return [{ x: width / 2, y: timelineY }];
    }
    return Array.from({ length: count }, (_, i) => {
      const t = i / (count - 1);
      return {
        x: paddingX + span * t,
        y: timelineY,
      };
    });
  };
}

function createArcDiagramControlPointResolver(): EdgeControlPointResolver {
  return ({ edge, from, to, fromIndex, toIndex, center }) => {
    const midX = (from.x + to.x) / 2;
    const baseY = (from.y + to.y) / 2;
    const span = Math.abs(to.x - from.x);
    const forward =
      edge !== null ? edge.dest.which >= edge.src.which : toIndex >= fromIndex;
    // Gate: forward jumps arc above the timeline, backward jumps arc below.
    const direction = forward ? -1 : 1;
    const canvasHeight = center.y * 2;
    const availableLift =
      direction < 0
        ? baseY + 100
        : canvasHeight - baseY + 100;
    const maxLift = Math.max(4, availableLift);
    const minLift = Math.min(24, maxLift);
    const desiredLift = Math.max(minLift, span * 1.25);
    const lift = Math.min(maxLift, desiredLift);
    return [midX, baseY + direction * lift];
  };
}

/**
 * Computes Bezier control points for stacked multi-track line bridges: cross-song
 * edges curve gently between lanes, while same-song edges arc above/below their lane.
 */
function createMultiTrackLineControlPointResolver(): EdgeControlPointResolver {
  return ({ edge, from, to, fromIndex, toIndex, data }) => {
    const srcTrack = edge?.src.trackIndex ?? data.beats[fromIndex]?.trackIndex ?? 0;
    const destTrack = edge?.dest.trackIndex ?? data.beats[toIndex]?.trackIndex ?? 0;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    if (srcTrack !== destTrack) {
      const goingDown = destTrack > srcTrack;
      const offsetX = goingDown ? 18 : -18;
      const offsetY =
        (goingDown ? -1 : 1) * Math.min(32, Math.abs(to.y - from.y) * 0.2);
      return [midX + offsetX, midY + offsetY];
    }
    const direction = toIndex >= fromIndex ? -1 : 1;
    const lift = Math.min(44, Math.max(14, Math.abs(to.x - from.x) * 0.35));
    return [midX, midY + direction * lift];
  };
}

function createGridPositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    let beatsPerBar = 4;
    if (count > 0) {
      const counts = new Map<number, number>();
      let totalParents = 0;
      const seenParents = new Set<object>();
      for (const beat of data.beats) {
        const parent = beat.parent;
        if (!parent?.children) {
          continue;
        }
        if (!seenParents.has(parent)) {
          seenParents.add(parent);
          const length = Math.max(1, parent.children.length);
          counts.set(length, (counts.get(length) ?? 0) + 1);
          totalParents += 1;
        }
      }
      if (counts.size > 0) {
        let best = beatsPerBar;
        let bestCount = -1;
        for (const [size, value] of counts.entries()) {
          if (value > bestCount) {
            bestCount = value;
            best = size;
          }
        }
        beatsPerBar = best;
      }
      if (totalParents === 0) {
        beatsPerBar = 4;
      }
    }
    const bars: Array<{ bar: QuantumBase | null; section: QuantumBase | null }> = [];
    const barIndex = new Map<QuantumBase, number>();
    for (const beat of data.beats) {
      const parent = beat.parent ?? null;
      if (parent && !barIndex.has(parent)) {
        barIndex.set(parent, bars.length);
        bars.push({ bar: parent, section: parent.parent ?? null });
      }
    }
    if (bars.length === 0) {
      const totalBars = Math.max(
        1,
        Math.ceil(count / Math.max(1, beatsPerBar))
      );
      for (let i = 0; i < totalBars; i += 1) {
        bars.push({ bar: null, section: null });
      }
    }
    const totalBars = Math.max(1, bars.length);
    const targetBarsPerRow = Math.max(1, Math.ceil(Math.sqrt(totalBars)));
    const rowBars: number[] = [];
    if (bars.some((entry) => entry.section)) {
      let currentSection: QuantumBase | null = bars[0]?.section ?? null;
      let sectionBars = 0;
      const pushSectionRows = () => {
        if (sectionBars <= 0) {
          return;
        }
        let remaining = sectionBars;
        while (remaining > 0) {
          const chunk = Math.min(remaining, targetBarsPerRow);
          rowBars.push(chunk);
          remaining -= chunk;
        }
      };
      for (const entry of bars) {
        if (entry.section !== currentSection) {
          pushSectionRows();
          currentSection = entry.section;
          sectionBars = 0;
        }
        sectionBars += 1;
      }
      pushSectionRows();
    } else {
      let remaining = totalBars;
      while (remaining > 0) {
        const chunk = Math.min(remaining, targetBarsPerRow);
        rowBars.push(chunk);
        remaining -= chunk;
      }
    }
    const rows = Math.max(1, rowBars.length);
    const paddingX = 28;
    const verticalPad = Math.max(18, Math.min(36, height * 0.08));
    const paddingTop = verticalPad;
    const paddingBottom = verticalPad;
    const gridW = width - paddingX * 2;
    const gridH = height - paddingTop - paddingBottom;
    const safeRatio = (index: number, max: number) =>
      max <= 1 ? 0.5 : index / (max - 1);
    const rowStartBar: number[] = [];
    let running = 0;
    for (const barsInRow of rowBars) {
      rowStartBar.push(running);
      running += barsInRow;
    }
    return Array.from({ length: count }, (_, i) => {
      const beat = data.beats[i];
      const parent = beat.parent ?? null;
      const barIdx = parent ? barIndex.get(parent) ?? 0 : Math.floor(i / beatsPerBar);
      let rowIndex = 0;
      for (let r = 0; r < rowBars.length; r += 1) {
        const start = rowStartBar[r] ?? 0;
        const end = start + rowBars[r];
        if (barIdx >= start && barIdx < end) {
          rowIndex = r;
          break;
        }
      }
      const barsInRow = rowBars[rowIndex] ?? 1;
      const rowBarOffset = Math.max(0, barIdx - (rowStartBar[rowIndex] ?? 0));
      let beatInBar = beat.indexInParent ?? -1;
      if (beatInBar < 0 && parent?.children) {
        beatInBar = parent.children.indexOf(beat);
      }
      if (beatInBar < 0) {
        beatInBar = i % Math.max(1, beatsPerBar);
      }
      const cols = Math.max(1, beatsPerBar * barsInRow);
      const col = Math.min(cols - 1, rowBarOffset * beatsPerBar + beatInBar);
      return {
        x: paddingX + safeRatio(col, cols) * gridW,
        y: paddingTop + safeRatio(rowIndex, rows) * gridH,
      };
    });
  };
}

function createWavePositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const padding = 28;
    const amp = Math.min(Math.max(0, height * 0.42), Math.max(0, height / 2 - 18));
    const center = height / 2;
    const span = width - padding * 2;
    const waveTurns = 3;
    return Array.from({ length: count }, (_, i) => {
      const t = i / Math.max(1, count - 1);
      return {
        x: padding + span * t,
        y: center + Math.sin(t * Math.PI * 2 * waveTurns) * amp,
      };
    });
  };
}

function createInfinitePositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const cx = width / 2;
    const cy = height / 2;
    const ampX = width * 0.4;
    const ampY = Math.min(Math.max(0, height * 0.42), Math.max(0, height / 2 - 18));
    return Array.from({ length: count }, (_, i) => {
      const t = (i / count) * Math.PI * 2;
      return {
        x: cx + Math.sin(t) * ampX,
        y: cy + Math.sin(t * 2) * ampY,
      };
    });
  };
}

function createGalaxyPositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(width, height) * 0.49;
    const minRadius = Math.min(width, height) * 0.08;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: count }, (_, i) => {
      const t = i / Math.max(1, count - 1);
      const angle = i * goldenAngle;
      const radius = minRadius + (maxRadius - minRadius) * Math.sqrt(t);
      const wobble =
        0.06 * Math.sin(i * 12.9898) + 0.04 * Math.cos(i * 4.1414);
      const r = radius * (1 + wobble);
      return {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      };
    });
  };
}

function createSpiralPositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(width, height) * 0.44;
    const minRadius = Math.min(width, height) * 0.05;
    const turns = 5;
    return Array.from({ length: count }, (_, i) => {
      const t = i / Math.max(1, count - 1);
      const angle = t * Math.PI * 2 * turns;
      const radius = minRadius + (maxRadius - minRadius) * t;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  };
}

function createRandomPositioner(): Positioner {
  return (data: VisualizationData, width: number, height: number) => {
    const count = data.beats.length;
    const padding = 20;
    return Array.from({ length: count }, () => ({
      x: padding + Math.random() * Math.max(0, width - padding * 2),
      y: padding + Math.random() * Math.max(0, height - padding * 2),
    }));
  };
}

function getDefaultVisualizationDefinitions(): VisualizationDefinition[] {
  return [
    {
      positioner: createArcDiagramPositioner(),
      options: {
        forceBendEdges: true,
        edgeControlPointResolver: createArcDiagramControlPointResolver(),
      },
    },
    {
      positioner: JukeboxViz.createClassicPositioner(),
      options: { beatTiles: true },
    },
    { positioner: createGalaxyPositioner() },
    { positioner: createGridPositioner() },
    { positioner: createInfinitePositioner() },
    { positioner: createWavePositioner() },
    { positioner: createSpiralPositioner() },
    { positioner: createRandomPositioner() },
    { positioner: createRingsPositioner() },
    { positioner: createRosePositioner() },
    {
      positioner: createMatrixPositioner(),
      options: {
        forceBendEdges: true,
        edgeControlPointResolver: createMatrixControlPointResolver(),
        matrixMode: true,
      },
    },
  ];
}

export class JukeboxViz {
  private readonly vizLayer: HTMLElement;
  private readonly definitions: VisualizationDefinition[];
  private readonly multiTrackDefinition: VisualizationDefinition = {
    positioner: JukeboxViz.createMultiTrackLinePositioner(),
    options: {
      forceBendEdges: true,
      edgeControlPointResolver: createMultiTrackLineControlPointResolver(),
    },
  };
  private readonly enableInteraction: boolean;
  private readonly background: CanvasVizOptions["background"];
  private activeViz: CanvasViz | null = null;
  private activeIndex = 0;
  private multiTrackMode = false;
  private visible = true;
  private data: VizData | null = null;
  private selectedEdge: Edge | null = null;
  private predictedJumps: PredictedJump[] = [];
  private lastUpdate: LastUpdate | null = null;
  private anchorHighlightEnabled = false;
  private visualPreferences: VisualPreferences = readStoredVisualPreferences();
  private onSelectHandler: ((index: number) => void) | null = null;
  private onEdgeSelectHandler: ((edge: Edge | null) => void) | null = null;
  private anchorEdit: AnchorEditState | null = null;
  private onAnchorEditChangeHandler: AnchorEditHandler | null = null;
  private onAnchorEditCommitHandler: AnchorEditHandler | null = null;

  static createClassicPositioner(): Positioner {
    return (data: VisualizationData, width: number, height: number) => {
      const count = data.beats.length;
      const radius = Math.min(width, height) * CLASSIC_RADIUS_RATIO;
      const cx = width / 2;
      const cy = height / 2;
      return Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        return {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        };
      });
    };
  }

  /**
   * Positions each song onto its own horizontal lane stacked vertically across the canvas.
   * Lane widths are scaled proportionally to each track's duration relative to the longest
   * track so differing song lengths (e.g. full vs short covers) remain visually proportional.
   */
  static createMultiTrackLinePositioner(): Positioner {
    return (data: VisualizationData, width: number, height: number) => {
      const beats = data.beats;
      if (beats.length === 0) {
        return [];
      }
      const tracks = data.tracks;
      const trackCount =
        tracks && tracks.length > 0
          ? tracks.length
          : beats.reduce(
              (max, beat) => Math.max(max, (beat.trackIndex ?? 0) + 1),
              1,
            );
      const paddingX = 36;
      const spanX = Math.max(0, width - paddingX * 2);
      const topY = Math.max(48, height * 0.24);
      const bottomY = Math.max(topY, height - Math.max(40, height * 0.2));
      const spanY = Math.max(0, bottomY - topY);

      const maxDuration =
        tracks && tracks.length > 0
          ? tracks.reduce(
              (max, t) =>
                typeof t.duration === "number" && Number.isFinite(t.duration) && t.duration > 0
                  ? Math.max(max, t.duration)
                  : max,
              0,
            )
          : 0;
      const maxBeatCount = beats.reduce((max, beat, idx) => {
        const slice = tracks?.[beat.trackIndex ?? 0];
        const count =
          beat.trackBeatCount ?? slice?.beatCount ?? (tracks ? 0 : beats.length);
        return Math.max(max, count, idx === 0 ? 1 : 0);
      }, 1);

      return beats.map((beat, i) => {
        const trackIndex = beat.trackIndex ?? 0;
        const laneY =
          trackCount <= 1
            ? height * 0.5
            : topY + (trackIndex / (trackCount - 1)) * spanY;
        const trackSlice = tracks?.[trackIndex];
        let x: number;
        if (maxDuration > 0 && trackSlice) {
          const localTime = Math.max(0, beat.start - trackSlice.startTimeOffset);
          x = paddingX + (localTime / maxDuration) * spanX;
        } else {
          const localIdx =
            beat.localWhich ??
            (trackSlice ? i - trackSlice.startBeatIndex : i);
          const denom = Math.max(1, maxBeatCount - 1);
          x =
            maxBeatCount <= 1
              ? paddingX + spanX * 0.5
              : paddingX + (localIdx / denom) * spanX;
        }
        return { x, y: laneY };
      });
    };
  }

  constructor(
    vizLayer: HTMLElement,
    options?: {
      positioners?: Positioner[];
      enableInteraction?: boolean;
      // Paints this radial gradient into an opaque base canvas.
      background?: { inner: string; outer: string };
      initialIndex?: number;
    }
  ) {
    this.vizLayer = vizLayer;
    this.enableInteraction = options?.enableInteraction ?? true;
    this.background = options?.background;
    this.definitions = options?.positioners
      ? options.positioners.map((positioner) => ({ positioner }))
      : getDefaultVisualizationDefinitions();
    const initialIndex = options?.initialIndex ?? 0;
    this.activeIndex = this.definitions[initialIndex] ? initialIndex : 0;
    this.mountActiveVisualization(this.activeIndex);
  }

  getCount() {
    return this.definitions.length;
  }

  private createVisualization(index: number): CanvasViz | null {
    const definition = this.multiTrackMode
      ? this.multiTrackDefinition
      : this.definitions[index];
    if (!definition) {
      return null;
    }
    const viz = new CanvasViz(this.vizLayer, definition.positioner, {
      enableInteraction: this.enableInteraction,
      background: this.background,
      ...definition.options,
    });
    viz.setAnchorHighlightEnabled(this.anchorHighlightEnabled);
    viz.setVisualPreferences(this.visualPreferences);
    viz.setVisible(this.visible);
    if (this.onSelectHandler) {
      viz.setOnSelect(this.onSelectHandler);
    }
    if (this.onEdgeSelectHandler) {
      viz.setOnEdgeSelect(this.onEdgeSelectHandler);
    }
    if (this.data) {
      viz.setData(this.data);
    }
    if (this.selectedEdge) {
      viz.setSelectedEdge(this.selectedEdge);
    }
    if (this.predictedJumps.length > 0) {
      viz.setPredictedJumps(this.predictedJumps);
    }
    // The wrapper tracks drag changes, so a layout switch keeps the pair on screen.
    viz.setOnAnchorEditChange((state) => {
      this.anchorEdit = state;
      this.onAnchorEditChangeHandler?.(state);
    });
    viz.setOnAnchorEditCommit((state) => {
      this.anchorEdit = state;
      this.onAnchorEditCommitHandler?.(state);
    });
    viz.setAnchorEdit(this.anchorEdit);
    if (this.lastUpdate) {
      viz.update(
        this.lastUpdate.index,
        this.lastUpdate.animate,
        this.lastUpdate.previousIndex
      );
    }
    return viz;
  }

  private mountActiveVisualization(index: number) {
    if (this.activeViz) {
      this.activeViz.destroy();
      this.activeViz = null;
    }
    this.activeViz = this.createVisualization(index);
    this.activeViz?.resizeNow();
  }

  setActiveIndex(index: number) {
    if (index < 0 || index >= this.definitions.length) {
      return;
    }
    if (this.activeViz && index === this.activeIndex) {
      this.activeViz.resizeNow();
      return;
    }
    this.activeIndex = index;
    this.mountActiveVisualization(index);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.activeViz?.setVisible(visible);
  }

  setData(data: VizData) {
    const nextMultiTrack = (data.tracks?.length ?? 0) >= 2;
    this.data = data;
    if (nextMultiTrack !== this.multiTrackMode) {
      this.multiTrackMode = nextMultiTrack;
      this.mountActiveVisualization(this.activeIndex);
      return;
    }
    this.activeViz?.setData(data);
  }

  setAnchorHighlightEnabled(enabled: boolean) {
    this.anchorHighlightEnabled = enabled;
    this.activeViz?.setAnchorHighlightEnabled(enabled);
  }

  setVisualPreferences(prefs: VisualPreferences) {
    this.visualPreferences = prefs;
    this.activeViz?.setVisualPreferences(prefs);
  }

  refresh() {
    this.activeViz?.refresh();
  }

  resizeNow() {
    this.activeViz?.resizeNow();
  }

  resizeActive() {
    this.activeViz?.resizeNow();
  }

  update(index: number, animate: boolean, previousIndex: number | null) {
    this.lastUpdate = { index, animate, previousIndex };
    this.activeViz?.update(index, animate, previousIndex);
  }

  reset() {
    this.predictedJumps = [];
    this.activeViz?.reset();
  }

  destroy() {
    this.activeViz?.destroy();
    this.activeViz = null;
    this.data = null;
    this.selectedEdge = null;
    this.predictedJumps = [];
    this.lastUpdate = null;
    this.visible = false;
    this.activeIndex = 0;
    this.onSelectHandler = null;
    this.onEdgeSelectHandler = null;
    this.anchorEdit = null;
    this.onAnchorEditChangeHandler = null;
    this.onAnchorEditCommitHandler = null;
  }

  setOnSelect(handler: (index: number) => void) {
    this.onSelectHandler = handler;
    this.activeViz?.setOnSelect(handler);
  }

  setOnAnchorEditChange(handler: AnchorEditHandler) {
    this.onAnchorEditChangeHandler = handler;
  }

  setOnAnchorEditCommit(handler: AnchorEditHandler) {
    this.onAnchorEditCommitHandler = handler;
  }

  setAnchorEdit(state: AnchorEditState | null) {
    this.anchorEdit = state;
    this.activeViz?.setAnchorEdit(state);
  }

  setOnEdgeSelect(handler: (edge: Edge | null) => void) {
    this.onEdgeSelectHandler = handler;
    this.activeViz?.setOnEdgeSelect(handler);
  }

  setSelectedEdge(edge: Edge | null) {
    this.selectedEdge = edge;
    this.activeViz?.setSelectedEdge(edge);
  }

  setSelectedEdgeActive(edge: Edge | null) {
    this.selectedEdge = edge;
    this.activeViz?.setSelectedEdge(edge);
  }

  /**
   * Stores and renders the upcoming predicted branch jumps on the active layout.
   */
  setPredictedJumps(jumps: readonly PredictedJump[]) {
    this.predictedJumps = jumps.map((jump) => ({ ...jump }));
    this.activeViz?.setPredictedJumps(this.predictedJumps);
  }
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  if (t <= 0) {
    return Math.hypot(px - x1, py - y1);
  }
  if (t >= 1) {
    return Math.hypot(px - x2, py - y2);
  }
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function distanceToQuadratic(
  point: Point,
  start: Point,
  control: Point,
  end: Point,
) {
  let closest = Infinity;
  const steps = 20;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const it = 1 - t;
    const qx = it * it * start.x + 2 * it * t * control.x + t * t * end.x;
    const qy = it * it * start.y + 2 * it * t * control.y + t * t * end.y;
    const d = Math.hypot(point.x - qx, point.y - qy);
    if (d < closest) {
      closest = d;
    }
  }
  return closest;
}
