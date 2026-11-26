import type { TFunction } from "i18next";
import type { JukeboxAudioMode } from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import { MAX_RANDOM_BRANCH_DELTA } from "@forever-jukebox/shared/constants/playback";

export const RANDOM_BRANCH_DELTA_PERCENT_SCALE = 100 / MAX_RANDOM_BRANCH_DELTA;
export const MIN_JUMP_DISTANCE_OPTIONS = [0, 5, 10, 20, 30] as const;

export type ExtrasFormState = {
  branchStatsEnabled: boolean;
  bringItHomeMode: boolean;
  customAnchorEnabled: boolean;
  audioMode: JukeboxAudioMode;
  audioIntensity: number;
  metronomeVolumePct: number;
  metronomeBeatsPerBar: number | null;
  metronomeBeatOffset: number;
};

export type TuneFormState = {
  threshold: number;
  computedThreshold: number;
  crossThreshold: number;
  computedCrossThreshold: number | null;
  maxBranches: number;
  minProb: number;
  maxProb: number;
  ramp: number;
  volume: number;
  highlightAnchorBranch: boolean;
  justBackwards: boolean;
  minLongBranchPercent: number;
  maxLongBranchPercent: number;
  removeSequentialBranches: boolean;
};

export function formatMinJumpDistance(percent: number, t: TFunction) {
  return percent === 0
    ? t("tuning.anyDistance")
    : t("tuning.percentOfTrack", { percent });
}

export function formatMaxJumpDistance(percent: number, t: TFunction) {
  return percent <= 0 || percent >= 100
    ? t("tuning.anyDistance")
    : t("tuning.maxJumpPercentOfTrack", { percent });
}

// Volume and anchor highlight are sticky preferences, not resettable tuning.
export function tuneFormChanged(previous: TuneFormState, next: TuneFormState): boolean {
  return (
    previous.threshold !== next.threshold ||
    previous.crossThreshold !== next.crossThreshold ||
    previous.maxBranches !== next.maxBranches ||
    previous.minProb !== next.minProb ||
    previous.maxProb !== next.maxProb ||
    previous.ramp !== next.ramp ||
    previous.justBackwards !== next.justBackwards ||
    previous.minLongBranchPercent !== next.minLongBranchPercent ||
    previous.maxLongBranchPercent !== next.maxLongBranchPercent ||
    previous.removeSequentialBranches !== next.removeSequentialBranches
  );
}
