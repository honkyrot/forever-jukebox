import type { QuantumBase, Segment } from "./types";

const NO_SEGMENT_COLOR = "#333333";

// One hex color per beat, from timbre coefficients 1-3 normalized across the track.
export function computeBeatColors(
  beats: QuantumBase[],
  segments: Segment[],
): string[] {
  const min = [100, 100, 100];
  const max = [-100, -100, -100];
  for (const seg of segments) {
    for (let i = 0; i < 3; i += 1) {
      const value = seg.timbre[i + 1];
      if (value < min[i]) {
        min[i] = value;
      }
      if (value > max[i]) {
        max[i] = value;
      }
    }
  }
  return beats.map((beat) => {
    const segment = beat.overlappingSegments[0];
    if (!segment) {
      return NO_SEGMENT_COLOR;
    }
    const color = [];
    for (let i = 0; i < 3; i += 1) {
      const value = segment.timbre[i + 1];
      const range = max[i] - min[i];
      const norm = range === 0 ? 0.5 : (value - min[i]) / range;
      color[i] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }
    return toHex(color[1], color[2], color[0]);
  });
}

function toHex(r: number, g: number, b: number) {
  const convert = (value: number) => value.toString(16).padStart(2, "0");
  return `#${convert(r)}${convert(g)}${convert(b)}`;
}

/**
 * Converts HSL values (hue in [0, 360), saturation & lightness in [0, 100])
 * to a 6-digit `#rrggbb` hex color string.
 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, saturation / 100));
  const l = Math.max(0, Math.min(1, lightness / 100));
  if (s === 0) {
    const gray = Math.round(l * 255);
    return toHex(gray, gray, gray);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let wrapped = t;
    if (wrapped < 0) wrapped += 1;
    if (wrapped > 1) wrapped -= 1;
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
    if (wrapped < 1 / 2) return q;
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
    return p;
  };
  return toHex(
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  );
}

/**
 * Computes a Circle-of-Fifths pitch/chroma hex color for a single beat from its
 * overlapping segments (falling back to `beat.oseg`), or `null` when unavailable.
 */
export function computeBeatPitchColor(beat: QuantumBase): string | null {
  const segments =
    beat.overlappingSegments && beat.overlappingSegments.length > 0
      ? beat.overlappingSegments
      : beat.oseg
        ? [beat.oseg]
        : [];
  if (segments.length === 0) {
    return null;
  }

  const chroma = new Float64Array(12);
  let hasChroma = false;

  for (const segment of segments) {
    const pitches = segment?.pitches;
    if (!pitches || pitches.length < 12) {
      continue;
    }
    const weight =
      typeof segment.duration === "number" &&
      Number.isFinite(segment.duration) &&
      segment.duration > 0
        ? segment.duration
        : 1;
    for (let pc = 0; pc < 12; pc += 1) {
      const value = pitches[pc];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        chroma[pc] += value * weight;
        hasChroma = true;
      }
    }
  }

  if (!hasChroma) {
    return null;
  }

  // Average pitch classes on the Circle of Fifths with squared weights so
  // dominant harmonic tones steer the hue smoothly.
  let vx = 0;
  let vy = 0;
  let wSum = 0;
  for (let pc = 0; pc < 12; pc += 1) {
    const val = chroma[pc];
    if (val <= 0) {
      continue;
    }
    const w = val * val;
    const fifthsPos = (pc * 7) % 12;
    const angle = (fifthsPos / 12) * Math.PI * 2;
    vx += w * Math.cos(angle);
    vy += w * Math.sin(angle);
    wSum += w;
  }

  if (wSum <= 0) {
    return null;
  }

  const hue = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
  const coherence = Math.min(1, Math.hypot(vx, vy) / wSum);
  const saturation = 44 + coherence * 44;
  const lightness = 58 - coherence * 4;
  return hslToHex(hue, saturation, lightness);
}

/**
 * Computes per-beat pitch/chroma hex colors (or `null` per beat when missing)
 * across an ordered list of beats.
 */
export function computePitchBeatColors(
  beats: readonly QuantumBase[],
): Array<string | null> {
  return beats.map((beat) => computeBeatPitchColor(beat));
}
