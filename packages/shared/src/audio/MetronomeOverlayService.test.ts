import { describe, expect, it, vi } from "vitest";
import type { QuantumBase } from "../engine/types";
import {
  BASE_METRONOME_GAIN,
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_METRONOME_VOLUME_PCT,
  HI_TICK_DURATION_SECONDS,
  HI_TICK_GAIN,
  LO_TICK_DURATION_SECONDS,
  LO_TICK_GAIN,
  MAX_METRONOME_VOLUME_PCT,
  MIN_METRONOME_VOLUME_PCT,
  MetronomeOverlayService,
  clampMetronomeBeatOffset,
  clampMetronomeVolumePct,
  createMetronomeTickBuffers,
  detectTrackBeatsPerBar,
  isMetronomeDownbeat,
  resolveBeatsPerBar,
  resolveMetronomeTimeSignatureOverride,
} from "./MetronomeOverlayService";

class MockGainNode {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioBuffer {
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

class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createdSources: MockSourceNode[] = [];
  createdGains: MockGainNode[] = [];

  createGain() {
    const gain = new MockGainNode();
    this.createdGains.push(gain);
    return gain;
  }

  createBufferSource() {
    const source = new MockSourceNode();
    this.createdSources.push(source);
    return source;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }
}

function makeBarBeat(indexInParent: number, barLength = 4): QuantumBase {
  const children = new Array<QuantumBase>(barLength);
  return {
    start: 0,
    duration: 0.5,
    which: indexInParent,
    prev: null,
    next: null,
    overlappingSegments: [],
    neighbors: [],
    allNeighbors: [],
    indexInParent,
    parent: {
      start: 0,
      duration: 2,
      which: 0,
      prev: null,
      next: null,
      overlappingSegments: [],
      neighbors: [],
      allNeighbors: [],
      children,
    },
  };
}

describe("resolveBeatsPerBar", () => {
  it("keeps valid integer time signatures and rounds fractional values", () => {
    expect(resolveBeatsPerBar(3)).toBe(3);
    expect(resolveBeatsPerBar(4)).toBe(4);
    expect(resolveBeatsPerBar(6)).toBe(6);
    expect(resolveBeatsPerBar(3.2)).toBe(3);
  });

  it("falls back to 4/4 for missing, invalid, or extreme values", () => {
    expect(resolveBeatsPerBar(undefined)).toBe(DEFAULT_BEATS_PER_BAR);
    expect(resolveBeatsPerBar(Number.NaN)).toBe(DEFAULT_BEATS_PER_BAR);
    expect(resolveBeatsPerBar(0)).toBe(DEFAULT_BEATS_PER_BAR);
    expect(resolveBeatsPerBar(-4)).toBe(DEFAULT_BEATS_PER_BAR);
    expect(resolveBeatsPerBar(24)).toBe(DEFAULT_BEATS_PER_BAR);
  });
});

describe("isMetronomeDownbeat", () => {
  it("uses bar indexInParent for 4/4 and 3/4 bars", () => {
    expect(isMetronomeDownbeat(5, makeBarBeat(0, 4), 4)).toBe(true);
    expect(isMetronomeDownbeat(6, makeBarBeat(1, 4), 4)).toBe(false);
    expect(isMetronomeDownbeat(7, makeBarBeat(2, 3), 3)).toBe(false);
    expect(isMetronomeDownbeat(8, makeBarBeat(0, 3), 3)).toBe(true);
  });

  it("falls back to beatsPerBar modulo when bar metadata is absent", () => {
    expect(isMetronomeDownbeat(0, undefined, 4)).toBe(true);
    expect(isMetronomeDownbeat(1, undefined, 4)).toBe(false);
    expect(isMetronomeDownbeat(3, undefined, 3)).toBe(true);
    expect(isMetronomeDownbeat(4, undefined, 3)).toBe(false);
  });

  it("falls back when a degenerate bar holds more than 12 beats", () => {
    expect(isMetronomeDownbeat(0, makeBarBeat(0, 32), 4)).toBe(true);
    expect(isMetronomeDownbeat(4, makeBarBeat(4, 32), 4)).toBe(true);
    expect(isMetronomeDownbeat(5, makeBarBeat(5, 32), 4)).toBe(false);
  });

  it("uses localWhich when present for multi-track slices", () => {
    expect(isMetronomeDownbeat(10, { localWhich: 0 }, 4)).toBe(true);
    expect(isMetronomeDownbeat(12, { localWhich: 2 }, 4)).toBe(false);
    expect(isMetronomeDownbeat(13, { localWhich: 3 }, 3)).toBe(true);
  });
});

describe("createMetronomeTickBuffers", () => {
  it("generates finite mono buffers with zero endpoints and distinct hi/lo durations", () => {
    const context = new MockAudioContext();
    const buffers = createMetronomeTickBuffers(context as unknown as BaseAudioContext);
    expect(buffers).not.toBeNull();
    if (!buffers) {
      return;
    }

    expect(buffers.hi.numberOfChannels).toBe(1);
    expect(buffers.lo.numberOfChannels).toBe(1);
    expect(buffers.hi.duration).toBeCloseTo(HI_TICK_DURATION_SECONDS, 4);
    expect(buffers.lo.duration).toBeCloseTo(LO_TICK_DURATION_SECONDS, 4);

    for (const buf of [buffers.hi, buffers.lo]) {
      const data = buf.getChannelData(0);
      expect(data.length).toBeGreaterThan(0);
      expect(data[data.length - 1]).toBe(0);
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        expect(Number.isFinite(data[i])).toBe(true);
        peak = Math.max(peak, Math.abs(data[i]));
      }
      expect(peak).toBeGreaterThan(0.1);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });
});

describe("MetronomeOverlayService", () => {
  it("scales master gain by the shared playback volume", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.setVolume(0.4);
    expect(context.createdGains[0]?.gain.value).toBeCloseTo(
      BASE_METRONOME_GAIN * 0.4,
      10,
    );
  });

  it("ignores non-finite volume updates", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.setVolume(0.5);
    service.setVolume(Number.NaN);
    expect(context.createdGains[0]?.gain.value).toBeCloseTo(
      BASE_METRONOME_GAIN * 0.5,
      10,
    );
  });

  it("does not trigger ticks while disabled", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.handleBeatEnter(0, makeBarBeat(0, 4));
    expect(context.createdSources).toHaveLength(0);
  });

  it("triggers hi tick on downbeats and lo tick on other beats", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.enable();
    context.currentTime = 1.25;
    service.handleBeatEnter(0, makeBarBeat(0, 4));
    context.currentTime = 1.75;
    service.handleBeatEnter(1, makeBarBeat(1, 4));

    expect(context.createdSources).toHaveLength(2);
    const hiSource = context.createdSources[0];
    const loSource = context.createdSources[1];
    expect(hiSource.buffer?.duration).toBeCloseTo(HI_TICK_DURATION_SECONDS, 4);
    expect(loSource.buffer?.duration).toBeCloseTo(LO_TICK_DURATION_SECONDS, 4);
    expect(hiSource.start).toHaveBeenCalledWith(1.25);
    expect(loSource.start).toHaveBeenCalledWith(1.75);
    expect(context.createdGains[1]?.gain.value).toBe(HI_TICK_GAIN);
    expect(context.createdGains[2]?.gain.value).toBe(LO_TICK_GAIN);
  });

  it("respects setBeatsPerBar fallback when beats have no bar parent", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.setBeatsPerBar(3);
    service.enable();
    service.handleBeatEnter(0);
    service.handleBeatEnter(1);
    service.handleBeatEnter(2);
    service.handleBeatEnter(3);

    expect(context.createdGains[1]?.gain.value).toBe(HI_TICK_GAIN);
    expect(context.createdGains[2]?.gain.value).toBe(LO_TICK_GAIN);
    expect(context.createdGains[3]?.gain.value).toBe(LO_TICK_GAIN);
    expect(context.createdGains[4]?.gain.value).toBe(HI_TICK_GAIN);
  });

  it("stops active sources on disable or cancelScheduledHits and prevents re-enable after dispose", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.enable();
    service.handleBeatEnter(0);
    const firstSource = context.createdSources[0];
    service.cancelScheduledHits();
    expect(firstSource.stop).toHaveBeenCalledWith(0);
    expect(firstSource.disconnect).toHaveBeenCalled();

    service.handleBeatEnter(1);
    const secondSource = context.createdSources[1];
    service.disable();
    expect(service.isEnabled()).toBe(false);
    expect(secondSource.stop).toHaveBeenCalledWith(0);

    service.dispose();
    service.enable();
    expect(service.isEnabled()).toBe(false);
    service.handleBeatEnter(2);
    expect(context.createdSources).toHaveLength(2);
  });

  it("scales master gain with dedicated metronome volume percentage", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);

    service.setVolume(0.5);
    service.setMetronomeVolumePct(200);
    expect(service.getMetronomeVolumePct()).toBe(200);
    expect(context.createdGains[0]?.gain.value).toBeCloseTo(
      BASE_METRONOME_GAIN * 0.5 * 2,
      10,
    );

    service.setMetronomeVolumePct(0);
    expect(service.getMetronomeVolumePct()).toBe(0);
    expect(context.createdGains[0]?.gain.value).toBe(0);
  });

  it("applies live beat offset and time signature override on handleBeatEnter", () => {
    const context = new MockAudioContext();
    const service = new MetronomeOverlayService(context as unknown as AudioContext);
    service.enable();

    // Shift accent to beat 2 (offset = 1) inside 4/4 bars.
    service.setBeatOffset(1);
    expect(service.getBeatOffset()).toBe(1);
    service.handleBeatEnter(0, makeBarBeat(0, 4));
    service.handleBeatEnter(1, makeBarBeat(1, 4));
    expect(context.createdGains[1]?.gain.value).toBe(LO_TICK_GAIN);
    expect(context.createdGains[2]?.gain.value).toBe(HI_TICK_GAIN);

    // Override analyzed 4/4 bars to 3/4 with offset 1 -> accented on beat indices 1, 4, ...
    service.setBeatsPerBarOverride(3);
    expect(service.getBeatsPerBarOverride()).toBe(3);
    service.handleBeatEnter(3, makeBarBeat(3, 4));
    service.handleBeatEnter(4, makeBarBeat(0, 4));
    expect(context.createdGains[3]?.gain.value).toBe(LO_TICK_GAIN);
    expect(context.createdGains[4]?.gain.value).toBe(HI_TICK_GAIN);

    // Negative beat offsets shift the accent backward across the cycle.
    service.setBeatOffset(-1);
    expect(service.getBeatOffset()).toBe(-1);
    service.handleBeatEnter(2);
    service.handleBeatEnter(3);
    expect(context.createdGains[5]?.gain.value).toBe(HI_TICK_GAIN);
    expect(context.createdGains[6]?.gain.value).toBe(LO_TICK_GAIN);

    // Explicit downbeatOverride takes precedence over internal downbeat calculation.
    service.handleBeatEnter(0, undefined, false);
    service.handleBeatEnter(1, undefined, true);
    expect(context.createdGains[7]?.gain.value).toBe(LO_TICK_GAIN);
    expect(context.createdGains[8]?.gain.value).toBe(HI_TICK_GAIN);
  });
});

describe("metronome control helpers", () => {
  it("clamps metronome volume pct within [0, 200]", () => {
    expect(clampMetronomeVolumePct(-10)).toBe(MIN_METRONOME_VOLUME_PCT);
    expect(clampMetronomeVolumePct(250)).toBe(MAX_METRONOME_VOLUME_PCT);
    expect(clampMetronomeVolumePct(125.6)).toBe(126);
    expect(clampMetronomeVolumePct(Number.NaN)).toBe(DEFAULT_METRONOME_VOLUME_PCT);
  });

  it("validates explicit time signature overrides", () => {
    expect(resolveMetronomeTimeSignatureOverride(null)).toBeNull();
    expect(resolveMetronomeTimeSignatureOverride(undefined)).toBeNull();
    expect(resolveMetronomeTimeSignatureOverride(Number.NaN)).toBeNull();
    expect(resolveMetronomeTimeSignatureOverride(0)).toBeNull();
    expect(resolveMetronomeTimeSignatureOverride(100)).toBeNull();
    expect(resolveMetronomeTimeSignatureOverride(3)).toBe(3);
    expect(resolveMetronomeTimeSignatureOverride(16)).toBe(16);
    expect(resolveMetronomeTimeSignatureOverride(6.2)).toBe(6);
  });

  it("clamps beat offset to [0, beatsPerBar - 1]", () => {
    expect(clampMetronomeBeatOffset(-2, 4)).toBe(0);
    expect(clampMetronomeBeatOffset(5, 4)).toBe(3);
    expect(clampMetronomeBeatOffset(3, 3)).toBe(2);
    expect(clampMetronomeBeatOffset(Number.NaN, 4)).toBe(0);
  });

  it("detects dominant bar length even when fallback time_signature differs", () => {
    const waltzBeats = [
      makeBarBeat(0, 3),
      makeBarBeat(1, 3),
      makeBarBeat(2, 3),
      makeBarBeat(0, 3),
      makeBarBeat(1, 3),
      makeBarBeat(2, 3),
    ];
    expect(detectTrackBeatsPerBar(waltzBeats, 4)).toBe(3);

    const fourFourBeats = [makeBarBeat(0, 4), makeBarBeat(1, 4)];
    expect(detectTrackBeatsPerBar(fourFourBeats, 3)).toBe(4);

    // Ignores oversized single mega-bars and falls back to track metadata.
    expect(detectTrackBeatsPerBar([makeBarBeat(0, 32)], 3)).toBe(3);
    expect(detectTrackBeatsPerBar(undefined, undefined)).toBe(4);
  });

  it("shifts downbeats by beatOffset and respects beatsPerBarOverride", () => {
    // 4/4 bar with offset 2 accents indexInParent === 2.
    expect(
      isMetronomeDownbeat(0, makeBarBeat(0, 4), { beatsPerBar: 4, beatOffset: 2 }),
    ).toBe(false);
    expect(
      isMetronomeDownbeat(2, makeBarBeat(2, 4), { beatsPerBar: 4, beatOffset: 2 }),
    ).toBe(true);

    // 3/4 bar with offset 1 accents indexInParent === 1.
    expect(
      isMetronomeDownbeat(1, makeBarBeat(1, 3), { beatsPerBar: 3, beatOffset: 1 }),
    ).toBe(true);

    // Explicit override ignores analyzed 4/4 bar structure.
    expect(
      isMetronomeDownbeat(3, makeBarBeat(3, 4), {
        beatsPerBar: 4,
        beatsPerBarOverride: 3,
        beatOffset: 0,
      }),
    ).toBe(true);
    expect(
      isMetronomeDownbeat(4, makeBarBeat(0, 4), {
        beatsPerBar: 4,
        beatsPerBarOverride: 3,
        beatOffset: 1,
      }),
    ).toBe(true);
  });
});
