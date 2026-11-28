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
    setFinishOutIndices() {}
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
          start: start + 0.01,
          duration: dur - 0.02,
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

    expect(controller.getAudioBuffers()).toEqual({ mainBuffer, otherBuffer });
    const quadPlan = controller.planRender();
    expect(quadPlan?.voices).toHaveLength(4);
    expect(quadPlan?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 1, 1]);
  });

  it("mutes unmatched solo sections instead of clamping onto Song 2 when lengths differ", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains, sources } = createAudioContext();
    const mainBuffer = { duration: 10 } as AudioBuffer;
    const otherBuffer = { duration: 4 } as AudioBuffer;

    controller.setDualAudio(mainBuffer, otherBuffer, context);
    const other0 = createBeat(0, 0);
    const main0 = createBeat(0, 0);
    const main1 = createBeat(1, 1);
    main0.next = main1;
    main1.prev = main0;
    main0.other = other0;
    main0.otherGain = 1;
    main1.other = other0;
    main1.otherGain = 0;

    (controller as unknown as { beats: CanonizerBeat[] }).beats = [main0, main1];

    controller.startAtIndex(0);
    expect(gains[1].gain.value).toBeCloseTo(0.45);
    expect(sources).toHaveLength(2);

    // Selecting beat 1 (otherGain=0) mutes otherGain and stops secondary source.
    controller.selectIndex(1, false);
    // Re-trigger via startAtIndex(1)
    controller.startAtIndex(1);
    expect(gains[1].gain.value).toBe(0);
    controller.stop();
  });

  it("exposes live Blue/Green cursor times while running and binary-searches beats by time", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context } = createAudioContext();
    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    const b0 = createBeat(0, 0);
    const b1 = createBeat(1, 2);
    const b2 = createBeat(2, 4);
    b0.next = b1;
    b1.prev = b0;
    b1.next = b2;
    b2.prev = b1;
    b0.other = b2;
    b1.other = b1;
    b2.other = b0;
    (controller as unknown as { beats: CanonizerBeat[] }).beats = [b0, b1, b2];

    expect(controller.getLiveCursorTimes()).toBeNull();
    expect(controller.findBeatIndexByTime(-1)).toBe(0);
    expect(controller.findBeatIndexByTime(2.5)).toBe(1);
    expect(controller.findBeatIndexByTime(99)).toBe(2);

    controller.startAtIndex(0);
    (context as unknown as { currentTime: number }).currentTime = 0.4;
    expect(controller.getLiveCursorTimes()).toEqual({
      mainSeconds: 0.4,
      otherSeconds: 4.4,
      inUnison: false,
    });

    controller.startAtIndex(1);
    (context as unknown as { currentTime: number }).currentTime = 0.6;
    expect(controller.getLiveCursorTimes()).toEqual({
      mainSeconds: 2.2,
      otherSeconds: 2.2,
      inUnison: true,
    });

    controller.stop();
    expect(controller.getLiveCursorTimes()).toBeNull();
  });

  it("supports 3-voice single-song trio mode with runner-up matching, muted sections, and 0.4/0.3/0.3 gains", () => {
    const pA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pB = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pC = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pD = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    // 5 sections: [A, B, A, B, A] of 2 beats each (10 beats total).
    // A repeats 3 times (sections 0, 2, 4) -> Gold finds a distinct 3rd match!
    // B repeats only 2 times (sections 1, 3) -> Gold has no 3rd match and mutes!
    // Slight loudness variations ensure non-zero self-similarity distance > 0.
    const sectionSpecs = [
      { pitches: [pA, pB], timbreVal: 10, loudness: -5 },
      { pitches: [pC, pD], timbreVal: -10, loudness: -25 },
      { pitches: [pA, pB], timbreVal: 10, loudness: -5.1 },
      { pitches: [pC, pD], timbreVal: -10, loudness: -25.1 },
      { pitches: [pA, pB], timbreVal: 10, loudness: -5.2 },
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
    let idx = 0;
    for (const spec of sectionSpecs) {
      sections.push({
        start: idx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      bars.push({
        start: idx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      for (const pitches of spec.pitches) {
        const start = idx * dur;
        beats.push({ start, duration: dur, confidence: 1 });
        segments.push({
          start: start + 0.01,
          duration: dur - 0.02,
          confidence: 1,
          loudness_start: spec.loudness - 2,
          loudness_max: spec.loudness,
          loudness_max_time: 0.1,
          pitches,
          timbre: Array.from({ length: 12 }, (_, k) =>
            k === 0 ? spec.timbreVal : 0,
          ),
        });
        idx += 1;
      }
    }
    const raw = {
      track: { duration: idx * dur },
      sections,
      bars,
      beats,
      tatums: [],
      segments,
    };

    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains, sources } = createAudioContext();
    const mainBuffer = { duration: 10 } as AudioBuffer;
    controller.setAudio(mainBuffer, context);
    controller.setAnalysis(raw, raw.track.duration);
    controller.setTrioMode(true);

    // Trio gains: Blue 0.4, Green 0.3, Pink 0, Gold 0.3 (on active beats).
    expect(gains[0].gain.value).toBeCloseTo(0.4);
    expect(gains[1].gain.value).toBeCloseTo(0.3);
    expect(gains[2].gain.value).toBe(0);
    expect(gains[3].gain.value).toBeCloseTo(0.3);

    const inner = controller as unknown as {
      beats: Array<CanonizerBeat & { gold?: CanonizerBeat; goldGain?: number }>;
    };
    // Section 0 (beats 0-1, A) has active Gold in section 2 or 4 (distinct from Blue and Green).
    expect((inner.beats[0].goldGain ?? 0) > 0).toBe(true);
    expect(inner.beats[0].gold?.section).not.toBe(inner.beats[0].section);
    expect(inner.beats[0].gold?.section).not.toBe(inner.beats[0].other.section);
    // Section 1 (beats 2-3, B) only appears twice, so Gold mutes.
    expect(inner.beats[2].goldGain).toBe(0);
    expect(inner.beats[3].goldGain).toBe(0);

    const onBeat = vi.fn();
    controller.setOnBeat(onBeat);
    controller.startAtIndex(0);
    expect(sources).toHaveLength(3);
    expect(sources.every((s) => s.buffer === mainBuffer)).toBe(true);
    expect(onBeat).toHaveBeenLastCalledWith(
      0,
      inner.beats[0],
      expect.objectContaining({
        mainSeconds: 0,
        goldSeconds: inner.beats[0].gold!.start,
      }),
    );

    // Selecting beat 2 (muted section B) emits goldSeconds: null and mutes gains[3].
    controller.startAtIndex(2);
    expect(gains[3].gain.value).toBe(0);
    expect(onBeat).toHaveBeenLastCalledWith(
      2,
      inner.beats[2],
      expect.objectContaining({
        mainSeconds: 1,
        goldSeconds: null,
      }),
    );
    controller.stop();

    // Preserves trioMode across subsequent setAnalysis calls.
    controller.setAnalysis(raw, raw.track.duration);
    expect((inner.beats[0].goldGain ?? 0) > 0).toBe(true);

    const plan = controller.planRender();
    expect(plan?.voices).toHaveLength(3);
    expect(plan?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 0]);
  });

  it("finishes out both Green and Gold voices to the end in 3-voice trio mode", () => {
    vi.useFakeTimers();
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains } = createAudioContext();
    controller.setAudio({ duration: 10 } as AudioBuffer, context);
    controller.setTrioMode(true);

    // 4 beats (duration 0.1s each): final beat (3) has other=2 (2 beats left: 2,3)
    // and gold=1 (3 beats left: 1,2,3), so Gold continues 1 beat after Green ends.
    const b0 = createBeat(0, 0);
    const b1 = createBeat(1, 0.1);
    const b2 = createBeat(2, 0.2);
    const b3 = createBeat(3, 0.3);
    b0.next = b1;
    b1.prev = b0;
    b1.next = b2;
    b2.prev = b1;
    b2.next = b3;
    b3.prev = b2;
    b0.other = b1;
    b1.other = b2;
    b2.other = b3;
    b3.other = b2;
    b0.gold = b2;
    b1.gold = b3;
    b2.gold = b0;
    b3.gold = b1;
    b0.goldGain = 1;
    b1.goldGain = 1;
    b2.goldGain = 1;
    b3.goldGain = 1;

    (controller as unknown as { beats: CanonizerBeat[] }).beats = [b0, b1, b2, b3];
    const onBeat = vi.fn();
    const onEnded = vi.fn();
    controller.setFinishOutSong(true);
    controller.setOnBeat(onBeat);
    controller.setOnEnded(onEnded);

    controller.startAtIndex(3);
    // Beat 3 immediately enters finish-out step 1: other=2 (0.2), gold=1 (0.1)
    expect(onBeat).toHaveBeenLastCalledWith(2, b2, {
      mainSeconds: 0.3,
      otherSeconds: 0.2,
      goldSeconds: 0.1,
    });
    expect(gains[1].gain.value).toBeCloseTo(0.3);
    expect(gains[3].gain.value).toBeCloseTo(0.3);

    // Step 2: other=3 (0.3), gold=2 (0.2)
    (context as unknown as { currentTime: number }).currentTime = 0.1;
    vi.advanceTimersByTime(100);
    expect(onBeat).toHaveBeenLastCalledWith(3, b3, {
      mainSeconds: 0.3,
      otherSeconds: 0.3,
      goldSeconds: 0.2,
    });

    // Step 3: other finished, gold=3 (0.3) continues alone
    (context as unknown as { currentTime: number }).currentTime = 0.2;
    vi.advanceTimersByTime(100);
    expect(onBeat).toHaveBeenLastCalledWith(3, b3, {
      mainSeconds: 0.3,
      otherSeconds: 0.3,
      goldSeconds: 0.3,
    });
    expect(gains[1].gain.value).toBe(0);
    expect(gains[3].gain.value).toBeCloseTo(0.3);
    expect(onEnded).not.toHaveBeenCalled();

    // Step 4: both finished -> stops and fires onEnded
    (context as unknown as { currentTime: number }).currentTime = 0.3;
    vi.advanceTimersByTime(100);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("exposes goldSeconds in getLiveCursorTimes only during 3-voice trio playback", () => {
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context } = createAudioContext();
    controller.setAudio({ duration: 30 } as AudioBuffer, context);

    const b0 = createBeat(0, 0);
    const b1 = createBeat(1, 2);
    const b2 = createBeat(2, 4);
    b0.next = b1;
    b1.prev = b0;
    b1.next = b2;
    b2.prev = b1;
    b0.other = b2;
    b1.other = b1;
    b2.other = b0;
    b0.gold = b1;
    b0.goldGain = 1;
    b1.gold = b1;
    b1.goldGain = 0;
    b2.gold = b0;
    b2.goldGain = 1;
    (controller as unknown as { beats: CanonizerBeat[] }).beats = [b0, b1, b2];
    controller.setTrioMode(true);
    // Re-assign custom gold targets after setTrioMode computed defaults.
    b0.gold = b1;
    b0.goldGain = 1;
    b1.gold = b1;
    b1.goldGain = 0;

    controller.startAtIndex(0);
    (context as unknown as { currentTime: number }).currentTime = 0.3;
    expect(controller.getLiveCursorTimes()).toEqual({
      mainSeconds: 0.3,
      otherSeconds: 4.3,
      goldSeconds: 2.3,
      inUnison: false,
    });

    // Muted Gold section reports goldSeconds: null.
    controller.startAtIndex(1);
    (context as unknown as { currentTime: number }).currentTime = 0.5;
    expect(controller.getLiveCursorTimes()).toEqual({
      mainSeconds: 2.2,
      otherSeconds: 2.2,
      goldSeconds: null,
      inUnison: true,
    });

    controller.stop();
  });

  it("supports 4-voice single-song mode with distinct Pink matches, muted sections, and 0.31/0.23/0.23/0.23 gains", () => {
    const pA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pB = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pC = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pD = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const pE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const pF = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    // Sections: [A, B, A, A, A] (A occurs 4 times at sections 0, 2, 3, 4; B occurs once at section 1).
    const sectionSpecs = [
      { pitches: [pA, pB], timbreVal: 10, loudness: -5 },
      { pitches: [pC, pD], timbreVal: -10, loudness: -25 },
      { pitches: [pA, pB], timbreVal: 10, loudness: -5.1 },
      { pitches: [pA, pB], timbreVal: 10, loudness: -5.2 },
      { pitches: [pE, pF], timbreVal: 25, loudness: -35 },
      { pitches: [pA, pB], timbreVal: 10, loudness: -5.3 },
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
    let idx = 0;
    for (const spec of sectionSpecs) {
      sections.push({
        start: idx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      bars.push({
        start: idx * dur,
        duration: spec.pitches.length * dur,
        confidence: 1,
      });
      for (const pitches of spec.pitches) {
        const start = idx * dur;
        beats.push({ start, duration: dur, confidence: 1 });
        segments.push({
          start: start + 0.01,
          duration: dur - 0.02,
          confidence: 1,
          loudness_start: spec.loudness - 2,
          loudness_max: spec.loudness,
          loudness_max_time: 0.1,
          pitches,
          timbre: Array.from({ length: 12 }, (_, k) =>
            k === 0 ? spec.timbreVal : 0,
          ),
        });
        idx += 1;
      }
    }
    const raw = {
      track: { duration: idx * dur },
      sections,
      bars,
      beats,
      tatums: [],
      segments,
    };

    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains, sources } = createAudioContext();
    const mainBuffer = { duration: 12 } as AudioBuffer;
    controller.setAudio(mainBuffer, context);
    controller.setAnalysis(raw, raw.track.duration);
    controller.setSingleSongVoiceCount(4);

    expect(gains[0].gain.value).toBeCloseTo(0.31);
    expect(gains[1].gain.value).toBeCloseTo(0.23);
    expect(gains[2].gain.value).toBeCloseTo(0.23);
    expect(gains[3].gain.value).toBeCloseTo(0.23);

    const inner = controller as unknown as {
      beats: Array<
        CanonizerBeat & {
          gold?: CanonizerBeat;
          goldGain?: number;
          pink?: CanonizerBeat;
          pinkGain?: number;
        }
      >;
    };
    const b0 = inner.beats[0];
    expect((b0.goldGain ?? 0) > 0).toBe(true);
    expect((b0.pinkGain ?? 0) > 0).toBe(true);
    expect(b0.pink?.section).not.toBe(b0.section);
    expect(b0.pink?.section).not.toBe(b0.other.section);
    expect(b0.pink?.section).not.toBe(b0.gold?.section);

    // Unique section B (beat 2) mutes both Gold and Pink cleanly.
    expect(inner.beats[2].goldGain).toBe(0);
    expect(inner.beats[2].pinkGain).toBe(0);

    const onBeat = vi.fn();
    controller.setOnBeat(onBeat);
    controller.startAtIndex(0);
    expect(sources).toHaveLength(4);
    expect(onBeat).toHaveBeenLastCalledWith(
      0,
      b0,
      expect.objectContaining({
        mainSeconds: 0,
        goldSeconds: b0.gold!.start,
        pinkSeconds: b0.pink!.start,
      }),
    );

    (context as unknown as { currentTime: number }).currentTime = 0.2;
    expect(controller.getLiveCursorTimes()).toEqual(
      expect.objectContaining({
        mainSeconds: 0.2,
        goldSeconds: b0.gold!.start + 0.2,
        pinkSeconds: b0.pink!.start + 0.2,
      }),
    );

    // Beat 2 (muted Gold & Pink) emits pinkSeconds: null and goldSeconds: null.
    controller.startAtIndex(2);
    expect(gains[2].gain.value).toBe(0);
    expect(gains[3].gain.value).toBe(0);
    expect(controller.getLiveCursorTimes()).toEqual(
      expect.objectContaining({
        goldSeconds: null,
        pinkSeconds: null,
      }),
    );
    controller.stop();

    const plan = controller.planRender();
    expect(plan?.voices).toHaveLength(4);
    expect(plan?.voices.map((v) => v.sourceIndex)).toEqual([0, 0, 0, 0]);
  });

  it("finishes out Green, Gold, and Pink voices sequentially in 4-voice single-song mode", () => {
    vi.useFakeTimers();
    const controller = new AutocanonizerController({} as HTMLElement);
    const { context, gains } = createAudioContext();
    controller.setAudio({ duration: 10 } as AudioBuffer, context);
    controller.setSingleSongVoiceCount(4);

    // Final beat 3: other=2 (2 beats left), gold=1 (3 beats left), pink=0 (4 beats left).
    const b0 = createBeat(0, 0);
    const b1 = createBeat(1, 0.1);
    const b2 = createBeat(2, 0.2);
    const b3 = createBeat(3, 0.3);
    b0.next = b1;
    b1.prev = b0;
    b1.next = b2;
    b2.prev = b1;
    b2.next = b3;
    b3.prev = b2;
    b0.other = b1;
    b1.other = b2;
    b2.other = b3;
    b3.other = b2;
    b0.gold = b2;
    b1.gold = b3;
    b2.gold = b0;
    b3.gold = b1;
    b0.pink = b3;
    b1.pink = b0;
    b2.pink = b1;
    b3.pink = b0;
    b0.goldGain = 1;
    b1.goldGain = 1;
    b2.goldGain = 1;
    b3.goldGain = 1;
    b0.pinkGain = 1;
    b1.pinkGain = 1;
    b2.pinkGain = 1;
    b3.pinkGain = 1;

    (controller as unknown as { beats: CanonizerBeat[] }).beats = [b0, b1, b2, b3];
    const onBeat = vi.fn();
    const onEnded = vi.fn();
    controller.setFinishOutSong(true);
    controller.setOnBeat(onBeat);
    controller.setOnEnded(onEnded);

    controller.startAtIndex(3);
    expect(onBeat).toHaveBeenLastCalledWith(2, b2, {
      mainSeconds: 0.3,
      otherSeconds: 0.2,
      goldSeconds: 0.1,
      pinkSeconds: 0,
    });

    (context as unknown as { currentTime: number }).currentTime = 0.1;
    vi.advanceTimersByTime(100);
    expect(onBeat).toHaveBeenLastCalledWith(3, b3, {
      mainSeconds: 0.3,
      otherSeconds: 0.3,
      goldSeconds: 0.2,
      pinkSeconds: 0.1,
    });

    (context as unknown as { currentTime: number }).currentTime = 0.2;
    vi.advanceTimersByTime(100);
    expect(onBeat).toHaveBeenLastCalledWith(3, b3, {
      mainSeconds: 0.3,
      otherSeconds: 0.3,
      goldSeconds: 0.3,
      pinkSeconds: 0.2,
    });

    // Final beat with Pink alone (Green & Gold both finished).
    (context as unknown as { currentTime: number }).currentTime = 0.3;
    vi.advanceTimersByTime(100);
    expect(onBeat).toHaveBeenLastCalledWith(3, b3, {
      mainSeconds: 0.3,
      otherSeconds: 0.3,
      goldSeconds: null,
      pinkSeconds: 0.3,
    });
    expect(gains[1].gain.value).toBe(0);
    expect(gains[3].gain.value).toBe(0);
    expect(gains[2].gain.value).toBeCloseTo(0.23);
    expect(onEnded).not.toHaveBeenCalled();

    (context as unknown as { currentTime: number }).currentTime = 0.4;
    vi.advanceTimersByTime(100);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
