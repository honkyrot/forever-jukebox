import type { Edge, QuantumBase, Segment } from "../engine/types";

export type LayoutPoint = { x: number; y: number };

export interface LayoutVisualizationData {
  beats: QuantumBase[];
  edges: Edge[];
}

export type LayoutPositioner = (
  data: LayoutVisualizationData,
  width: number,
  height: number,
) => LayoutPoint[];

export type LayoutEdgeControlPointResolver = (args: {
  edge: Edge | null;
  from: LayoutPoint;
  to: LayoutPoint;
  fromIndex: number;
  toIndex: number;
  data: LayoutVisualizationData;
  center: LayoutPoint;
}) => [number, number];

export type MatrixBounds = {
  left: number;
  top: number;
  side: number;
  padding: number;
};

export type MatrixSimilarityGrid = {
  size: number;
  values: Float32Array;
  repBeats: Int32Array;
};

const MATRIX_PADDING_PX = 28;

/**
 * Builds a concentric rings positioner where each musical section (or equal
 * chunk fallback when sections are absent/excessive) forms one ring.
 */
export function createRingsPositioner(): LayoutPositioner {
  return (data, width, height) => {
    const count = data.beats.length;
    if (count <= 0) {
      return [];
    }
    if (count === 1) {
      return [{ x: width / 2, y: height / 2 }];
    }

    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const minRadius = minDim * 0.1;
    const maxRadius = minDim * 0.44;

    // Group contiguous beats sharing the same musical section.
    const sectionRuns: number[][] = [];
    let currentSection: QuantumBase | null | undefined = undefined;
    let hasSections = false;
    for (let i = 0; i < count; i += 1) {
      const sec = data.beats[i].parent?.parent ?? null;
      if (sec !== null) {
        hasSections = true;
      }
      if (sectionRuns.length === 0 || sec !== currentSection) {
        sectionRuns.push([i]);
        currentSection = sec;
      } else {
        sectionRuns[sectionRuns.length - 1].push(i);
      }
    }

    let rings: number[][];
    if (hasSections && sectionRuns.length >= 2 && sectionRuns.length <= 12) {
      rings = sectionRuns;
    } else if (hasSections && sectionRuns.length > 12) {
      // Merge consecutive sections evenly into 10 rings so rings stay legible.
      const targetRings = 10;
      rings = Array.from({ length: targetRings }, () => []);
      for (let s = 0; s < sectionRuns.length; s += 1) {
        const ringIdx = Math.min(
          targetRings - 1,
          Math.floor((s / sectionRuns.length) * targetRings),
        );
        rings[ringIdx].push(...sectionRuns[s]);
      }
      rings = rings.filter((ring) => ring.length > 0);
    } else {
      const ringCount =
        count < 8 ? 1 : Math.max(3, Math.min(6, Math.ceil(count / 32)));
      rings = Array.from({ length: ringCount }, () => []);
      for (let i = 0; i < count; i += 1) {
        const ringIdx = Math.min(
          ringCount - 1,
          Math.floor((i / count) * ringCount),
        );
        rings[ringIdx].push(i);
      }
      rings = rings.filter((ring) => ring.length > 0);
    }

    const positions: LayoutPoint[] = new Array(count);
    const ringCount = rings.length;
    for (let r = 0; r < ringCount; r += 1) {
      const ring = rings[r];
      const radius =
        ringCount <= 1
          ? maxRadius
          : minRadius + (r / (ringCount - 1)) * (maxRadius - minRadius);
      const len = ring.length;
      for (let k = 0; k < len; k += 1) {
        const angle = (k / Math.max(1, len)) * Math.PI * 2 - Math.PI / 2;
        positions[ring[k]] = {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        };
      }
    }
    return positions;
  };
}

/**
 * Builds a 5-petal polar rose layout keeping beats clear of the center origin.
 */
export function createRosePositioner(): LayoutPositioner {
  return (data, width, height) => {
    const count = data.beats.length;
    if (count <= 0) {
      return [];
    }
    if (count === 1) {
      return [{ x: width / 2, y: height / 2 }];
    }
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(width, height) * 0.44;
    const petals = 5;

    return Array.from({ length: count }, (_, i) => {
      const theta = (i / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
      const r = maxRadius * (0.58 + 0.42 * Math.cos(petals * theta));
      return {
        x: cx + Math.cos(theta) * r,
        y: cy + Math.sin(theta) * r,
      };
    });
  };
}

/**
 * Computes the centered square bounding box for the Self-Similarity Matrix layout.
 */
export function getMatrixBounds(width: number, height: number): MatrixBounds {
  const padding = MATRIX_PADDING_PX;
  const side = Math.max(0, Math.min(width, height) - padding * 2);
  const left = (width - side) / 2;
  const top = (height - side) / 2;
  return { left, top, side, padding };
}

/**
 * Places beats sequentially along the main diagonal of the Matrix square.
 */
export function createMatrixPositioner(): LayoutPositioner {
  return (data, width, height) => {
    const count = data.beats.length;
    if (count <= 0) {
      return [];
    }
    if (count === 1) {
      return [{ x: width / 2, y: height / 2 }];
    }
    const { left, top, side } = getMatrixBounds(width, height);
    return Array.from({ length: count }, (_, i) => {
      const t = i / (count - 1);
      return {
        x: left + t * side,
        y: top + t * side,
      };
    });
  };
}

/**
 * Routes each Matrix edge through its off-diagonal cell `(to.x, from.y)`,
 * placing forward jumps in the upper-right triangle and backward jumps below.
 */
export function createMatrixControlPointResolver(): LayoutEdgeControlPointResolver {
  return ({ from, to }) => [to.x, from.y];
}

/**
 * Extracts normalized 12-dim chroma and 3-dim timbre vectors for a beat's segments.
 */
function extractBeatFeatureVectors(beat: QuantumBase): {
  chroma: Float64Array;
  timbre: Float64Array;
  hasChroma: boolean;
  hasTimbre: boolean;
} {
  const chroma = new Float64Array(12);
  const timbre = new Float64Array(3);
  let hasChroma = false;
  let hasTimbre = false;
  let timbreWeight = 0;

  const segments: Segment[] =
    beat.overlappingSegments && beat.overlappingSegments.length > 0
      ? beat.overlappingSegments
      : beat.oseg
        ? [beat.oseg]
        : [];

  for (const seg of segments) {
    const w =
      typeof seg.duration === "number" &&
      Number.isFinite(seg.duration) &&
      seg.duration > 0
        ? seg.duration
        : 1;
    if (seg.pitches && seg.pitches.length >= 12) {
      for (let pc = 0; pc < 12; pc += 1) {
        const val = seg.pitches[pc];
        if (typeof val === "number" && Number.isFinite(val) && val > 0) {
          chroma[pc] += val * w;
          hasChroma = true;
        }
      }
    }
    if (seg.timbre && seg.timbre.length >= 4) {
      let validTimbre = true;
      for (let k = 0; k < 3; k += 1) {
        if (!Number.isFinite(seg.timbre[k + 1])) {
          validTimbre = false;
          break;
        }
      }
      if (validTimbre) {
        for (let k = 0; k < 3; k += 1) {
          timbre[k] += seg.timbre[k + 1] * w;
        }
        timbreWeight += w;
        hasTimbre = true;
      }
    }
  }

  if (timbreWeight > 0) {
    for (let k = 0; k < 3; k += 1) {
      timbre[k] /= timbreWeight;
    }
  }

  return { chroma, timbre, hasChroma, hasTimbre };
}

/**
 * Downsamples beats into a `size x size` symmetric self-similarity heatmap grid
 * using chroma cosine similarity blended with timbre proximity, or returns `null`
 * when the beats have no audio feature vectors.
 */
export function computeMatrixSimilarityGrid(
  beats: readonly QuantumBase[],
  maxResolution = 96,
): MatrixSimilarityGrid | null {
  const count = beats.length;
  if (count === 0 || maxResolution <= 0) {
    return null;
  }

  const size = Math.min(count, maxResolution);
  const binChroma = Array.from({ length: size }, () => new Float64Array(12));
  const binTimbre = Array.from({ length: size }, () => new Float64Array(3));
  const binHasChroma = new Uint8Array(size);
  const binHasTimbre = new Uint8Array(size);
  const binTimbreCount = new Float64Array(size);
  const repBeats = new Int32Array(size);

  let anyFeatures = false;

  for (let b = 0; b < size; b += 1) {
    const start = Math.floor((b * count) / size);
    const end = Math.max(start + 1, Math.floor(((b + 1) * count) / size));
    repBeats[b] = Math.min(count - 1, Math.floor((start + end - 1) / 2));

    for (let i = start; i < end; i += 1) {
      const feat = extractBeatFeatureVectors(beats[i]);
      if (feat.hasChroma) {
        for (let pc = 0; pc < 12; pc += 1) {
          binChroma[b][pc] += feat.chroma[pc];
        }
        binHasChroma[b] = 1;
        anyFeatures = true;
      }
      if (feat.hasTimbre) {
        for (let k = 0; k < 3; k += 1) {
          binTimbre[b][k] += feat.timbre[k];
        }
        binTimbreCount[b] += 1;
        binHasTimbre[b] = 1;
        anyFeatures = true;
      }
    }

    if (binHasChroma[b]) {
      let norm = 0;
      for (let pc = 0; pc < 12; pc += 1) {
        norm += binChroma[b][pc] * binChroma[b][pc];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let pc = 0; pc < 12; pc += 1) {
          binChroma[b][pc] /= norm;
        }
      } else {
        binHasChroma[b] = 0;
      }
    }
    if (binHasTimbre[b] && binTimbreCount[b] > 0) {
      for (let k = 0; k < 3; k += 1) {
        binTimbre[b][k] /= binTimbreCount[b];
      }
    }
  }

  if (!anyFeatures) {
    return null;
  }

  // Normalize timbre bins to zero mean / unit std per axis so timbre distance
  // sits on a consistent scale across tracks.
  const timbreMean = [0, 0, 0];
  let timbreBins = 0;
  for (let b = 0; b < size; b += 1) {
    if (!binHasTimbre[b]) continue;
    timbreBins += 1;
    for (let k = 0; k < 3; k += 1) {
      timbreMean[k] += binTimbre[b][k];
    }
  }
  if (timbreBins > 0) {
    for (let k = 0; k < 3; k += 1) {
      timbreMean[k] /= timbreBins;
    }
    const timbreStd = [0, 0, 0];
    for (let b = 0; b < size; b += 1) {
      if (!binHasTimbre[b]) continue;
      for (let k = 0; k < 3; k += 1) {
        const d = binTimbre[b][k] - timbreMean[k];
        timbreStd[k] += d * d;
      }
    }
    for (let k = 0; k < 3; k += 1) {
      const std = Math.sqrt(timbreStd[k] / timbreBins);
      timbreStd[k] = std > 1e-4 ? std : 1;
    }
    for (let b = 0; b < size; b += 1) {
      if (!binHasTimbre[b]) continue;
      for (let k = 0; k < 3; k += 1) {
        binTimbre[b][k] = (binTimbre[b][k] - timbreMean[k]) / timbreStd[k];
      }
    }
  }

  const values = new Float32Array(size * size);
  for (let r = 0; r < size; r += 1) {
    values[r * size + r] = 1;
    for (let c = r + 1; c < size; c += 1) {
      let chromaSim = 0;
      let hasC = false;
      if (binHasChroma[r] && binHasChroma[c]) {
        hasC = true;
        for (let pc = 0; pc < 12; pc += 1) {
          chromaSim += binChroma[r][pc] * binChroma[c][pc];
        }
        chromaSim = Math.max(0, Math.min(1, chromaSim));
      }

      let timbreSim = 0;
      let hasT = false;
      if (binHasTimbre[r] && binHasTimbre[c]) {
        hasT = true;
        let distSq = 0;
        for (let k = 0; k < 3; k += 1) {
          const d = binTimbre[r][k] - binTimbre[c][k];
          distSq += d * d;
        }
        timbreSim = Math.exp(-Math.sqrt(distSq) * 0.65);
      }

      let rawSim = 0;
      if (hasC && hasT) {
        rawSim = 0.7 * chromaSim + 0.3 * timbreSim;
      } else if (hasC) {
        rawSim = chromaSim;
      } else if (hasT) {
        rawSim = timbreSim;
      }
      const contrasted = Math.pow(Math.max(0, Math.min(1, rawSim)), 2.5);
      values[r * size + c] = contrasted;
      values[c * size + r] = contrasted;
    }
  }

  return { size, values, repBeats };
}
