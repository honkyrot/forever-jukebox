import type { CanonizerBeat } from "./AutocanonizerViz";

// Share of the mix given to the main voice; the other voice gets the rest.
export const CANONIZER_MASTER_BLEND = 0.55;
// Voice blend weights in 3-voice single-song trio mode (Blue + Green + Gold).
export const TRIO_MAIN_BLEND = 0.4;
export const TRIO_BRANCH_BLEND = 0.3;
// Voice blend weights in 4-voice single-song quad mode (Blue + Green + Gold + Pink).
export const SINGLE_QUAD_MAIN_BLEND = 0.31;
export const SINGLE_QUAD_BRANCH_BLEND = 0.23;
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
  trioMode?: boolean;
  singleVoiceCount?: 2 | 3 | 4;
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
  const singleVoiceCount: 2 | 3 | 4 =
    quadMode || isDual
      ? 2
      : (options.singleVoiceCount ?? (options.trioMode ? 3 : 2));
  const isSingleMultiVoice = singleVoiceCount >= 3;
  const mainGainScale = clampStreamGain(options.mainGain);
  const otherGainScale = clampStreamGain(options.otherGain);
  const pinkGainScale = clampStreamGain(options.pinkGain);
  const goldGainScale = clampStreamGain(options.goldGain);

  const mainWeight = quadMode
    ? QUAD_MAIN_BLEND
    : singleVoiceCount === 4
      ? SINGLE_QUAD_MAIN_BLEND
      : singleVoiceCount === 3
        ? TRIO_MAIN_BLEND
        : CANONIZER_MASTER_BLEND;
  const otherWeight = quadMode
    ? QUAD_BRANCH_BLEND
    : singleVoiceCount === 4
      ? SINGLE_QUAD_BRANCH_BLEND
      : singleVoiceCount === 3
        ? TRIO_BRANCH_BLEND
        : 1 - CANONIZER_MASTER_BLEND;
  const goldWeight = quadMode
    ? QUAD_BRANCH_BLEND
    : singleVoiceCount === 4
      ? SINGLE_QUAD_BRANCH_BLEND
      : TRIO_BRANCH_BLEND;
  const pinkWeight = quadMode ? QUAD_MAIN_BLEND : SINGLE_QUAD_BRANCH_BLEND;

  const other: CanonizerRenderSegment[] = [];
  const pink: CanonizerRenderSegment[] = [];
  const gold: CanonizerRenderSegment[] = [];
  const otherGain = (beat: CanonizerBeat) =>
    otherWeight * otherGainScale * clamp01(beat.otherGain);
  const pinkGain = (beat: CanonizerBeat) =>
    pinkWeight * pinkGainScale * clamp01(beat.pinkGain);
  const goldGain = (beat: CanonizerBeat) =>
    goldWeight * goldGainScale * clamp01(beat.goldGain);

  let time = 0;
  let otherOffset = 0;
  let pinkOffset = 0;
  let goldOffset = 0;
  let skew = 0;
  let pinkSkew = 0;
  let goldSkew = 0;
  let pinkWasActive = false;
  let goldWasActive = false;
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
    } else if (isSingleMultiVoice) {
      const beatGoldGain = clamp01(beat.goldGain, 0);
      if (!beat.gold || beatGoldGain === 0) {
        goldSkew = 0;
        goldWasActive = false;
        gold.push({
          outputStart: time,
          duration,
          sourceOffset: 0,
          gain: 0,
        });
      } else {
        if (
          !goldWasActive ||
          previous?.gold?.next !== beat.gold ||
          Math.abs(goldSkew) > CANONIZER_MAX_SKEW_DELTA
        ) {
          goldSkew = 0;
          goldOffset = beat.gold.start - time;
        }
        goldSkew += beat.duration - beat.gold.duration;
        goldWasActive = true;
        gold.push({
          outputStart: time,
          duration,
          sourceOffset: goldOffset,
          gain: goldGain(beat),
        });
      }

      if (singleVoiceCount === 4) {
        const beatPinkGain = clamp01(beat.pinkGain, 0);
        if (!beat.pink || beatPinkGain === 0) {
          pinkSkew = 0;
          pinkWasActive = false;
          pink.push({
            outputStart: time,
            duration,
            sourceOffset: 0,
            gain: 0,
          });
        } else {
          if (
            !pinkWasActive ||
            previous?.pink?.next !== beat.pink ||
            Math.abs(pinkSkew) > CANONIZER_MAX_SKEW_DELTA
          ) {
            pinkSkew = 0;
            pinkOffset = beat.pink.start - time;
          }
          pinkSkew += beat.duration - beat.pink.duration;
          pinkWasActive = true;
          pink.push({
            outputStart: time,
            duration,
            sourceOffset: pinkOffset,
            gain: pinkGain(beat),
          });
        }
      }
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
    if (isSingleMultiVoice) {
      const finalBeat = beats[finalIndex];
      const rawOtherIdx = finalBeat?.other ? finalBeat.other.which : 0;
      let otherIdx: number | null =
        rawOtherIdx >= 0 && rawOtherIdx < beats.length ? rawOtherIdx : null;
      const rawGoldIdx =
        finalBeat?.gold && clamp01(finalBeat.goldGain, 0) > 0
          ? finalBeat.gold.which
          : null;
      let goldIdx: number | null =
        rawGoldIdx !== null && rawGoldIdx >= 0 && rawGoldIdx < beats.length
          ? rawGoldIdx
          : null;
      const rawPinkIdx =
        singleVoiceCount === 4 &&
        finalBeat?.pink &&
        clamp01(finalBeat.pinkGain, 0) > 0
          ? finalBeat.pink.which
          : null;
      let pinkIdx: number | null =
        rawPinkIdx !== null && rawPinkIdx >= 0 && rawPinkIdx < beats.length
          ? rawPinkIdx
          : null;
      let prevOtherBeat: CanonizerBeat | undefined = previous?.other;
      let prevGoldBeat: CanonizerBeat | undefined = goldWasActive
        ? previous?.gold
        : undefined;
      let prevPinkBeat: CanonizerBeat | undefined = pinkWasActive
        ? previous?.pink
        : undefined;

      // Play all active canon branches (Green, Gold, Pink) out to the end of the track.
      while (otherIdx !== null || goldIdx !== null || pinkIdx !== null) {
        const otherBeat = otherIdx !== null ? beats[otherIdx] : null;
        const goldBeat = goldIdx !== null ? beats[goldIdx] : null;
        const pinkBeat = pinkIdx !== null ? beats[pinkIdx] : null;
        const clockBeat = otherBeat ?? goldBeat ?? pinkBeat;
        if (!clockBeat) {
          break;
        }

        let duration = 0;
        if (otherBeat) {
          if (prevOtherBeat?.next !== otherBeat) {
            otherOffset = otherBeat.start - time;
          }
          duration = Math.max(
            0,
            otherBeat.start + otherBeat.duration - (time + otherOffset),
          );
          other.push({
            outputStart: time,
            duration,
            sourceOffset: otherOffset,
            gain: otherGain(otherBeat),
          });
        } else if (goldBeat) {
          if (prevGoldBeat?.next !== goldBeat) {
            goldOffset = goldBeat.start - time;
          }
          duration = Math.max(
            0,
            goldBeat.start + goldBeat.duration - (time + goldOffset),
          );
        } else if (pinkBeat) {
          if (prevPinkBeat?.next !== pinkBeat) {
            pinkOffset = pinkBeat.start - time;
          }
          duration = Math.max(
            0,
            pinkBeat.start + pinkBeat.duration - (time + pinkOffset),
          );
        }

        if (goldBeat) {
          if (otherBeat) {
            if (
              prevGoldBeat?.next !== goldBeat ||
              Math.abs(goldSkew) > CANONIZER_MAX_SKEW_DELTA
            ) {
              goldSkew = 0;
              goldOffset = goldBeat.start - time;
            }
            goldSkew += clockBeat.duration - goldBeat.duration;
          }
          gold.push({
            outputStart: time,
            duration,
            sourceOffset: goldOffset,
            gain: goldWeight * goldGainScale,
          });
          prevGoldBeat = goldBeat;
          goldIdx = goldIdx! + 1 < beats.length ? goldIdx! + 1 : null;
        }

        if (pinkBeat) {
          if (otherBeat || goldBeat) {
            if (
              prevPinkBeat?.next !== pinkBeat ||
              Math.abs(pinkSkew) > CANONIZER_MAX_SKEW_DELTA
            ) {
              pinkSkew = 0;
              pinkOffset = pinkBeat.start - time;
            }
            pinkSkew += clockBeat.duration - pinkBeat.duration;
          }
          pink.push({
            outputStart: time,
            duration,
            sourceOffset: pinkOffset,
            gain: pinkWeight * pinkGainScale,
          });
          prevPinkBeat = pinkBeat;
          pinkIdx = pinkIdx! + 1 < beats.length ? pinkIdx! + 1 : null;
        }

        if (otherBeat) {
          prevOtherBeat = otherBeat;
          otherIdx = otherIdx! + 1 < beats.length ? otherIdx! + 1 : null;
        }
        time += duration;
      }
    } else {
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
  } else if (isSingleMultiVoice) {
    voices.push({ pan: options.goldPan ?? 0, sourceIndex: 0, segments: gold });
    if (singleVoiceCount === 4) {
      voices.push({ pan: options.pinkPan ?? 0, sourceIndex: 0, segments: pink });
    }
  }

  return {
    durationSeconds: time,
    voices,
  };
}
