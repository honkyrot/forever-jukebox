export interface MultiTrackAudioEntry {
  buffer: AudioBuffer;
  tempoRatio?: number;
  gain?: number;
}

export interface CombineAudioOptions {
  normalizeVolume?: boolean;
}

export interface CombinedAudioResult {
  buffer: AudioBuffer;
  sliceDurations: number[];
  appliedGains: number[];
}

export interface DualAudioBufferOptions {
  tempoRatio?: number;
  normalizeVolume?: boolean;
}

export interface DualAudioBufferResult {
  mainBuffer: AudioBuffer;
  otherBuffer: AudioBuffer;
  mainDurationSec: number;
  otherDurationSec: number;
  appliedOtherGain: number;
}

export interface MultiAudioBufferResult {
  buffers: AudioBuffer[];
  durationsSec: number[];
  appliedGains: number[];
}

interface PreparedSlice {
  buffer: AudioBuffer;
  step: number;
  scaledFrames: number;
  durationSec: number;
  effectiveGain: number;
}

const RMS_GATE_THRESHOLD = 1e-3;
const MIN_AUTO_NORM_GAIN = 0.25;
const MAX_AUTO_NORM_GAIN = 4.0;
const AUTO_NORM_PEAK_CEILING = 0.98;
const OUTPUT_CLIP_CEILING = 0.99;

/**
 * Measures peak amplitude and gated RMS energy across all channels of an AudioBuffer.
 */
function measureBufferRmsAndPeak(buffer: AudioBuffer): {
  rms: number;
  peak: number;
} {
  let peak = 0;
  let gatedSumSq = 0;
  let gatedCount = 0;
  let totalSumSq = 0;
  let totalCount = 0;

  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i];
      const abs = Math.abs(sample);
      if (abs > peak) {
        peak = abs;
      }
      const sq = sample * sample;
      totalSumSq += sq;
      totalCount += 1;
      if (abs >= RMS_GATE_THRESHOLD) {
        gatedSumSq += sq;
        gatedCount += 1;
      }
    }
  }

  if (gatedCount > 0) {
    return { rms: Math.sqrt(gatedSumSq / gatedCount), peak };
  }
  return {
    rms: totalCount > 0 ? Math.sqrt(totalSumSq / totalCount) : 0,
    peak,
  };
}

function clampSample(sample: number): number {
  return Math.max(-OUTPUT_CLIP_CEILING, Math.min(OUTPUT_CLIP_CEILING, sample));
}

/**
 * Computes resampling step, output frame count, and effective gain for one
 * audio buffer slice against a target context sample rate.
 */
function prepareSlice(
  buffer: AudioBuffer,
  targetSampleRate: number,
  tempoRatioInput: number | undefined,
  normGain: number,
  userGainInput: number | undefined,
): PreparedSlice {
  const tempoRatio =
    tempoRatioInput && Number.isFinite(tempoRatioInput) && tempoRatioInput > 0
      ? tempoRatioInput
      : 1;
  const sourceSampleRate =
    Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
      ? buffer.sampleRate
      : targetSampleRate;
  // Combined step maps one output frame at targetSampleRate to source frames.
  const step = (sourceSampleRate / targetSampleRate) * tempoRatio;
  const scaledFrames = Math.max(1, Math.round(buffer.length / step));
  const userGain =
    userGainInput !== undefined &&
    Number.isFinite(userGainInput) &&
    userGainInput >= 0
      ? userGainInput
      : 1;
  return {
    buffer,
    step,
    scaledFrames,
    durationSec: scaledFrames / targetSampleRate,
    effectiveGain: normGain * userGain,
  };
}

/**
 * Computes bounded RMS-matching normalization gain to bring an entry's level
 * in line with the reference RMS without exceeding peak headroom.
 */
function computeAutoNormGain(
  entryStats: { rms: number; peak: number },
  referenceRms: number,
): number {
  if (entryStats.rms <= 0 || referenceRms <= 0) {
    return 1;
  }
  let normGain = Math.max(
    MIN_AUTO_NORM_GAIN,
    Math.min(MAX_AUTO_NORM_GAIN, referenceRms / entryStats.rms),
  );
  if (entryStats.peak > 0) {
    normGain = Math.min(normGain, AUTO_NORM_PEAK_CEILING / entryStats.peak);
  }
  return normGain;
}

/**
 * Copies and resamples a prepared slice into a destination buffer starting at
 * `frameOffset`, applying linear interpolation and output ceiling clamping.
 */
function writeSliceToBuffer(
  slice: PreparedSlice,
  destination: AudioBuffer,
  frameOffset: number,
): void {
  const targetChannels = destination.numberOfChannels;
  const sourceChannels = slice.buffer.numberOfChannels;
  const gain = slice.effectiveGain;
  const applyGain = gain !== 1;
  for (let ch = 0; ch < targetChannels; ch += 1) {
    const dst = destination.getChannelData(ch);
    // Upmix mono sources across all channels so stereo mixes stay centered.
    const src = slice.buffer.getChannelData(Math.min(ch, sourceChannels - 1));
    const srcLen = src.length;
    if (srcLen === 0) {
      continue;
    }
    if (slice.step === 1 && slice.scaledFrames === srcLen && !applyGain) {
      dst.set(src, frameOffset);
    } else if (slice.step === 1 && slice.scaledFrames === srcLen) {
      for (let i = 0; i < srcLen; i += 1) {
        dst[frameOffset + i] = clampSample(src[i] * gain);
      }
    } else {
      for (let i = 0; i < slice.scaledFrames; i += 1) {
        const pos = i * slice.step;
        const idx0 = Math.min(srcLen - 1, Math.floor(pos));
        const idx1 = Math.min(srcLen - 1, idx0 + 1);
        const frac = pos - idx0;
        const sample = src[idx0] * (1 - frac) + src[idx1] * frac;
        dst[frameOffset + i] = applyGain ? clampSample(sample * gain) : sample;
      }
    }
  }
}

/**
 * Concatenates multiple decoded AudioBuffers into one unified buffer, resampling
 * each slice to match the target context sample rate, optional tempoRatio, and
 * optional RMS volume normalization / per-track gain trim.
 */
export function combineAudioBuffers(
  context: BaseAudioContext,
  entries: MultiTrackAudioEntry[],
  options?: CombineAudioOptions,
): CombinedAudioResult {
  const targetSampleRate = context.sampleRate;
  if (entries.length === 0) {
    return {
      buffer: context.createBuffer(1, 1, targetSampleRate),
      sliceDurations: [],
      appliedGains: [],
    };
  }

  const maxChannels = Math.max(
    1,
    ...entries.map((entry) => entry.buffer.numberOfChannels),
  );

  const normalizeVolume = Boolean(options?.normalizeVolume) && entries.length >= 2;
  const stats = entries.map((entry) => measureBufferRmsAndPeak(entry.buffer));
  const masterRms = stats[0]?.rms ?? 0;

  const slices = entries.map((entry, index) => {
    const normGain =
      normalizeVolume && index > 0
        ? computeAutoNormGain(stats[index], masterRms)
        : 1;
    return prepareSlice(
      entry.buffer,
      targetSampleRate,
      entry.tempoRatio,
      normGain,
      entry.gain,
    );
  });

  const totalFrames = Math.max(
    1,
    slices.reduce((sum, slice) => sum + slice.scaledFrames, 0),
  );
  const combined = context.createBuffer(
    maxChannels,
    totalFrames,
    targetSampleRate,
  );

  let frameOffset = 0;
  for (const slice of slices) {
    writeSliceToBuffer(slice, combined, frameOffset);
    frameOffset += slice.scaledFrames;
  }

  return {
    buffer: combined,
    sliceDurations: slices.map((slice) => slice.durationSec),
    appliedGains: slices.map((slice) => slice.effectiveGain),
  };
}

/**
 * Prepares two separate AudioBuffers for dual-stream playback (such as
 * Autocanonizer mix mode), resampling the secondary buffer to match the target
 * context sample rate and tempo ratio and optionally normalizing its RMS level
 * to match the primary buffer.
 */
export function prepareDualAudioBuffers(
  context: BaseAudioContext,
  mainBuffer: AudioBuffer,
  otherBuffer: AudioBuffer,
  options?: DualAudioBufferOptions,
): DualAudioBufferResult {
  const targetSampleRate = context.sampleRate;
  const normalizeVolume = options?.normalizeVolume ?? true;
  const mainSlice = prepareSlice(mainBuffer, targetSampleRate, 1, 1, 1);

  const mainStats = measureBufferRmsAndPeak(mainBuffer);
  const otherStats = measureBufferRmsAndPeak(otherBuffer);
  const normGain = normalizeVolume
    ? computeAutoNormGain(otherStats, mainStats.rms)
    : 1;
  const otherSlice = prepareSlice(
    otherBuffer,
    targetSampleRate,
    options?.tempoRatio,
    normGain,
    1,
  );

  // Reuse the original buffer directly when sample rate, step, and gain need no transform.
  const preparedMain =
    mainSlice.step === 1 && mainSlice.scaledFrames === mainBuffer.length
      ? mainBuffer
      : (() => {
          const out = context.createBuffer(
            Math.max(1, mainBuffer.numberOfChannels),
            mainSlice.scaledFrames,
            targetSampleRate,
          );
          writeSliceToBuffer(mainSlice, out, 0);
          return out;
        })();

  const preparedOther =
    otherSlice.step === 1 &&
    otherSlice.scaledFrames === otherBuffer.length &&
    otherSlice.effectiveGain === 1
      ? otherBuffer
      : (() => {
          const out = context.createBuffer(
            Math.max(1, otherBuffer.numberOfChannels),
            otherSlice.scaledFrames,
            targetSampleRate,
          );
          writeSliceToBuffer(otherSlice, out, 0);
          return out;
        })();

  return {
    mainBuffer: preparedMain,
    otherBuffer: preparedOther,
    mainDurationSec: mainSlice.durationSec,
    otherDurationSec: otherSlice.durationSec,
    appliedOtherGain: otherSlice.effectiveGain,
  };
}

/**
 * Prepares N separate resampled and optionally RMS-normalized AudioBuffers for
 * simultaneous multi-track playback modes such as Song Sync.
 */
export function prepareMultiAudioBuffers(
  context: BaseAudioContext,
  entries: MultiTrackAudioEntry[],
  options?: CombineAudioOptions,
): MultiAudioBufferResult {
  const targetSampleRate = context.sampleRate;
  if (entries.length === 0) {
    return {
      buffers: [],
      durationsSec: [],
      appliedGains: [],
    };
  }

  const normalizeVolume = Boolean(options?.normalizeVolume) && entries.length >= 2;
  const stats = entries.map((entry) => measureBufferRmsAndPeak(entry.buffer));
  const masterRms = stats[0]?.rms ?? 0;

  const buffers: AudioBuffer[] = [];
  const durationsSec: number[] = [];
  const appliedGains: number[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normGain =
      normalizeVolume && index > 0
        ? computeAutoNormGain(stats[index], masterRms)
        : 1;
    const slice = prepareSlice(
      entry.buffer,
      targetSampleRate,
      entry.tempoRatio,
      normGain,
      entry.gain,
    );
    const canReuse =
      slice.step === 1 &&
      slice.scaledFrames === entry.buffer.length &&
      slice.effectiveGain === 1;
    if (canReuse) {
      buffers.push(entry.buffer);
    } else {
      const out = context.createBuffer(
        Math.max(1, entry.buffer.numberOfChannels),
        slice.scaledFrames,
        targetSampleRate,
      );
      writeSliceToBuffer(slice, out, 0);
      buffers.push(out);
    }
    durationsSec.push(slice.durationSec);
    appliedGains.push(slice.effectiveGain);
  }

  return {
    buffers,
    durationsSec,
    appliedGains,
  };
}
