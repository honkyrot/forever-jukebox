import { describe, expect, it } from "vitest";
import { prepareDualAudioBuffers } from "./multiTrackBuffer";

function createFakeAudioBuffer(
  channels: Float32Array[],
  sampleRate = 1000,
): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

function createFakeAudioContext(sampleRate = 1000): BaseAudioContext {
  return {
    sampleRate,
    createBuffer: (numberOfChannels: number, length: number, rate: number) => {
      const channels = Array.from(
        { length: numberOfChannels },
        () => new Float32Array(length),
      );
      return createFakeAudioBuffer(channels, rate);
    },
  } as unknown as BaseAudioContext;
}

describe("prepareDualAudioBuffers", () => {
  it("resamples the secondary buffer to match tempoRatio without altering mainBuffer", () => {
    const context = createFakeAudioContext(1000);
    const main = createFakeAudioBuffer([new Float32Array(1000).fill(0.2)], 1000);
    const other = createFakeAudioBuffer([new Float32Array(2000).fill(0.2)], 1000);

    const result = prepareDualAudioBuffers(context, main, other, {
      tempoRatio: 2,
      normalizeVolume: false,
    });

    expect(result.mainBuffer).toBe(main);
    expect(result.mainDurationSec).toBeCloseTo(1);
    expect(result.otherDurationSec).toBeCloseTo(1);
    expect(result.otherBuffer.length).toBe(1000);
    expect(result.appliedOtherGain).toBe(1);
  });

  it("normalizes secondary RMS loudness toward mainBuffer while respecting peak headroom", () => {
    const context = createFakeAudioContext(1000);
    const mainData = new Float32Array(100).fill(0.4);
    const otherData = new Float32Array(100).fill(0.1);
    const main = createFakeAudioBuffer([mainData], 1000);
    const other = createFakeAudioBuffer([otherData], 1000);

    const result = prepareDualAudioBuffers(context, main, other, {
      tempoRatio: 1,
      normalizeVolume: true,
    });

    expect(result.appliedOtherGain).toBeCloseTo(4);
    expect(result.otherBuffer.getChannelData(0)[0]).toBeCloseTo(0.4);

    // A high peak in other caps normalization below AUTO_NORM_PEAK_CEILING (0.98).
    const spikyOtherData = new Float32Array(100).fill(0.1);
    spikyOtherData[10] = 0.5;
    const spikyOther = createFakeAudioBuffer([spikyOtherData], 1000);

    const capped = prepareDualAudioBuffers(context, main, spikyOther, {
      tempoRatio: 1,
      normalizeVolume: true,
    });

    expect(capped.appliedOtherGain).toBeCloseTo(0.98 / 0.5);
    expect(capped.otherBuffer.getChannelData(0)[10]).toBeLessThanOrEqual(0.99);
  });
});
