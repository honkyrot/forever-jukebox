import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisOutput } from "@/shared/analysis-schema/schema";
import {
  BASE_METRONOME_GAIN,
  HI_TICK_DURATION_SECONDS,
  HI_TICK_GAIN,
  LO_TICK_DURATION_SECONDS,
  LO_TICK_GAIN,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import { planMetronomeExportEvents } from "./metronomeExport";

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

class MockOfflineAudioContext {
  readonly sampleRate: number;

  constructor(
    channelsOrOptions:
      | number
      | { numberOfChannels: number; length: number; sampleRate: number },
    _length?: number,
    sampleRate?: number,
  ) {
    this.sampleRate =
      typeof channelsOrOptions === "number"
        ? (sampleRate ?? 44_100)
        : channelsOrOptions.sampleRate;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(
      channels,
      length,
      sampleRate,
    ) as unknown as AudioBuffer;
  }
}

function makeAnalysis(beatsCount: number, beatsPerBar: number, timeSignature?: number): AnalysisOutput {
  const beats = Array.from({ length: beatsCount }, (_, index) => ({
    start: index * 0.5,
    duration: 0.5,
    confidence: 1,
  }));
  const bars = [];
  for (let i = 0; i < beatsCount; i += beatsPerBar) {
    bars.push({
      start: i * 0.5,
      duration: Math.min(beatsPerBar, beatsCount - i) * 0.5,
      confidence: 1,
    });
  }
  return {
    sections: [{ start: 0, duration: beatsCount * 0.5, confidence: 1 }],
    bars,
    beats,
    tatums: [],
    segments: [],
    track: {
      duration: beatsCount * 0.5,
      ...(timeSignature !== undefined ? { time_signature: timeSignature } : {}),
    },
  };
}

describe("planMetronomeExportEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plans hi ticks on 4/4 bar downbeats and lo ticks on remaining beats", () => {
    vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
    const analysis = makeAnalysis(8, 4, 4);
    const segments = [0, 1, 2, 3, 4, 5].map((beatIndex, idx) => ({
      outputStart: idx * 0.5,
      sourceStart: beatIndex * 0.5,
      duration: 0.5,
      beatIndex,
      jumped: false,
      jumpFromIndex: null,
    }));

    const events = planMetronomeExportEvents({
      analysis,
      segments,
      sampleRate: 48_000,
      volume: 0.5,
    });

    expect(events).toHaveLength(6);
    const expectedHiGain = HI_TICK_GAIN * BASE_METRONOME_GAIN * 0.5;
    const expectedLoGain = LO_TICK_GAIN * BASE_METRONOME_GAIN * 0.5;

    expect(events[0]).toMatchObject({
      outputStart: 0,
      gain: expectedHiGain,
      pan: 0,
    });
    expect(events[0]?.buffer.duration).toBeCloseTo(HI_TICK_DURATION_SECONDS, 4);

    expect(events[1]).toMatchObject({
      outputStart: 0.5,
      gain: expectedLoGain,
      pan: 0,
    });
    expect(events[1]?.buffer.duration).toBeCloseTo(LO_TICK_DURATION_SECONDS, 4);

    expect(events[4]).toMatchObject({
      outputStart: 2,
      gain: expectedHiGain,
      pan: 0,
    });
    expect(events[5]).toMatchObject({
      outputStart: 2.5,
      gain: expectedLoGain,
      pan: 0,
    });
  });

  it("supports 3/4 bar layouts and falls back cleanly when bars are degenerate", () => {
    vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
    const waltzAnalysis = makeAnalysis(6, 3, 3);
    const segments = [0, 1, 2, 3, 4].map((beatIndex, idx) => ({
      outputStart: idx * 0.5,
      sourceStart: beatIndex * 0.5,
      duration: 0.5,
      beatIndex,
      jumped: false,
      jumpFromIndex: null,
    }));

    const waltzEvents = planMetronomeExportEvents({
      analysis: waltzAnalysis,
      segments,
      sampleRate: 44_100,
      volume: 1,
    });
    expect(waltzEvents.map((e) => e.gain)).toEqual([
      HI_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
      HI_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
    ]);

    // Degenerate single bar covering 15 beats triggers fallback to track.time_signature = 3.
    const degenerateAnalysis = makeAnalysis(15, 15, 3);
    const fallbackEvents = planMetronomeExportEvents({
      analysis: degenerateAnalysis,
      segments,
      sampleRate: 44_100,
      volume: 1,
    });
    expect(fallbackEvents.map((e) => e.gain)).toEqual([
      HI_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
      HI_TICK_GAIN * BASE_METRONOME_GAIN,
      LO_TICK_GAIN * BASE_METRONOME_GAIN,
    ]);
  });

  it("applies metronomeVolumePct, metronomeBeatsPerBar override, and metronomeBeatOffset", () => {
    vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
    // Track has 4/4 bars, overridden to 3/4 with offset 1 and 150% metronome volume.
    const analysis = makeAnalysis(6, 4, 4);
    const segments = [0, 1, 2, 3, 4].map((beatIndex, idx) => ({
      outputStart: idx * 0.5,
      sourceStart: beatIndex * 0.5,
      duration: 0.5,
      beatIndex,
      jumped: false,
      jumpFromIndex: null,
    }));

    const events = planMetronomeExportEvents({
      analysis,
      segments,
      sampleRate: 48_000,
      volume: 1,
      metronomeVolumePct: 150,
      metronomeBeatsPerBar: 3,
      metronomeBeatOffset: 1,
    });

    const hiGain = HI_TICK_GAIN * BASE_METRONOME_GAIN * 1.5;
    const loGain = LO_TICK_GAIN * BASE_METRONOME_GAIN * 1.5;
    // 3/4 with offset 1 -> beat indices 1 and 4 are accented.
    expect(events.map((e) => e.gain)).toEqual([
      loGain,
      hiGain,
      loGain,
      loGain,
      hiGain,
    ]);
  });
});
