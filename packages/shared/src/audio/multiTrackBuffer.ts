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
    const tempoRatio =
      entry.tempoRatio && Number.isFinite(entry.tempoRatio) && entry.tempoRatio > 0
        ? entry.tempoRatio
        : 1;
    const sourceSampleRate =
      Number.isFinite(entry.buffer.sampleRate) && entry.buffer.sampleRate > 0
        ? entry.buffer.sampleRate
        : targetSampleRate;
    // Combined step maps one output frame at targetSampleRate to source frames.
    const step = (sourceSampleRate / targetSampleRate) * tempoRatio;
    const scaledFrames = Math.max(1, Math.round(entry.buffer.length / step));

    let normGain = 1;
    if (normalizeVolume && index > 0) {
      const entryStats = stats[index];
      if (entryStats.rms > 0 && masterRms > 0) {
        normGain = Math.max(
          MIN_AUTO_NORM_GAIN,
          Math.min(MAX_AUTO_NORM_GAIN, masterRms / entryStats.rms),
        );
        if (entryStats.peak > 0) {
          normGain = Math.min(normGain, AUTO_NORM_PEAK_CEILING / entryStats.peak);
        }
      }
    }
    const userGain =
      entry.gain !== undefined && Number.isFinite(entry.gain) && entry.gain >= 0
        ? entry.gain
        : 1;
    const effectiveGain = normGain * userGain;

    return {
      buffer: entry.buffer,
      step,
      scaledFrames,
      durationSec: scaledFrames / targetSampleRate,
      effectiveGain,
    };
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
    const sourceChannels = slice.buffer.numberOfChannels;
    const gain = slice.effectiveGain;
    const applyGain = gain !== 1;
    for (let ch = 0; ch < maxChannels; ch += 1) {
      const dst = combined.getChannelData(ch);
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
    frameOffset += slice.scaledFrames;
  }

  return {
    buffer: combined,
    sliceDurations: slices.map((slice) => slice.durationSec),
    appliedGains: slices.map((slice) => slice.effectiveGain),
  };
}
