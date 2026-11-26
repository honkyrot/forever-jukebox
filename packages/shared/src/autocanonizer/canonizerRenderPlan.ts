import type { CanonizerBeat } from "./AutocanonizerViz";

// Share of the mix given to the main voice; the other voice gets the rest.
export const CANONIZER_MASTER_BLEND = 0.55;
// Voice blend weights in 4-voice quad mode (Song 1 Blue/Green + Song 2 Pink/Gold).
export const QUAD_MAIN_BLEND = 0.28;
export const QUAD_BRANCH_BLEND = 0.22;
// Seconds the other voice may drift from the main beats before it resyncs.
export const CANONIZER_MAX_SKEW_DELTA = 0.05;
// Tighter resync threshold for Song 2's structurally synced Pink stream.
export const QUAD_SYNC_MAX_SKEW_DELTA = 0.025;

export type CanonizerRenderSegment = {
  outputStart: number;
  duration: number;
  // Source position minus output time; constant until the voice restarts.
  sourceOffset: number;
  gain: number;
};

export type CanonizerRenderVoice = {
  pan: number;
  sourceIndex?: 0 | 1;
  segments: CanonizerRenderSegment[];
};

export type CanonizerRenderPlan = {
  durationSeconds: number;
  voices: CanonizerRenderVoice[];
};

export type PlanCanonizerRenderOptions = {
  finishOutSong: boolean;
  mainPan: number;
  otherPan: number;
  mainGain?: number;
  otherGain?: number;
  pinkPan?: number;
  pinkGain?: number;
  goldPan?: number;
  goldGain?: number;
  isDual?: boolean;
  quadMode?: boolean;
  otherBeats?: CanonizerBeat[];
};

function clamp01(value: number | undefined, fallback = 1): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function clampStreamGain(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(2, value));
}

// One pass of the canon from the first beat, timed as playback on an exact clock.
export function planCanonizerRender(
  beats: CanonizerBeat[],
  options: PlanCanonizerRenderOptions,
): CanonizerRenderPlan | null {
  if (!beats.length) {
    return null;
  }
  const finalIndex = beats.length - 1;
  const mainOffset = beats[0].start;
  const quadMode = Boolean(options.quadMode);
  const isDual = Boolean(options.isDual);
  const mainGainScale = clampStreamGain(options.mainGain);
  const otherGainScale = clampStreamGain(options.otherGain);
  const pinkGainScale = clampStreamGain(options.pinkGain);
  const goldGainScale = clampStreamGain(options.goldGain);

  const mainWeight = quadMode ? QUAD_MAIN_BLEND : CANONIZER_MASTER_BLEND;
  const otherWeight = quadMode ? QUAD_BRANCH_BLEND : 1 - CANONIZER_MASTER_BLEND;

  const other: CanonizerRenderSegment[] = [];
  const pink: CanonizerRenderSegment[] = [];
  const gold: CanonizerRenderSegment[] = [];
  const otherGain = (beat: CanonizerBeat) =>
    otherWeight * otherGainScale * clamp01(beat.otherGain);
  const pinkGain = (beat: CanonizerBeat) =>
    QUAD_MAIN_BLEND * pinkGainScale * clamp01(beat.pinkGain);
  const goldGain = (beat: CanonizerBeat) =>
    QUAD_BRANCH_BLEND * goldGainScale * clamp01(beat.goldGain);

  let time = 0;
  let otherOffset = 0;
  let pinkOffset = 0;
  let goldOffset = 0;
  let skew = 0;
  let pinkSkew = 0;
  let goldSkew = 0;
  let previous: CanonizerBeat | null = null;

  for (let index = 0; index <= finalIndex; index += 1) {
    // Finishing out stops the main voice (and Song 2 quad streams) as the final beat begins.
    if (options.finishOutSong && index === finalIndex) {
      break;
    }
    const beat = beats[index];
    if (
      previous?.other.next !== beat.other ||
      Math.abs(skew) > CANONIZER_MAX_SKEW_DELTA
    ) {
      skew = 0;
      otherOffset = beat.other.start - time;
    }
    skew += beat.duration - beat.other.duration;
    const duration = Math.max(
      0,
      beat.start + beat.duration - (time + mainOffset),
    );
    other.push({
      outputStart: time,
      duration,
      sourceOffset: otherOffset,
      gain: otherGain(beat),
    });

    if (quadMode && beat.pink && beat.gold) {
      if (
        previous?.pink?.next !== beat.pink ||
        Math.abs(pinkSkew) > QUAD_SYNC_MAX_SKEW_DELTA
      ) {
        pinkSkew = 0;
        pinkOffset = beat.pink.start - time;
      }
      pinkSkew += beat.duration - beat.pink.duration;
      pink.push({
        outputStart: time,
        duration,
        sourceOffset: pinkOffset,
        gain: pinkGain(beat),
      });

      if (
        previous?.gold?.next !== beat.gold ||
        Math.abs(goldSkew) > CANONIZER_MAX_SKEW_DELTA
      ) {
        goldSkew = 0;
        goldOffset = beat.gold.start - time;
      }
      goldSkew += beat.duration - beat.gold.duration;
      gold.push({
        outputStart: time,
        duration,
        sourceOffset: goldOffset,
        gain: goldGain(beat),
      });
    }

    time += duration;
    previous = beat;
  }

  const main: CanonizerRenderSegment[] = [
    {
      outputStart: 0,
      duration: time,
      sourceOffset: mainOffset,
      gain: mainWeight * mainGainScale,
    },
  ];

  if (options.finishOutSong) {
    // The other voice alone plays on from the final beat's partner to the end.
    const secondaryBeats =
      !quadMode && isDual && options.otherBeats?.length
        ? options.otherBeats
        : beats;
    let current: CanonizerBeat | undefined = beats[finalIndex];
    const startIndex = current?.other?.which ?? 0;
    for (let index = startIndex; index < secondaryBeats.length; index += 1) {
      const beat = secondaryBeats[index];
      if (current?.other?.next !== beat) {
        otherOffset = beat.start - time;
      }
      const duration = Math.max(
        0,
        beat.start + beat.duration - (time + otherOffset),
      );
      other.push({
        outputStart: time,
        duration,
        sourceOffset: otherOffset,
        gain: otherGain(beat),
      });
      time += duration;
      current = beat;
    }
  }

  const voices: CanonizerRenderVoice[] = [
    { pan: options.mainPan, sourceIndex: 0, segments: main },
    {
      pan: options.otherPan,
      sourceIndex: !quadMode && isDual ? 1 : 0,
      segments: other,
    },
  ];

  if (quadMode) {
    voices.push(
      { pan: options.pinkPan ?? 0, sourceIndex: 1, segments: pink },
      { pan: options.goldPan ?? 0, sourceIndex: 1, segments: gold },
    );
  }

  return {
    durationSeconds: time,
    voices,
  };
}
