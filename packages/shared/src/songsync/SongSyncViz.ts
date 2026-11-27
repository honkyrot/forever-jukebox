import type { QuantumBase } from "../engine/types";

export const SONG_SYNC_TRACK_COLORS = [
  "#4F8FFF",
  "#10DF00",
  "#FF4FA3",
  "#FFB800",
  "#00D4FF",
  "#B47CFF",
  "#FF784F",
  "#4FFFB0",
] as const;

export interface SongSyncVizTrack {
  trackIndex: number;
  title: string;
  duration: number;
  tempo?: number;
  beats: Array<QuantumBase & { color?: string }>;
  color: string;
  isMaster: boolean;
  muted: boolean;
  solo: boolean;
}

export interface SongSyncActiveCursors {
  masterBeatIndex: number;
  beatIndicesByTrack: Array<number | null>;
}

interface LaneLayout {
  y: number;
  startX: number;
  endX: number;
  beatX: number[];
}

const PADDING_X = 36;
const MIN_LANE_TOP = 44;
const MIN_LANE_BOTTOM = 36;
const CURSOR_RADIUS = 7;

function formatDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Dual-canvas visualizer for Song Sync mode: renders proportional horizontal
 * timeline rails per track, subtle DTW alignment guides, active synced cursor
 * dots, and connecting sync lines across aligned beats.
 */
export class SongSyncViz {
  private readonly container: HTMLElement;
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private tracks: SongSyncVizTrack[] = [];
  private masterTrackIndex = 0;
  private alignedMaps: Array<Array<number | null>> = [];
  private activeCursors: SongSyncActiveCursors | null = null;
  private visible = false;
  private width = 0;
  private height = 0;
  private maxDuration = 1;
  private laneLayouts: LaneLayout[] = [];
  private onSelect: ((trackIndex: number, beatIndex: number) => void) | null =
    null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.baseCanvas = document.createElement("canvas");
    this.overlayCanvas = document.createElement("canvas");
    const baseCtx = this.baseCanvas.getContext("2d");
    const overlayCtx = this.overlayCanvas.getContext("2d");
    if (!baseCtx || !overlayCtx) {
      throw new Error("Canvas not supported");
    }
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;
    this.applyCanvasStyles();
    this.container.append(this.baseCanvas, this.overlayCanvas);
    this.resizeNow();
    this.overlayCanvas.addEventListener("click", this.handleClick);
  }

  /**
   * Shows or hides the Song Sync canvas layers.
   */
  setVisible(visible: boolean) {
    this.visible = visible;
    const display = visible ? "block" : "none";
    this.baseCanvas.style.display = display;
    this.overlayCanvas.style.display = display;
    if (visible) {
      if (this.width === 0 || this.height === 0) {
        this.resizeNow();
        return;
      }
      this.drawBase();
      this.drawOverlay();
    }
  }

  /**
   * Loads track lanes and master-to-secondary alignment maps into the renderer.
   */
  setData(
    tracks: SongSyncVizTrack[],
    masterTrackIndex: number,
    alignedMaps: Array<Array<number | null>>,
  ) {
    this.tracks = tracks;
    this.masterTrackIndex = masterTrackIndex;
    this.alignedMaps = alignedMaps;
    this.activeCursors = null;
    if (this.visible && (this.width === 0 || this.height === 0)) {
      this.resizeNow();
      return;
    }
    this.computeLayout();
    this.drawBase();
    this.drawOverlay();
  }

  /**
   * Updates the active cursor indices across all tracks and redraws the overlay.
   */
  update(cursors: SongSyncActiveCursors) {
    this.activeCursors = cursors;
    this.drawOverlay();
  }

  /**
   * Clears active cursors from the overlay canvas.
   */
  reset() {
    this.activeCursors = null;
    this.overlayCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Re-measures the host container and redraws both canvases.
   */
  resizeNow() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.baseCanvas.width = rect.width * dpr;
    this.baseCanvas.height = rect.height * dpr;
    this.overlayCanvas.width = rect.width * dpr;
    this.overlayCanvas.height = rect.height * dpr;
    this.baseCanvas.style.width = `${rect.width}px`;
    this.baseCanvas.style.height = `${rect.height}px`;
    this.overlayCanvas.style.width = `${rect.width}px`;
    this.overlayCanvas.style.height = `${rect.height}px`;
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.computeLayout();
    this.drawBase();
    this.drawOverlay();
  }

  /**
   * Registers a click-to-seek callback receiving `(trackIndex, localBeatIndex)`.
   */
  setOnSelect(
    handler: ((trackIndex: number, beatIndex: number) => void) | null,
  ) {
    this.onSelect = handler;
  }

  /**
   * Detaches event listeners and removes canvas elements.
   */
  destroy() {
    this.overlayCanvas.removeEventListener("click", this.handleClick);
    this.baseCanvas.remove();
    this.overlayCanvas.remove();
    this.tracks = [];
    this.alignedMaps = [];
    this.laneLayouts = [];
    this.activeCursors = null;
  }

  private applyCanvasStyles() {
    this.baseCanvas.style.position = "absolute";
    this.baseCanvas.style.inset = "0";
    this.overlayCanvas.style.position = "absolute";
    this.overlayCanvas.style.inset = "0";
  }

  private computeLayout() {
    if (!this.width || !this.height || this.tracks.length === 0) {
      this.laneLayouts = [];
      return;
    }

    const spanX = Math.max(1, this.width - PADDING_X * 2);
    this.maxDuration = Math.max(
      0.001,
      ...this.tracks.map((t) =>
        Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 0.001,
      ),
    );

    const topY = Math.max(MIN_LANE_TOP, this.height * 0.2);
    const bottomY = Math.max(topY, this.height - Math.max(MIN_LANE_BOTTOM, this.height * 0.16));
    const spanY = Math.max(0, bottomY - topY);
    const trackCount = this.tracks.length;

    this.laneLayouts = this.tracks.map((track, idx) => {
      const y =
        trackCount <= 1
          ? this.height * 0.5
          : topY + (idx / (trackCount - 1)) * spanY;
      const endX = PADDING_X + (track.duration / this.maxDuration) * spanX;
      const beatX = track.beats.map(
        (beat) => PADDING_X + (beat.start / this.maxDuration) * spanX,
      );
      return {
        y,
        startX: PADDING_X,
        endX,
        beatX,
      };
    });
  }

  private drawBase() {
    if (!this.visible) {
      return;
    }
    this.baseCtx.clearRect(0, 0, this.width, this.height);
    if (this.tracks.length === 0 || this.laneLayouts.length === 0) {
      return;
    }

    const ctx = this.baseCtx;
    ctx.save();

    // Draw subtle structural sync guides every 8 beats between the master track
    // and each secondary track so aligned vs solo sections are readable at a glance.
    const masterTrack = this.tracks[this.masterTrackIndex];
    const masterLayout = this.laneLayouts[this.masterTrackIndex];
    if (masterTrack && masterLayout) {
      const stride = Math.max(4, Math.ceil(masterTrack.beats.length / 48));
      ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
      ctx.lineWidth = 1;
      for (let t = 0; t < this.tracks.length; t += 1) {
        if (t === this.masterTrackIndex) {
          continue;
        }
        const map = this.alignedMaps[t];
        const otherLayout = this.laneLayouts[t];
        if (!map || !otherLayout) {
          continue;
        }
        ctx.beginPath();
        for (let i = 0; i < masterTrack.beats.length; i += stride) {
          const targetIdx = map[i];
          if (targetIdx === null || targetIdx === undefined) {
            continue;
          }
          const x1 = masterLayout.beatX[i];
          const x2 = otherLayout.beatX[targetIdx];
          if (x1 === undefined || x2 === undefined) {
            continue;
          }
          ctx.moveTo(x1, masterLayout.y);
          ctx.lineTo(x2, otherLayout.y);
        }
        ctx.stroke();
      }
    }

    const anySolo = this.tracks.some((t) => t.solo);
    for (let t = 0; t < this.tracks.length; t += 1) {
      const track = this.tracks[t];
      const layout = this.laneLayouts[t];
      if (!layout) {
        continue;
      }
      const dimmed = track.muted || (anySolo && !track.solo);

      // Draw proportional rail line.
      ctx.strokeStyle = dimmed
        ? "rgba(255, 255, 255, 0.16)"
        : "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(layout.startX, layout.y);
      ctx.lineTo(Math.max(layout.startX + 1, layout.endX), layout.y);
      ctx.stroke();

      // Draw colored beat ticks along the rail.
      for (let i = 0; i < track.beats.length; i += 1) {
        const beat = track.beats[i];
        const x1 = layout.beatX[i];
        const nextBeat = track.beats[i + 1];
        const x2 = nextBeat
          ? layout.beatX[i + 1]
          : PADDING_X +
            ((beat.start + beat.duration) / this.maxDuration) *
              Math.max(1, this.width - PADDING_X * 2);
        ctx.strokeStyle = dimmed
          ? "rgba(180, 190, 210, 0.22)"
          : (beat.color ?? track.color);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x1, layout.y);
        ctx.lineTo(Math.max(x1 + 1, x2 - 0.5), layout.y);
        ctx.stroke();
      }

      // Draw track label above the rail.
      if (typeof ctx.fillText === "function") {
        const parts: string[] = [track.title || `Track ${t + 1}`];
        if (typeof track.tempo === "number" && Number.isFinite(track.tempo)) {
          parts.push(`${Math.round(track.tempo)} BPM`);
        }
        parts.push(formatDurationLabel(track.duration));
        if (track.isMaster) {
          parts.push("Master");
        }
        if (track.muted) {
          parts.push("Muted");
        } else if (track.solo) {
          parts.push("Solo");
        }
        ctx.fillStyle = dimmed ? "rgba(255, 255, 255, 0.45)" : track.color;
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText(parts.join(" · "), layout.startX, layout.y - 10);
      }
    }
    ctx.restore();
  }

  private drawOverlay() {
    if (!this.visible) {
      return;
    }
    this.overlayCtx.clearRect(0, 0, this.width, this.height);
    if (!this.activeCursors || this.laneLayouts.length === 0) {
      return;
    }

    const masterTrack = this.tracks[this.masterTrackIndex];
    const masterLayout = this.laneLayouts[this.masterTrackIndex];
    const masterBeatIdx = this.activeCursors.masterBeatIndex;
    const masterX = masterLayout?.beatX[masterBeatIdx];
    if (!masterTrack || !masterLayout || masterX === undefined) {
      return;
    }

    const ctx = this.overlayCtx;
    ctx.save();

    const anySolo = this.tracks.some((t) => t.solo);
    const activePoints: Array<{ x: number; y: number; color: string; muted: boolean }> = [];

    for (let t = 0; t < this.tracks.length; t += 1) {
      if (t === this.masterTrackIndex) {
        continue;
      }
      const track = this.tracks[t];
      const layout = this.laneLayouts[t];
      const beatIdx = this.activeCursors.beatIndicesByTrack[t];
      if (!layout || beatIdx === null || beatIdx === undefined) {
        continue;
      }
      const targetX = layout.beatX[beatIdx];
      if (targetX === undefined) {
        continue;
      }
      const isMuted = track.muted || (anySolo && !track.solo);
      activePoints.push({
        x: targetX,
        y: layout.y,
        color: track.color,
        muted: isMuted,
      });

      // Draw sync connector line between the master cursor and this synced track's cursor.
      ctx.save();
      ctx.strokeStyle = isMuted
        ? "rgba(255, 255, 255, 0.25)"
        : "rgba(255, 255, 255, 0.72)";
      ctx.lineWidth = isMuted ? 1 : 2;
      if (isMuted && typeof ctx.setLineDash === "function") {
        ctx.setLineDash([4, 4]);
      }
      ctx.beginPath();
      ctx.moveTo(masterX, masterLayout.y);
      ctx.lineTo(targetX, layout.y);
      ctx.stroke();
      ctx.restore();
    }

    // Draw cursor dots on secondary synced lanes.
    for (const pt of activePoints) {
      ctx.fillStyle = pt.muted ? "rgba(200, 200, 200, 0.5)" : pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, CURSOR_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw master cursor dot on top.
    const masterMuted =
      masterTrack.muted || (anySolo && !masterTrack.solo);
    ctx.fillStyle = masterMuted
      ? "rgba(200, 200, 200, 0.6)"
      : masterTrack.color;
    ctx.beginPath();
    ctx.arc(masterX, masterLayout.y, CURSOR_RADIUS + 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private readonly handleClick = (event: MouseEvent) => {
    if (
      !this.visible ||
      !this.onSelect ||
      this.tracks.length === 0 ||
      this.laneLayouts.length === 0
    ) {
      return;
    }
    const rect = this.overlayCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Pick the lane closest vertically to the click.
    let bestTrackIdx = 0;
    let bestLaneDist = Number.POSITIVE_INFINITY;
    for (let t = 0; t < this.laneLayouts.length; t += 1) {
      const dist = Math.abs(this.laneLayouts[t].y - y);
      if (dist < bestLaneDist) {
        bestLaneDist = dist;
        bestTrackIdx = t;
      }
    }

    const layout = this.laneLayouts[bestTrackIdx];
    const track = this.tracks[bestTrackIdx];
    if (!layout || !track || track.beats.length === 0) {
      return;
    }

    let bestBeatIdx = 0;
    let bestBeatDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < layout.beatX.length; i += 1) {
      const dist = Math.abs(layout.beatX[i] - x);
      if (dist < bestBeatDist) {
        bestBeatDist = dist;
        bestBeatIdx = i;
      }
    }

    this.onSelect(bestTrackIdx, bestBeatIdx);
  };
}
