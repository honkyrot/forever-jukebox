export interface TrackMeta {
  title?: string;
  artist?: string;
  duration?: number;
  tempo?: number;
  time_signature?: number;
  bpm_multiplier?: number;
}

export interface TrackSliceMeta {
  trackIndex: number;
  title?: string;
  artist?: string;
  duration: number;
  tempo?: number;
  tempoRatio: number;
  startTimeOffset: number;
  startBeatIndex: number;
  beatCount: number;
}

export interface QuantumBase {
  start: number;
  duration: number;
  confidence?: number;
  which: number;
  trackIndex?: number;
  localWhich?: number;
  trackBeatCount?: number;
  prev: QuantumBase | null;
  next: QuantumBase | null;
  parent?: QuantumBase;
  children?: QuantumBase[];
  indexInParent?: number;
  overlappingSegments: Segment[];
  oseg?: Segment | null;
  neighbors: Edge[];
  allNeighbors: Edge[];
  reach?: number;
}

export interface Segment {
  start: number;
  duration: number;
  confidence: number;
  loudness_start: number;
  loudness_max: number;
  loudness_max_time: number;
  pitches: number[];
  timbre: number[];
  which: number;
}

export type TimeSignatureBranchMode = "overwrite" | "combine";

export interface Edge {
  id: number;
  src: QuantumBase;
  dest: QuantumBase;
  distance: number;
  deleted: boolean;
  // Marks cross-track edges tied to a time-signature bar boundary so they
  // bypass threshold, direction, jump-span, sequential, and anchor-tail filters.
  timeSignature?: boolean;
  // Marks time-signature bar edges synthesized outside the similarity pool so
  // auto-threshold sweeps skip them and preserve the base similarity default.
  timeSignatureForced?: boolean;
}

export interface TrackAnalysis {
  sections: QuantumBase[];
  bars: QuantumBase[];
  beats: QuantumBase[];
  tatums: QuantumBase[];
  segments: Segment[];
  track?: TrackMeta;
  tracks?: TrackSliceMeta[];
}

export interface JukeboxConfig {
  maxBranches: number;
  maxBranchThreshold: number;
  currentThreshold: number;
  // Similarity threshold for cross-song edges in multi-track mixes (0 = auto).
  crossTrackThreshold?: number;
  justBackwards: boolean;
  justLongBranches: boolean;
  removeSequentialBranches: boolean;
  minRandomBranchChance: number;
  maxRandomBranchChance: number;
  randomBranchChanceDelta: number;
  minLongBranch: number;
  minLongBranchPercent?: number;
  maxLongBranch?: number;
  maxLongBranchPercent?: number;
  crossTrackOnly?: boolean;
  // Aligns cross-song branches across covers using chroma/dynamics DTW.
  coverSync?: boolean;
  // Overwrites or combines similarity-based branches in multi-track mixes with
  // cross-song branches placed on time-signature bar boundaries.
  timeSignatureBranching?: boolean;
  // Controls whether time-signature bar edges overwrite similarity branches or
  // combine with them (default: "overwrite").
  timeSignatureBranchMode?: TimeSignatureBranchMode;
  // Time signature numerator (default 4) for multi-track boundary branching.
  timeSignatureNumerator?: number;
  // Time signature denominator (default 4) for multi-track boundary branching.
  timeSignatureDenominator?: number;
  // Per-track integer beat offsets for multi-track time-signature branching.
  timeSignatureTrackOffsets?: number[];
  // Restricts similarity-based branches in multi-track mixes strictly to
  // time-signature bar boundaries.
  timeSignatureSimilarityRestrict?: boolean;
  // Time signature numerator (default 4) for similarity bar-boundary restriction.
  timeSignatureSimilarityNumerator?: number;
  // Time signature denominator (default 4) for similarity bar-boundary restriction.
  timeSignatureSimilarityDenominator?: number;
}

export interface JukeboxGraphState {
  computedThreshold: number;
  currentThreshold: number;
  computedCrossThreshold?: number;
  currentCrossThreshold?: number;
  lastBranchPoint: number;
  totalBeats: number;
  longestReach: number;
  allEdges: Edge[];
}

export interface PredictedJump {
  fromIndex: number;
  toIndex: number;
  edgeId: number | null;
  sequenceIndex?: number;
}

export interface JukeboxState {
  currentBeatIndex: number;
  beatsPlayed: number;
  currentTime: number;
  lastJumped: boolean;
  lastJumpTime: number | null;
  lastJumpFromIndex: number | null;
  lastJumpToIndex: number | null;
  currentThreshold: number;
  lastBranchPoint: number;
  curRandomBranchChance: number;
}
