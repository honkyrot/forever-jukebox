import type { Edge, QuantumBase } from "./types";

const CHROMA_BINS = 12;
const TIMBRE_BINS = 12;
const DIAGONAL_OFFSETS = [-2, -1, 0, 1, 2] as const;
const DIAGONAL_WEIGHTS = [0.5, 0.75, 1.0, 0.75, 0.5] as const;
const DTW_WARP_PENALTY = 8;
const MAX_PAIRWISE_DTW_TRACKS = 8;

export interface BeatFeature {
  chroma: number[];
  hasChroma: boolean;
  centeredTimbre: number[];
  relLoudness: number;
  duration: number;
}

export interface AlignedBeatPair {
  indexA: number;
  indexB: number;
  distance: number;
}

function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function medianPositiveDuration(features: readonly BeatFeature[]): number {
  const durations = features
    .map((f) => f.duration)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return 0;
  }
  return durations[Math.floor(durations.length / 2)];
}

/**
 * Extracts duration-weighted chroma, per-track centered timbre, and relative
 * loudness features for each beat so cover comparisons resist singer timbre
 * shifts, mastering level differences, and segment split variations.
 */
export function extractTrackBeatFeatures(
  beats: readonly QuantumBase[],
): BeatFeature[] {
  if (beats.length === 0) {
    return [];
  }

  const rawChromaList: number[][] = [];
  const hasChromaList: boolean[] = [];
  const rawTimbreList: number[][] = [];
  const rawLoudnessList: number[] = [];

  for (const beat of beats) {
    const chroma = new Array<number>(CHROMA_BINS).fill(0);
    const timbre = new Array<number>(TIMBRE_BINS).fill(0);
    let loudness = 0;
    let hasChroma = false;

    const segments = beat.overlappingSegments;
    if (segments.length > 0) {
      const beatStart = beat.start;
      const beatEnd = beat.start + beat.duration;
      const weights = new Array<number>(segments.length);
      let totalWeight = 0;

      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const overlap = Math.max(
          0,
          Math.min(beatEnd, seg.start + seg.duration) -
            Math.max(beatStart, seg.start),
        );
        weights[i] = overlap;
        totalWeight += overlap;
      }

      const useEqualWeights = totalWeight <= 0;
      const denom = useEqualWeights ? segments.length : totalWeight;

      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const weight = (useEqualWeights ? 1 : weights[i]) / denom;
        for (let k = 0; k < CHROMA_BINS && k < seg.pitches.length; k += 1) {
          chroma[k] += seg.pitches[k] * weight;
        }
        for (let k = 0; k < TIMBRE_BINS && k < seg.timbre.length; k += 1) {
          timbre[k] += seg.timbre[k] * weight;
        }
        loudness += seg.loudness_max * weight;
      }

      let normSq = 0;
      for (let k = 0; k < CHROMA_BINS; k += 1) {
        normSq += chroma[k] * chroma[k];
      }
      const norm = Math.sqrt(normSq);
      if (norm >= 1e-6) {
        for (let k = 0; k < CHROMA_BINS; k += 1) {
          chroma[k] /= norm;
        }
        hasChroma = true;
      } else {
        chroma.fill(0);
      }
    }

    rawChromaList.push(chroma);
    hasChromaList.push(hasChroma);
    rawTimbreList.push(timbre);
    rawLoudnessList.push(loudness);
  }

  // Compute per-track mean and RMS deviation for timbre and loudness so constant
  // vocal/EQ differences cancel out while section dynamics remain intact.
  const meanTimbre = new Array<number>(TIMBRE_BINS).fill(0);
  let meanLoudness = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const timbre = rawTimbreList[i];
    for (let k = 0; k < TIMBRE_BINS; k += 1) {
      meanTimbre[k] += timbre[k];
    }
    meanLoudness += rawLoudnessList[i];
  }
  for (let k = 0; k < TIMBRE_BINS; k += 1) {
    meanTimbre[k] /= beats.length;
  }
  meanLoudness /= beats.length;

  let timbreSqSum = 0;
  let loudnessSqSum = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const timbre = rawTimbreList[i];
    for (let k = 0; k < TIMBRE_BINS; k += 1) {
      const diff = timbre[k] - meanTimbre[k];
      timbreSqSum += diff * diff;
    }
    const loudDiff = rawLoudnessList[i] - meanLoudness;
    loudnessSqSum += loudDiff * loudDiff;
  }

  const timbreScale = Math.max(1, Math.sqrt(timbreSqSum / beats.length));
  const loudnessScale = Math.max(1, Math.sqrt(loudnessSqSum / beats.length));

  return beats.map((beat, i) => {
    const rawTimbre = rawTimbreList[i];
    const centeredTimbre = new Array<number>(TIMBRE_BINS);
    for (let k = 0; k < TIMBRE_BINS; k += 1) {
      centeredTimbre[k] = (rawTimbre[k] - meanTimbre[k]) / timbreScale;
    }
    return {
      chroma: rawChromaList[i],
      hasChroma: hasChromaList[i],
      centeredTimbre,
      relLoudness: (rawLoudnessList[i] - meanLoudness) / loudnessScale,
      duration: beat.duration,
    };
  });
}

/**
 * Scores similarity between two cover beats using chroma, centered timbre,
 * and relative loudness without assuming 4/4 time or matching bar positions.
 */
export function computeCoverBeatDistance(a: BeatFeature, b: BeatFeature): number {
  let chromaDist = 0;
  if (a.hasChroma && b.hasChroma) {
    chromaDist = euclideanDistance(a.chroma, b.chroma);
  } else if (a.hasChroma || b.hasChroma) {
    chromaDist = 1;
  }
  const timbreDist = Math.min(
    3,
    euclideanDistance(a.centeredTimbre, b.centeredTimbre),
  );
  const loudnessDist = Math.min(3, Math.abs(a.relLoudness - b.relLoudness));
  return chromaDist * 32 + timbreDist * 8 + loudnessDist * 5;
}

/**
 * Aligns two cover tracks via score-maximizing Semi-Global DTW over a 5-beat
 * diagonal context window (when beat grids are ~1:1), handling differing
 * intro/outro lengths as well as half-time/double-time beat grids.
 */
export function alignTrackPairDtw(
  featuresA: readonly BeatFeature[],
  featuresB: readonly BeatFeature[],
): AlignedBeatPair[] {
  const n = featuresA.length;
  const m = featuresB.length;
  if (n === 0 || m === 0) {
    return [];
  }

  const rawD = new Float32Array(n * m);
  for (let i = 0; i < n; i += 1) {
    const featA = featuresA[i];
    const rowOffset = i * m;
    for (let j = 0; j < m; j += 1) {
      rawD[rowOffset + j] = computeCoverBeatDistance(featA, featuresB[j]);
    }
  }

  const medA = medianPositiveDuration(featuresA);
  const medB = medianPositiveDuration(featuresB);
  const durationRatio = medA > 0 && medB > 0 ? medA / medB : 1;
  const isNearOneToOne = durationRatio >= 0.75 && durationRatio <= 1.33;

  let ctxD: Float32Array;
  if (isNearOneToOne) {
    ctxD = new Float32Array(n * m);
    for (let i = 0; i < n; i += 1) {
      const rowOffset = i * m;
      for (let j = 0; j < m; j += 1) {
        let weightedSum = 0;
        let weightSum = 0;
        for (let idx = 0; idx < DIAGONAL_OFFSETS.length; idx += 1) {
          const k = DIAGONAL_OFFSETS[idx];
          const ii = i + k;
          const jj = j + k;
          if (ii >= 0 && ii < n && jj >= 0 && jj < m) {
            const w = DIAGONAL_WEIGHTS[idx];
            weightedSum += rawD[ii * m + jj] * w;
            weightSum += w;
          }
        }
        ctxD[rowOffset + j] = weightSum > 0 ? weightedSum / weightSum : rawD[rowOffset + j];
      }
    }
  } else {
    ctxD = rawD;
  }

  const totalCells = n * m;
  const stride = Math.max(1, Math.floor(totalCells / 2048));
  const samples: number[] = [];
  for (let idx = 0; idx < totalCells; idx += stride) {
    samples.push(ctxD[idx]);
  }
  samples.sort((a, b) => a - b);
  const medianDist = samples[Math.floor(samples.length / 2)] ?? 0;
  const baseline = Math.max(15, Math.min(55, medianDist * 0.85));

  const dp = new Float32Array(totalCells);
  // 0 = path start, 1 = (1,1) diagonal, 2 = (1,2) horizontal warp, 3 = (2,1) vertical warp
  const back = new Uint8Array(totalCells);

  // Free start along top row and left column so differing intros stay unpenalized.
  for (let j = 0; j < m; j += 1) {
    dp[j] = 2 * (baseline - ctxD[j]);
    back[j] = 0;
  }
  for (let i = 1; i < n; i += 1) {
    const idx = i * m;
    dp[idx] = 2 * (baseline - ctxD[idx]);
    back[idx] = 0;
  }

  for (let i = 1; i < n; i += 1) {
    const rowOffset = i * m;
    const prevRowOffset = (i - 1) * m;
    const prev2RowOffset = (i - 2) * m;
    for (let j = 1; j < m; j += 1) {
      const sCur = baseline - ctxD[rowOffset + j];
      let bestScore = dp[prevRowOffset + (j - 1)] + 2 * sCur;
      let bestBack = 1;

      if (j >= 2) {
        const sMid = baseline - ctxD[rowOffset + (j - 1)];
        const warpHoriz =
          dp[prevRowOffset + (j - 2)] + sMid + sCur - DTW_WARP_PENALTY;
        if (warpHoriz > bestScore) {
          bestScore = warpHoriz;
          bestBack = 2;
        }
      }
      if (i >= 2) {
        const sMid = baseline - ctxD[prevRowOffset + j];
        const warpVert =
          dp[prev2RowOffset + (j - 1)] + sMid + sCur - DTW_WARP_PENALTY;
        if (warpVert > bestScore) {
          bestScore = warpVert;
          bestBack = 3;
        }
      }

      dp[rowOffset + j] = bestScore;
      back[rowOffset + j] = bestBack;
    }
  }

  // Free end along bottom row and right column so differing outros stay unpenalized.
  let endI = n - 1;
  let endJ = m - 1;
  let bestEndScore = dp[endI * m + endJ];
  for (let j = 0; j < m; j += 1) {
    const score = dp[(n - 1) * m + j];
    if (score > bestEndScore) {
      bestEndScore = score;
      endI = n - 1;
      endJ = j;
    }
  }
  for (let i = 0; i < n; i += 1) {
    const score = dp[i * m + (m - 1)];
    if (score > bestEndScore) {
      bestEndScore = score;
      endI = i;
      endJ = m - 1;
    }
  }

  const path: AlignedBeatPair[] = [];
  let i = endI;
  let j = endJ;
  while (i >= 0 && j >= 0) {
    const idx = i * m + j;
    const step = back[idx];
    path.push({ indexA: i, indexB: j, distance: ctxD[idx] });
    if (step === 0) {
      break;
    }
    if (step === 1) {
      i -= 1;
      j -= 1;
    } else if (step === 2) {
      path.push({
        indexA: i,
        indexB: j - 1,
        distance: ctxD[i * m + (j - 1)],
      });
      i -= 1;
      j -= 2;
    } else {
      path.push({
        indexA: i - 1,
        indexB: j,
        distance: ctxD[(i - 1) * m + j],
      });
      i -= 2;
      j -= 1;
    }
  }

  path.reverse();
  return path;
}

/**
 * Builds aligned cross-track candidate edges across merged tracks via DTW,
 * retaining the closest aligned destination beat per target track for each beat.
 */
export function buildCoverSyncCrossEdges(
  quanta: readonly QuantumBase[],
  maxThreshold: number,
): Map<number, Edge[]> {
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

  const groups = [...groupMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, beats]) => beats);
  if (groups.length < 2) {
    return new Map();
  }

  const featuresByTrack = groups.map((beats) => extractTrackBeatFeatures(beats));
  const bestBySrcAndTrack = new Map<number, Map<number, Edge>>();

  const recordBest = (src: QuantumBase, dest: QuantumBase, distance: number) => {
    if (
      !Number.isFinite(distance) ||
      distance >= maxThreshold ||
      dest.trackIndex === undefined
    ) {
      return;
    }
    let perTargetTrack = bestBySrcAndTrack.get(src.which);
    if (!perTargetTrack) {
      perTargetTrack = new Map<number, Edge>();
      bestBySrcAndTrack.set(src.which, perTargetTrack);
    }
    const existing = perTargetTrack.get(dest.trackIndex);
    if (!existing || distance < existing.distance) {
      perTargetTrack.set(dest.trackIndex, {
        id: -1,
        src,
        dest,
        distance,
        deleted: false,
      });
    }
  };

  if (groups.length <= MAX_PAIRWISE_DTW_TRACKS) {
    for (let a = 0; a < groups.length; a += 1) {
      const beatsA = groups[a];
      const featuresA = featuresByTrack[a];
      for (let b = a + 1; b < groups.length; b += 1) {
        const beatsB = groups[b];
        const featuresB = featuresByTrack[b];
        const aligned = alignTrackPairDtw(featuresA, featuresB);
        for (const pair of aligned) {
          recordBest(beatsA[pair.indexA], beatsB[pair.indexB], pair.distance);
          recordBest(beatsB[pair.indexB], beatsA[pair.indexA], pair.distance);
        }
      }
    }
  } else {
    // For large mixes, align every secondary track to track 0 and derive pairs
    // between secondary tracks through shared track-0 beats.
    const beats0 = groups[0];
    const features0 = featuresByTrack[0];
    const track0ToSecondary = Array.from(
      { length: groups.length },
      () => new Map<number, { indexT: number; distance: number }>(),
    );

    for (let t = 1; t < groups.length; t += 1) {
      const beatsT = groups[t];
      const featuresT = featuresByTrack[t];
      const aligned = alignTrackPairDtw(features0, featuresT);
      const mapT = track0ToSecondary[t];
      for (const pair of aligned) {
        recordBest(beats0[pair.indexA], beatsT[pair.indexB], pair.distance);
        recordBest(beatsT[pair.indexB], beats0[pair.indexA], pair.distance);
        const prev = mapT.get(pair.indexA);
        if (!prev || pair.distance < prev.distance) {
          mapT.set(pair.indexA, {
            indexT: pair.indexB,
            distance: pair.distance,
          });
        }
      }
    }

    for (let t1 = 1; t1 < groups.length; t1 += 1) {
      const beats1 = groups[t1];
      const features1 = featuresByTrack[t1];
      const map1 = track0ToSecondary[t1];
      for (let t2 = t1 + 1; t2 < groups.length; t2 += 1) {
        const beats2 = groups[t2];
        const features2 = featuresByTrack[t2];
        const map2 = track0ToSecondary[t2];
        for (const [index0, entry1] of map1.entries()) {
          const entry2 = map2.get(index0);
          if (!entry2) {
            continue;
          }
          const distance = computeCoverBeatDistance(
            features1[entry1.indexT],
            features2[entry2.indexT],
          );
          recordBest(beats1[entry1.indexT], beats2[entry2.indexT], distance);
          recordBest(beats2[entry2.indexT], beats1[entry1.indexT], distance);
        }
      }
    }
  }

  const result = new Map<number, Edge[]>();
  for (const [srcWhich, byTrack] of bestBySrcAndTrack.entries()) {
    const edges = [...byTrack.values()].sort((a, b) => a.distance - b.distance);
    result.set(srcWhich, edges);
  }
  return result;
}
