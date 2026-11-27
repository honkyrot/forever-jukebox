import {
  alignTrackPairMultiSectionDtw,
  extractTrackBeatFeatures,
} from "./coverSync";
import type { Edge, QuantumBase, TimeSignatureBranchMode } from "./types";

export type { TimeSignatureBranchMode };

export const DEFAULT_TIME_SIGNATURE_BRANCH_MODE: TimeSignatureBranchMode =
  "overwrite";

export const DEFAULT_TIME_SIGNATURE_NUMERATOR = 4;
export const MIN_TIME_SIGNATURE_NUMERATOR = 1;
export const MAX_TIME_SIGNATURE_NUMERATOR = 64;

export const DEFAULT_TIME_SIGNATURE_DENOMINATOR = 4;
export const MIN_TIME_SIGNATURE_DENOMINATOR = 1;
export const MAX_TIME_SIGNATURE_DENOMINATOR = 16;

export const TIME_SIGNATURE_DENOMINATOR_OPTIONS = [1, 2, 4, 8, 16] as const;

export const MIN_TIME_SIGNATURE_TRACK_OFFSET = -256;
export const MAX_TIME_SIGNATURE_TRACK_OFFSET = 256;

export interface TimeSignatureBranchOptions {
  numerator?: number;
  denominator?: number;
  trackOffsets?: readonly number[];
  useCoverSync?: boolean;
}

export interface TimeSignatureBranchGrid {
  edgesByBeat: Map<number, Edge[]>;
  boundaryBeatIndices: Set<number>;
}

// Cache DTW master-to-secondary beat alignments per merged quanta array so live
// signature or offset edits rebuild the graph immediately without re-running DTW.
const cachedMasterAlignments = new WeakMap<
  readonly QuantumBase[],
  Map<number, Map<number, number>>
>();

/**
 * Normalizes a time-signature branch mode string, defaulting unknown values to
 * "overwrite".
 */
export function normalizeTimeSignatureBranchMode(
  mode?: string,
): TimeSignatureBranchMode {
  return mode === "combine" ? "combine" : "overwrite";
}

/**
 * Clamps a time signature numerator (beats per bar) to [1, 64], defaulting to 4.
 */
export function clampTimeSignatureNumerator(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIME_SIGNATURE_NUMERATOR;
  }
  return Math.max(
    MIN_TIME_SIGNATURE_NUMERATOR,
    Math.min(MAX_TIME_SIGNATURE_NUMERATOR, Math.round(value)),
  );
}

/**
 * Clamps a time signature denominator (note value) to [1, 16], defaulting to 4.
 */
export function clampTimeSignatureDenominator(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIME_SIGNATURE_DENOMINATOR;
  }
  return Math.max(
    MIN_TIME_SIGNATURE_DENOMINATOR,
    Math.min(MAX_TIME_SIGNATURE_DENOMINATOR, Math.round(value)),
  );
}

/**
 * Clamps a per-track beat offset to [-256, 256] and normalizes -0 to 0.
 */
export function clampTimeSignatureTrackOffset(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.max(
    MIN_TIME_SIGNATURE_TRACK_OFFSET,
    Math.min(MAX_TIME_SIGNATURE_TRACK_OFFSET, Math.round(value)),
  );
  return clamped === 0 ? 0 : clamped;
}

/**
 * Resolves the beat interval between cross-track branch boundaries from a
 * time signature (numerator / denominator) relative to quarter-note beats.
 */
export function resolveTimeSignatureBranchStepBeats(
  numerator?: number,
  denominator?: number,
): number {
  const num = clampTimeSignatureNumerator(numerator);
  const den = clampTimeSignatureDenominator(denominator);
  return Math.max(1, Math.round((num * 4) / den));
}

/**
 * Groups merged quanta by `trackIndex` in ascending order for cross-track
 * alignment and bar-boundary placement.
 */
function groupQuantaByTrack(quanta: readonly QuantumBase[]): QuantumBase[][] {
  const groupMap = new Map<number, QuantumBase[]>();
  for (const q of quanta) {
    if (q.trackIndex === undefined) {
      continue;
    }
    let list = groupMap.get(q.trackIndex);
    if (!list) {
      list = [];
      groupMap.set(q.trackIndex, list);
    }
    list.push(q);
  }
  return [...groupMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, beats]) => beats);
}

/**
 * Computes (or retrieves from cache) the best DTW alignment mapping each beat
 * index of track 0 to its corresponding beat index in each secondary track,
 * ignoring similarity thresholds so forced bar boundaries always find partners.
 */
function getMasterCoverSyncAlignments(
  quanta: readonly QuantumBase[],
  groups: readonly (readonly QuantumBase[])[],
): Map<number, Map<number, number>> {
  const cached = cachedMasterAlignments.get(quanta);
  if (cached) {
    return cached;
  }

  const featuresByTrack = groups.map((beats) => extractTrackBeatFeatures(beats));
  const masterFeatures = featuresByTrack[0];
  const alignmentsByTrack = new Map<number, Map<number, number>>();

  for (let t = 1; t < groups.length; t += 1) {
    const targetTrackIndex = groups[t][0]?.trackIndex ?? t;
    const aligned = alignTrackPairMultiSectionDtw(
      masterFeatures,
      featuresByTrack[t],
    ).pairs;
    const bestByMasterBeat = new Map<
      number,
      { indexB: number; distance: number }
    >();

    for (const pair of aligned) {
      const existing = bestByMasterBeat.get(pair.indexA);
      if (!existing || pair.distance < existing.distance) {
        bestByMasterBeat.set(pair.indexA, {
          indexB: pair.indexB,
          distance: pair.distance,
        });
      }
    }

    const beatMap = new Map<number, number>();
    for (const [indexA, entry] of bestByMasterBeat.entries()) {
      beatMap.set(indexA, entry.indexB);
    }
    alignmentsByTrack.set(targetTrackIndex, beatMap);
  }

  cachedMasterAlignments.set(quanta, alignmentsByTrack);
  return alignmentsByTrack;
}

/**
 * Builds cross-track jump edges placed strictly on time-signature bar boundaries
 * along with the set of all eligible boundary beat indices across tracks.
 *
 * When `useCoverSync` is true, boundaries follow track 0's grid mapped onto each
 * secondary track through Cover sync DTW alignment plus relative per-track
 * offsets. Otherwise, tracks are aligned directly via their beat offsets.
 */
export function buildTimeSignatureBranchGrid(
  quanta: readonly QuantumBase[],
  options: TimeSignatureBranchOptions = {},
): TimeSignatureBranchGrid {
  const stepBeats = resolveTimeSignatureBranchStepBeats(
    options.numerator,
    options.denominator,
  );
  const groups = groupQuantaByTrack(quanta);
  const boundaryBeatIndices = new Set<number>();
  if (groups.length < 2) {
    // Single-track analysis: populate bar-boundary beat indices directly using
    // track 0's beat offset without emitting cross-track edges.
    const offset = clampTimeSignatureTrackOffset(options.trackOffsets?.[0] ?? 0);
    for (let m = 0; ; m += 1) {
      const b = offset + m * stepBeats;
      if (b >= quanta.length) {
        break;
      }
      if (b >= 0) {
        boundaryBeatIndices.add(quanta[b].which);
      }
    }
    return { edgesByBeat: new Map(), boundaryBeatIndices };
  }

  const offsets = groups.map((_, index) =>
    clampTimeSignatureTrackOffset(options.trackOffsets?.[index] ?? 0),
  );

  // Store edges per source `which` and target `trackIndex` so aligned positions
  // cannot emit duplicate edges when offsets or warps overlap.
  const edgesBySrcAndTarget = new Map<number, Map<number, Edge>>();

  const addBarGroupEdges = (
    barBeats: readonly { trackPos: number; beat: QuantumBase }[],
  ) => {
    for (let i = 0; i < barBeats.length; i += 1) {
      const srcEntry = barBeats[i];
      let perTargetTrack = edgesBySrcAndTarget.get(srcEntry.beat.which);
      if (!perTargetTrack) {
        perTargetTrack = new Map<number, Edge>();
        edgesBySrcAndTarget.set(srcEntry.beat.which, perTargetTrack);
      }
      for (let j = 0; j < barBeats.length; j += 1) {
        if (i === j) {
          continue;
        }
        const destEntry = barBeats[j];
        const destTrackIndex = destEntry.beat.trackIndex ?? destEntry.trackPos;
        if (!perTargetTrack.has(destTrackIndex)) {
          perTargetTrack.set(destTrackIndex, {
            id: -1,
            src: srcEntry.beat,
            dest: destEntry.beat,
            distance: 0,
            deleted: false,
            timeSignature: true,
          });
        }
      }
    }
  };

  if (options.useCoverSync) {
    const alignmentsByTrack = getMasterCoverSyncAlignments(quanta, groups);
    const off0 = offsets[0] ?? 0;
    const masterBeats = groups[0];

    for (let m = 0; ; m += 1) {
      const b0 = off0 + m * stepBeats;
      if (b0 >= masterBeats.length) {
        break;
      }
      if (b0 < 0) {
        continue;
      }
      boundaryBeatIndices.add(masterBeats[b0].which);
      const barBeats: Array<{ trackPos: number; beat: QuantumBase }> = [
        { trackPos: 0, beat: masterBeats[b0] },
      ];
      for (let t = 1; t < groups.length; t += 1) {
        const targetTrackIndex = groups[t][0]?.trackIndex ?? t;
        const alignedB = alignmentsByTrack.get(targetTrackIndex)?.get(b0);
        if (alignedB === undefined) {
          continue;
        }
        // Shifting all track offsets equally shifts the shared grid along the
        // DTW path; shifting one track's offset adjusts only that track.
        const bt = alignedB + ((offsets[t] ?? 0) - off0);
        if (bt >= 0 && bt < groups[t].length) {
          boundaryBeatIndices.add(groups[t][bt].which);
          barBeats.push({ trackPos: t, beat: groups[t][bt] });
        }
      }
      if (barBeats.length >= 2) {
        addBarGroupEdges(barBeats);
      }
    }
  } else {
    const minOffset = Math.min(...offsets);
    const maxLen = Math.max(...groups.map((beats) => beats.length));

    for (let m = 0; ; m += 1) {
      if (minOffset + m * stepBeats >= maxLen) {
        break;
      }
      const barBeats: Array<{ trackPos: number; beat: QuantumBase }> = [];
      for (let t = 0; t < groups.length; t += 1) {
        const bt = (offsets[t] ?? 0) + m * stepBeats;
        if (bt >= 0 && bt < groups[t].length) {
          boundaryBeatIndices.add(groups[t][bt].which);
          barBeats.push({ trackPos: t, beat: groups[t][bt] });
        }
      }
      if (barBeats.length >= 2) {
        addBarGroupEdges(barBeats);
      }
    }
  }

  const edgesByBeat = new Map<number, Edge[]>();
  for (const [srcWhich, byTargetTrack] of edgesBySrcAndTarget.entries()) {
    const edges = [...byTargetTrack.values()].sort(
      (a, b) => (a.dest.trackIndex ?? 0) - (b.dest.trackIndex ?? 0),
    );
    edgesByBeat.set(srcWhich, edges);
  }
  return { edgesByBeat, boundaryBeatIndices };
}

/**
 * Builds cross-track jump edges placed strictly on time-signature bar boundaries.
 */
export function buildTimeSignatureCrossEdges(
  quanta: readonly QuantumBase[],
  options: TimeSignatureBranchOptions = {},
): Map<number, Edge[]> {
  return buildTimeSignatureBranchGrid(quanta, options).edgesByBeat;
}

/**
 * Computes a non-negative remainder modulo `modulus`.
 */
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Resolves a beat's 0-based position within the active time-signature bar,
 * accounting for per-track beat offsets and optional Cover sync DTW alignment.
 */
export function resolveTimeSignatureBeatPosition(
  quanta: readonly QuantumBase[],
  beat: Pick<QuantumBase, "which" | "localWhich" | "trackIndex">,
  options: TimeSignatureBranchOptions = {},
): number {
  const stepBeats = resolveTimeSignatureBranchStepBeats(
    options.numerator,
    options.denominator,
  );
  const localIdx = beat.localWhich ?? beat.which;
  const trackIndex = beat.trackIndex;

  if (!options.useCoverSync || trackIndex === undefined || trackIndex === 0) {
    const trackPos = trackIndex ?? 0;
    const offset = clampTimeSignatureTrackOffset(
      options.trackOffsets?.[trackPos] ?? 0,
    );
    return positiveMod(localIdx - offset, stepBeats);
  }

  const groups = groupQuantaByTrack(quanta);
  if (groups.length < 2) {
    const offset = clampTimeSignatureTrackOffset(
      options.trackOffsets?.[trackIndex] ?? 0,
    );
    return positiveMod(localIdx - offset, stepBeats);
  }

  const trackPos = Math.max(
    1,
    groups.findIndex((beats, idx) => (beats[0]?.trackIndex ?? idx) === trackIndex),
  );
  const off0 = clampTimeSignatureTrackOffset(options.trackOffsets?.[0] ?? 0);
  const offT = clampTimeSignatureTrackOffset(
    options.trackOffsets?.[trackPos] ?? 0,
  );
  const alignmentsByTrack = getMasterCoverSyncAlignments(quanta, groups);
  const alignment = alignmentsByTrack.get(trackIndex);
  const masterBeats = groups[0];

  let firstBt: number | null = null;
  let bestAtOrBefore: number | null = null;
  if (alignment && masterBeats) {
    for (let m = 0; ; m += 1) {
      const b0 = off0 + m * stepBeats;
      if (b0 >= masterBeats.length) {
        break;
      }
      if (b0 < 0) {
        continue;
      }
      const alignedB = alignment.get(b0);
      if (alignedB === undefined) {
        continue;
      }
      const bt = alignedB + (offT - off0);
      if (firstBt === null) {
        firstBt = bt;
      }
      if (bt <= localIdx) {
        bestAtOrBefore = bt;
      } else {
        break;
      }
    }
  }

  const anchorBt = bestAtOrBefore ?? firstBt ?? offT;
  return positiveMod(localIdx - anchorBt, stepBeats);
}
