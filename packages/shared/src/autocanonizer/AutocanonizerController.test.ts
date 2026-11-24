import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonizerBeat } from "./AutocanonizerViz";
import { AutocanonizerController } from "./AutocanonizerController";

vi.mock("./AutocanonizerViz", () => ({
  AutocanonizerViz: class AutocanonizerViz {
    setOnSelect() {}
    setVisible() {}
    resizeNow() {}
    setData() {}
    setDualData() {}
    reset() {}
    destroy() {}
    update() {}
    setOtherIndex() {}
  },
}));

type GainStub = GainNode & { gain: { value: number } };
type PannerStub = StereoPannerNode & { pan: { value: number } };

function createAudioContext() {
  const gains: GainStub[] = [];
  const panners: PannerStub[] = [];
  const sources: Array<{ buffer: AudioBuffer | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: () => {
      const gain = {
        gain: { value: 0 },
        connect: vi.fn(),
      } as unknown as GainStub;
      gains.push(gain);
      return gain;
    },
    createStereoPanner: () => {
      const panner = {
        pan: { value: 0 },
        connect: vi.fn(),
      } as unknown as PannerStub;
      panners.push(panner);
      return panner;
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
  } as unknown as AudioContext;
  return { context, gains, panners, sources };
}

function createBeat(which: number, start: number): CanonizerBeat {
  return {
    which,
    start,
    duration: 0.1,
    confidence: 1,
    overlappingSegments: [],
    parent: null,
    children: [],
    indexInParent: which,
    prev: null,
    next: null,
    other: null,
    otherGain: 1,
    section: 0,
    volume: 1,
    median_volume: 1,
    color: "#fff",
  } as unknown as CanonizerBeat;
}

describe("AutocanonizerController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and clamps stream pans before audio is attached", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    controller.setStreamPans(-0.25, 0.75);
    const { context, gains, panners } = createAudioContext();

    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    expect(gains[0].gain.value).toBeCloseTo(1 * 0.55);
    expect(gains[1].gain.value).toBeCloseTo(1 * 0.45);
    expect(panners[0].pan.value).toBeCloseTo(-0.25);
    expect(panners[1].pan.value).toBeCloseTo(0.75);

    controller.setStreamPans(2, -2);
    expect(panners[0].pan.value).toBe(1);
    expect(panners[1].pan.value).toBe(-1);
  });

  it("applies a volume set before audio is attached", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    controller.setVolume(0.4);
    const { context, gains } = createAudioContext();

    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    expect(gains[0].gain.value).toBeCloseTo(0.4 * 0.55);
    expect(gains[1].gain.value).toBeCloseTo(0.4 * 0.45);
  });

  it("keeps the current volume when given a non-finite one", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains } = createAudioContext();
    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    controller.setVolume(0.6);
    controller.setVolume(Number.NaN);

    expect(gains[0].gain.value).toBeCloseTo(0.6 * 0.55);
    expect(gains[1].gain.value).toBeCloseTo(0.6 * 0.45);
  });

  it("keeps the shared volume and base mix independent from stream panning", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains, panners } = createAudioContext();
    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    controller.setVolume(0.8);
    controller.setStreamPans(0.5, -0.25);

    expect(gains[0].gain.value).toBeCloseTo(0.8 * 0.55);
    expect(gains[1].gain.value).toBeCloseTo(0.8 * 0.45);
    expect(panners[0].pan.value).toBeCloseTo(0.5);
    expect(panners[1].pan.value).toBeCloseTo(-0.25);
  });

  it("reports both cursor positions for normal playback", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const main = createBeat(0, 12);
    const other = createBeat(1, 34);
    main.other = other;
    const player = {
      reset: vi.fn(),
      stop: vi.fn(),
      playBeat: vi.fn(() => 10),
    };
    const inner = controller as unknown as {
      beats: CanonizerBeat[];
      player: typeof player;
    };
    inner.beats = [main];
    inner.player = player;
    const onBeat = vi.fn();
    controller.setOnBeat(onBeat);

    controller.startAtIndex(0);
    controller.stop();

    expect(onBeat).toHaveBeenCalledWith(0, main, {
      mainSeconds: 12,
      otherSeconds: 34,
    });
  });

  it("loops back to the first beat after the final beat by default", () => {
    vi.useFakeTimers();
    const controller = new AutocanonizerController({} as HTMLElement);
    const first = createBeat(0, 0);
    const second = createBeat(1, 10);
    const final = createBeat(2, 20);
    first.next = second;
    second.prev = first;
    second.next = final;
    final.prev = second;
    final.other = first;
    first.other = first;
    second.other = second;
    const player = {
      reset: vi.fn(),
      stop: vi.fn(),
      stopMain: vi.fn(),
      playBeat: vi.fn(() => 0.1),
      playOtherOnly: vi.fn(() => 0.1),
    };
    const inner = controller as unknown as {
      beats: CanonizerBeat[];
      player: typeof player;
    };
    inner.beats = [first, second, final];
    inner.player = player;
    const onBeat = vi.fn();
    const onEnded = vi.fn();
    controller.setOnBeat(onBeat);
    controller.setOnEnded(onEnded);

    controller.startAtIndex(2);
    vi.advanceTimersByTime(250);
    controller.stop();

    const beatIndexes = onBeat.mock.calls.map((call) => call[0]);
    expect(beatIndexes).toEqual([2, 0, 1]);
    expect(onEnded).not.toHaveBeenCalled();
    expect(player.stopMain).not.toHaveBeenCalled();
    expect(player.playOtherOnly).not.toHaveBeenCalled();
  });

  it("holds the main cursor while finish-out advances the other stream", () => {
    vi.useFakeTimers();
    const controller = new AutocanonizerController({} as HTMLElement);
    const first = createBeat(0, 0);
    const second = createBeat(1, 10);
    const final = createBeat(2, 20);
    first.next = second;
    second.prev = first;
    second.next = final;
    final.prev = second;
    final.other = first;
    first.other = first;
    second.other = second;
    const player = {
      reset: vi.fn(),
      stop: vi.fn(),
      stopMain: vi.fn(),
      playBeat: vi.fn(() => 0.1),
      playOtherOnly: vi.fn(() => 0.1),
    };
    const inner = controller as unknown as {
      beats: CanonizerBeat[];
      player: typeof player;
    };
    inner.beats = [first, second, final];
    inner.player = player;
    const onBeat = vi.fn();
    controller.setFinishOutSong(true);
    controller.setOnBeat(onBeat);

    controller.startAtIndex(2);
    vi.advanceTimersByTime(100);
    controller.stop();

    expect(onBeat).toHaveBeenLastCalledWith(1, second, {
      mainSeconds: 20,
      otherSeconds: 10,
    });
  });

  it("plans a render with the current finish-out setting and stream pans", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    expect(controller.planRender()).toBeNull();
    const first = createBeat(0, 0);
    const final = createBeat(1, 0.1);
    first.next = final;
    final.prev = first;
    first.other = first;
    final.other = first;
    (controller as unknown as { beats: CanonizerBeat[] }).beats = [first, final];
    controller.setStreamPans(-2, 0.5);

    const looped = controller.planRender();
    expect(looped?.durationSeconds).toBeCloseTo(0.2);
    expect(looped?.voices.map((voice) => voice.pan)).toEqual([-1, 0.5]);

    controller.setFinishOutSong(true);
    expect(controller.planRender()?.durationSeconds).toBeCloseTo(0.3);
  });

  it("applies and clamps per-stream gains alongside volume and pans", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    controller.setStreamGains(1.5, 0.5);
    const { context, gains } = createAudioContext();

    controller.setAudio({ duration: 30 } as AudioBuffer, context);
    expect(gains[0].gain.value).toBeCloseTo(0.55 * 1.5);
    expect(gains[1].gain.value).toBeCloseTo(0.45 * 0.5);

    controller.setStreamGains(5, -1);
    expect(gains[0].gain.value).toBeCloseTo(0.55 * 2);
    expect(gains[1].gain.value).toBeCloseTo(0);

    controller.setStreamGains(Number.NaN, 1);
    expect(gains[0].gain.value).toBeCloseTo(0.55 * 2);
    expect(gains[1].gain.value).toBeCloseTo(0.45 * 1);
  });

  it("plays main and secondary streams from distinct dual buffers", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, sources } = createAudioContext();
    const mainBuffer = { duration: 20 } as AudioBuffer;
    const otherBuffer = { duration: 15 } as AudioBuffer;

    controller.setDualAudio(mainBuffer, otherBuffer, context);
    const mainBeat = createBeat(0, 1);
    const otherBeat = createBeat(0, 2);
    mainBeat.other = otherBeat;
    (controller as unknown as { beats: CanonizerBeat[] }).beats = [mainBeat];

    controller.startAtIndex(0);
    controller.stop();

    expect(sources).toHaveLength(2);
    expect(sources[0].buffer).toBe(mainBuffer);
    expect(sources[1].buffer).toBe(otherBuffer);
  });

  it("aligns dual analyses in cover-sync and section-fold modes and switches live", () => {
    const makeAnalysis = (pitchesList: number[][], dur = 0.5) => ({
      track: { duration: pitchesList.length * dur },
      sections: [{ start: 0, duration: pitchesList.length * dur, confidence: 1 }],
      bars: [{ start: 0, duration: pitchesList.length * dur, confidence: 1 }],
      beats: pitchesList.map((_, i) => ({
        start: i * dur,
        duration: dur,
        confidence: 1,
      })),
      tatums: [],
      segments: pitchesList.map((pitches, i) => ({
        start: i * dur,
        duration: dur,
        confidence: 1,
        loudness_start: -10,
        loudness_max: -5,
        loudness_max_time: 0.1,
        pitches,
        timbre: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      })),
    });

    const p0 = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const p1 = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const p2 = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const mainRaw = makeAnalysis([p0, p1, p2], 0.5);
    // Secondary track is twice as slow (duration 1.0 per beat), synced with tempoRatio 0.5.
    const otherRaw = makeAnalysis([p1, p2, p0], 1.0);

    const controller = new AutocanonizerController({} as HTMLElement);
    controller.setDualAnalysis(mainRaw, otherRaw, {
      otherTempoRatio: 0.5,
      alignmentMode: "cover-sync",
    });

    const inner = controller as unknown as {
      beats: CanonizerBeat[];
      otherBeats: CanonizerBeat[];
    };
    expect(inner.beats).toHaveLength(3);
    expect(inner.otherBeats).toHaveLength(3);
    // Scaled by 1 / 0.5 = 2.0
    expect(inner.otherBeats[0].duration).toBeCloseTo(2.0);
    expect(inner.beats.every((b) => inner.otherBeats.includes(b.other))).toBe(true);

    controller.setDualAlignmentMode("section-fold");
    expect(inner.beats.every((b) => inner.otherBeats.includes(b.other))).toBe(true);
    expect(inner.beats[1].other.which).not.toBe(0);
  });

  it("branches across sections when mixing two identical covers in both cover-sync and section-fold modes", () => {
    const pA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pB = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pC = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pD = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    // 4 sections [A, B, A, B] of 4 beats each (16 beats total) with distinct timbres/loudness.
    const sectionSpecs = [
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
    ];
    const dur = 0.5;
    const beats: Array<{ start: number; duration: number; confidence: number }> = [];
    const bars: Array<{ start: number; duration: number; confidence: number }> = [];
    const sections: Array<{ start: number; duration: number; confidence: number }> = [];
    const segments: Array<{
      start: number;
      duration: number;
      confidence: number;
      loudness_start: number;
      loudness_max: number;
      loudness_max_time: number;
      pitches: number[];
      timbre: number[];
    }> = [];

    let beatIdx = 0;
    for (const spec of sectionSpecs) {
      sections.push({
        start: beatIdx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      bars.push({
        start: beatIdx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      for (const pitches of spec.pitches) {
        const start = beatIdx * dur;
        beats.push({ start, duration: dur, confidence: 1 });
        segments.push({
          start,
          duration: dur,
          confidence: 1,
          loudness_start: spec.loudness - 2,
          loudness_max: spec.loudness,
          loudness_max_time: 0.1,
          pitches,
          timbre: Array.from({ length: 12 }, (_, k) =>
            k === 0 ? spec.timbreVal : 0,
          ),
        });
        beatIdx += 1;
      }
    }

    const analysisRaw = {
      track: { duration: beatIdx * dur },
      sections,
      bars,
      beats,
      tatums: [],
      segments,
    };

    const controller = new AutocanonizerController({} as HTMLElement);
    controller.setDualAnalysis(analysisRaw, structuredClone(analysisRaw), {
      otherTempoRatio: 1,
      alignmentMode: "cover-sync",
    });

    const inner = controller as unknown as { beats: CanonizerBeat[] };
    const countDiscontinuities = (list: CanonizerBeat[]) =>
      list.slice(0, -1).filter((b, i) => list[i + 1].other.which - b.other.which !== 1).length;

    expect(inner.beats.some((b) => b.other.which !== b.which)).toBe(true);
    expect(countDiscontinuities(inner.beats)).toBeGreaterThan(0);

    controller.setDualAlignmentMode("section-fold");
    expect(inner.beats.some((b) => b.other.which !== b.which)).toBe(true);
    expect(countDiscontinuities(inner.beats)).toBeGreaterThan(0);
  });

  it("finishes out a dual mix along otherBeats instead of main beats", () => {
    vi.useFakeTimers();
    const controller = new AutocanonizerController({} as HTMLElement);
    const main0 = createBeat(0, 0);
    const main1 = createBeat(1, 1);
    main0.next = main1;
    main1.prev = main0;
    const other0 = createBeat(0, 10);
    const other1 = createBeat(1, 20);
    other0.next = other1;
    other1.prev = other0;
    other0.other = other0;
    other1.other = other1;
    main0.other = other0;
    main1.other = other0;

    const player = {
      reset: vi.fn(),
      stop: vi.fn(),
      stopMain: vi.fn(),
      playBeat: vi.fn(() => 0.1),
      playOtherOnly: vi.fn(() => 0.1),
    };
    const inner = controller as unknown as {
      beats: CanonizerBeat[];
      otherBeats: CanonizerBeat[];
      player: typeof player;
    };
    inner.beats = [main0, main1];
    inner.otherBeats = [other0, other1];
    inner.player = player;

    const onBeat = vi.fn();
    controller.setFinishOutSong(true);
    controller.setOnBeat(onBeat);

    controller.startAtIndex(1);
    vi.advanceTimersByTime(100);
    controller.stop();

    expect(onBeat).toHaveBeenLastCalledWith(1, other1, {
      mainSeconds: 1,
      otherSeconds: 20,
    });
  });

  it("plays 4 voices across Song 1 and Song 2 in quad mode with synced and independent Gold branching", () => {
    const pA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pB = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pC = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pD = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const buildAnalysis = (
      specs: Array<{ pitches: number[][]; timbreVal: number; loudness: number }>,
    ) => {
      const dur = 0.5;
      const beats: Array<{ start: number; duration: number; confidence: number }> = [];
      const bars: Array<{ start: number; duration: number; confidence: number }> = [];
      const sections: Array<{ start: number; duration: number; confidence: number }> = [];
      const segments: Array<{
        start: number;
        duration: number;
        confidence: number;
        loudness_start: number;
        loudness_max: number;
        loudness_max_time: number;
        pitches: number[];
        timbre: number[];
      }> = [];
      let beatIdx = 0;
      for (const spec of specs) {
        sections.push({
          start: beatIdx * dur,
          duration: spec.pitches.length * dur,
          confidence: 1,
        });
        bars.push({
          start: beatIdx * dur,
          duration: spec.pitches.length * dur,
          confidence: 1,
        });
        for (const pitches of spec.pitches) {
          const start = beatIdx * dur;
          beats.push({ start, duration: dur, confidence: 1 });
          segments.push({
            start,
            duration: dur,
            confidence: 1,
            loudness_start: spec.loudness - 2,
            loudness_max: spec.loudness,
            loudness_max_time: 0.1,
            pitches,
            timbre: Array.from({ length: 12 }, (_, k) =>
              k === 0 ? spec.timbreVal : 0,
            ),
          });
          beatIdx += 1;
        }
      }
      return {
        track: { duration: beatIdx * dur },
        sections,
        bars,
        beats,
        tatums: [],
        segments,
      };
    };

    const mainRaw = buildAnalysis([
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
    ]);
    // Second cover shares overall form but swaps sections 1 and 3 slightly so independent mode diverges.
    const otherRaw = buildAnalysis([
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
      { pitches: [pD, pC, pB, pA], timbreVal: -10, loudness: -20 },
      { pitches: [pA, pB, pC, pD], timbreVal: 10, loudness: -5 },
    ]);

    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains, sources } = createAudioContext();
    const mainBuffer = { duration: 20 } as AudioBuffer;
    const otherBuffer = { duration: 20 } as AudioBuffer;

    controller.setDualAudio(mainBuffer, otherBuffer, context);
    controller.setDualAnalysis(mainRaw, otherRaw, {
      quadMode: true,
      quadBranchMode: "synced",
    });

    // Quad gain scaling: 0.28 / 0.22 / 0.28 / 0.22
    expect(gains[0].gain.value).toBeCloseTo(0.28);
    expect(gains[1].gain.value).toBeCloseTo(0.22);
    expect(gains[2].gain.value).toBeCloseTo(0.28);
    expect(gains[3].gain.value).toBeCloseTo(0.22);

    const onBeat = vi.fn();
    controller.setOnBeat(onBeat);
    controller.startAtIndex(0);
    controller.stop();

    // 4 sources spawned: Blue & Green from mainBuffer, Pink & Gold from otherBuffer.
    expect(sources).toHaveLength(4);
    expect(sources[0].buffer).toBe(mainBuffer);
    expect(sources[1].buffer).toBe(mainBuffer);
    expect(sources[2].buffer).toBe(otherBuffer);
    expect(sources[3].buffer).toBe(otherBuffer);
    expect(onBeat).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        mainSeconds: expect.any(Number),
        otherSeconds: expect.any(Number),
        pinkSeconds: expect.any(Number),
        goldSeconds: expect.any(Number),
      }),
    );

    const inner = controller as unknown as {
      beats: Array<CanonizerBeat & { pink?: CanonizerBeat; gold?: CanonizerBeat }>;
      otherBeats: CanonizerBeat[];
    };
    const syncedGoldWhich = inner.beats.map((b) => b.gold?.which);

    controller.setQuadBranchMode("independent");
    const independentGoldWhich = inner.beats.map((b) => b.gold?.which);
    expect(independentGoldWhich).not.toEqual(syncedGoldWhich);
    expect(inner.beats.every((b) => inner.otherBeats.includes(b.gold!))).toBe(
      true,
    );
  });
});
