import { afterEach, describe, expect, it, vi } from "vitest";
import { SongSyncController } from "./SongSyncController";

vi.mock("./SongSyncViz", () => ({
  SONG_SYNC_TRACK_COLORS: ["#4F8FFF", "#10DF00", "#FF4FA3", "#FFB800"],
  SongSyncViz: class SongSyncViz {
    setVisible() {}
    resizeNow() {}
    setData() {}
    update() {}
    reset() {}
    destroy() {}
    setOnSelect() {}
  },
}));

const CHORDS = {
  C: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  G: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
  Am: [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
  F: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
  Bb: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  Eb: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
  Dm: [0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0],
  Em: [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
} as const;

function makeAnalysis(progression: ReadonlyArray<readonly number[]>, dur = 0.5) {
  const total = progression.length * dur;
  return {
    track: { duration: total, tempo: 60 / dur },
    sections: [{ start: 0, duration: total, confidence: 1 }],
    bars: [{ start: 0, duration: total, confidence: 1 }],
    beats: progression.map((_, i) => ({
      start: i * dur,
      duration: dur,
      confidence: 1,
    })),
    tatums: [],
    segments: progression.map((pitches, i) => ({
      start: i * dur,
      duration: dur,
      confidence: 1,
      loudness_start: -10,
      loudness_max: -5,
      loudness_max_time: 0.1,
      pitches: [...pitches],
      timbre: new Array(12).fill(0),
    })),
  };
}

function createMockAudioContext() {
  const gains: Array<{ gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const panners: Array<{ pan: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const sources: Array<{ buffer: AudioBuffer | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: () => {
      const node = {
        gain: {
          value: 0,
          setValueAtTime: vi.fn((val: number) => {
            node.gain.value = val;
          }),
          linearRampToValueAtTime: vi.fn((val: number) => {
            node.gain.value = val;
          }),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node as unknown as GainNode;
    },
    createStereoPanner: () => {
      const node = {
        pan: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      panners.push(node);
      return node as unknown as StereoPannerNode;
    },
    createBufferSource: () => {
      const src = {
        buffer: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(src);
      return src as unknown as AudioBufferSourceNode;
    },
    createDynamicsCompressor: () => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 1 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
    }),
  } as unknown as AudioContext;
  return { context, gains, panners, sources };
}

describe("SongSyncController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-selects the longest track as master and aligns shared sections while leaving unique sections silent", () => {
    const introC1 = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F, CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const uniqueMid = [CHORDS.Bb, CHORDS.Eb, CHORDS.Bb, CHORDS.Eb, CHORDS.Dm, CHORDS.Em, CHORDS.Bb, CHORDS.Eb];
    const fullProg = [...introC1, ...uniqueMid, ...introC1]; // 24 beats (12s)
    const shortProg = [...introC1]; // 8 beats (4s)

    const { context, gains, sources } = createMockAudioContext();
    const controller = new SongSyncController({} as HTMLElement);
    const shortBuf = { duration: 4 } as AudioBuffer;
    const fullBuf = { duration: 12 } as AudioBuffer;

    // Pass short track first to verify longest track (index 1) becomes master.
    controller.setTracks(
      [
        { title: "EN Short", buffer: shortBuf, analysis: makeAnalysis(shortProg), durationSec: 4 },
        { title: "JP Full", buffer: fullBuf, analysis: makeAnalysis(fullProg), durationSec: 12 },
      ],
      context,
    );

    expect(controller.getMasterTrackIndex()).toBe(1);
    const snapshots: Array<{ idx: number; sec0: number | null; sec1: number | null }> = [];
    controller.setOnBeat((snap) => {
      snapshots.push({
        idx: snap.masterBeatIndex,
        sec0: snap.trackSeconds[0],
        sec1: snap.trackSeconds[1],
      });
    });

    // Beat 2 is in matched introC1 -> both tracks play.
    controller.startAtIndex(2);
    expect(snapshots[0].sec0).not.toBeNull();
    expect(snapshots[0].sec1).toBeCloseTo(1.0);
    expect(sources.some((s) => s.buffer === shortBuf)).toBe(true);

    // Beat 11 is in uniqueMid -> EN Short silences cleanly (null timestamp, 0 gain).
    controller.selectIndex(11, false);
    const midSnap = snapshots[snapshots.length - 1];
    expect(midSnap.sec0).toBeNull();
    expect(midSnap.sec1).toBeCloseTo(5.5);
    expect(gains[1].gain.value).toBe(0);

    // Beat 18 is in repeated chorus -> EN Short re-enters cleanly.
    controller.selectIndex(18, false);
    const endSnap = snapshots[snapshots.length - 1];
    expect(endSnap.sec0).not.toBeNull();
    expect(endSnap.sec1).toBeCloseTo(9.0);

    controller.stop();
  });

  it("supports live gain, pan, mute, solo, beatOffset, master switching, and looping", () => {
    vi.useFakeTimers();
    const prog = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const { context, gains, panners } = createMockAudioContext();
    const controller = new SongSyncController({} as HTMLElement);
    const bufA = { duration: 2 } as AudioBuffer;
    const bufB = { duration: 2 } as AudioBuffer;

    controller.setTracks(
      [
        { title: "Track A", buffer: bufA, analysis: makeAnalysis(prog), durationSec: 2 },
        { title: "Track B", buffer: bufB, analysis: makeAnalysis(prog), durationSec: 2 },
      ],
      context,
      { loop: false },
    );

    controller.setTrackConfig(0, { pan: -0.5, gain: 1.2 });
    controller.setTrackConfig(1, { muted: true });
    expect(panners[0].pan.value).toBeCloseTo(-0.5);
    expect(gains[1].gain.value).toBeGreaterThan(0);
    expect(gains[2].gain.value).toBe(0);

    controller.setTrackConfig(1, { muted: false, solo: true });
    expect(gains[1].gain.value).toBe(0);
    expect(gains[2].gain.value).toBeGreaterThan(0);

    controller.setTrackConfig(1, { solo: false, beatOffset: 1 });
    expect(controller.getTrackMeta()[1].beatOffset).toBe(1);

    controller.setMasterTrackIndex(1);
    expect(controller.getMasterTrackIndex()).toBe(1);

    const onEnded = vi.fn();
    controller.setOnEnded(onEnded);
    controller.startAtIndex(3);
    vi.advanceTimersByTime(600);
    expect(onEnded).toHaveBeenCalledTimes(1);

    controller.setLoop(true);
    const onBeat = vi.fn();
    controller.setOnBeat(onBeat);
    controller.startAtIndex(3);
    vi.advanceTimersByTime(600);
    expect(onBeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onBeat.mock.calls[1][0].masterBeatIndex).toBe(0);

    controller.stop();
  });

  it("clears visualization data on reset and avoids double-starting when onSelect is attached", () => {
    const prog = [CHORDS.C, CHORDS.G, CHORDS.Am, CHORDS.F];
    const { context } = createMockAudioContext();
    const controller = new SongSyncController({} as HTMLElement);
    const viz = (
      controller as unknown as {
        viz: {
          setData: ReturnType<typeof vi.fn>;
          reset: ReturnType<typeof vi.fn>;
          onSelect: ((trackIndex: number, beatIndex: number) => void) | null;
        };
      }
    ).viz;
    const setDataSpy = vi.spyOn(viz, "setData");
    const resetSpy = vi.spyOn(viz, "reset");
    const selectSpy = vi.spyOn(controller, "selectIndex");
    const onSelect = vi.fn();
    controller.setOnSelect(onSelect);

    // Trigger mocked SongSyncViz onSelect callback directly if captured, or verify reset().
    controller.setTracks(
      [
        { title: "Track A", buffer: { duration: 2 } as AudioBuffer, analysis: makeAnalysis(prog), durationSec: 2 },
        { title: "Track B", buffer: { duration: 2 } as AudioBuffer, analysis: makeAnalysis(prog), durationSec: 2 },
      ],
      context,
    );
    expect(selectSpy).not.toHaveBeenCalled();

    setDataSpy.mockClear();
    resetSpy.mockClear();
    controller.reset();
    expect(setDataSpy).toHaveBeenCalledWith([], 0, []);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });
});
