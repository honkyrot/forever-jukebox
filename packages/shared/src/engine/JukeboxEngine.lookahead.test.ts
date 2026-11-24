import { describe, expect, it, vi } from "vitest";

vi.mock("../background/backgroundTimer", () => ({
  backgroundSetTimeout: (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => globalThis.setTimeout(callback, delay, ...args),
  backgroundClearTimeout: (id: number) => globalThis.clearTimeout(id),
}));

import {
  JukeboxEngine,
  type JukeboxPlayer,
} from "./JukeboxEngine";
import type {
  JukeboxConfig,
  QuantumBase,
  Segment,
  TrackAnalysis,
} from "./types";

function makeSegment(which: number, timbre0 = which * 100): Segment {
  const timbre = new Array<number>(12).fill(0);
  timbre[0] = timbre0;
  return {
    // Keep segment bounds strictly inside beat [which * 0.5, which * 0.5 + 0.5)
    // so normalizeAnalysis assigns exactly one segment per beat.
    start: which * 0.5 + 0.1,
    duration: 0.3,
    confidence: 1,
    loudness_start: -10,
    loudness_max: -5,
    loudness_max_time: 0.1,
    pitches: new Array<number>(12).fill(0.5),
    timbre,
    which,
  };
}

function makeBeat(
  which: number,
  timbre0 = which * 100,
  indexInParent = 0,
  trackIndex?: number,
): QuantumBase {
  const seg = makeSegment(which, timbre0);
  return {
    start: which * 0.5,
    duration: 0.5,
    which,
    indexInParent,
    ...(trackIndex !== undefined ? { trackIndex } : {}),
    prev: null,
    next: null,
    overlappingSegments: [seg],
    neighbors: [],
    allNeighbors: [],
  };
}

function linkBeats(beats: QuantumBase[]) {
  beats.forEach((beat, idx) => {
    beat.prev = idx > 0 ? beats[idx - 1] : null;
    beat.next = idx < beats.length - 1 ? beats[idx + 1] : null;
  });
}

function makeAnalysis(beatCount: number, timbreValues?: number[]): TrackAnalysis {
  const beats = Array.from({ length: beatCount }, (_, idx) =>
    makeBeat(idx, timbreValues ? timbreValues[idx] : idx * 100, 0),
  );
  linkBeats(beats);
  const bars = beats.map((beat) => ({
    ...makeBeat(beat.which),
    overlappingSegments: [],
  }));
  const segments = beats.map((beat) => beat.overlappingSegments[0]);
  return {
    sections: [],
    bars,
    beats,
    tatums: [],
    segments,
    track: { duration: beatCount * 0.5 },
  };
}

function makePlayer(trackTimeRef = { value: 0 }): JukeboxPlayer {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn((time) => {
      trackTimeRef.value = time;
    }),
    scheduleJump: vi.fn(() => true),
    cancelScheduledJump: vi.fn(),
    getCurrentTime: () => trackTimeRef.value,
    getAudioTime: () => trackTimeRef.value,
    getPlaybackRate: () => 1,
    isPlaying: () => true,
  };
}

function createSampleAnalysis(): TrackAnalysis {
  // Cluster beats {1, 4, 7}, {2, 5, 9}, and {0, 11} by timbre distance (< 60)
  // while keeping unrelated beats separated (> 200) so buildJumpGraph creates
  // multi-neighbor branches and weighted/rotated choices.
  const timbres = [
    200, // 0 -> pairs with 11
    10,  // 1 -> pairs with 4, 7
    300, // 2 -> pairs with 5, 9
    600, // 3
    14,  // 4 -> pairs with 1, 7
    304, // 5 -> pairs with 2, 9
    800, // 6
    19,  // 7 -> pairs with 1, 4
    1000, // 8
    309, // 9 -> pairs with 2, 5
    1200, // 10
    203, // 11 -> pairs with 0
  ];
  return makeAnalysis(12, timbres);
}

type EngineHarness = {
  currentBeatIndex: number;
  lastJumped: boolean;
  lastJumpFromIndex: number | null;
  lastJumpToIndex: number | null;
  lastJumpWasBranch: boolean;
  curRandomBranchChance: number;
  pendingAdvance: {
    selectedBranch: boolean;
    chosenIndex: number;
    jumpFromIndex: number | null;
    selectedEdgeId?: number | null;
  } | null;
  advanceBeat: (audioTime: number) => void;
  preparePendingAdvance: (boundaryAudioTime: number) => void;
};

describe("JukeboxEngine lookahead", () => {
  const sampleConfig: Partial<JukeboxConfig> = {
    currentThreshold: 60,
    minRandomBranchChance: 0.2,
    maxRandomBranchChance: 0.8,
    randomBranchChanceDelta: 0.1,
    justBackwards: false,
    justLongBranches: false,
    removeSequentialBranches: false,
  };

  it("predicts the exact upcoming branch jumps in seeded and random modes", () => {
    for (const randomMode of ["seeded", "random"] as const) {
      const player = makePlayer();
      const engine = new JukeboxEngine(player, {
        randomMode,
        seed: 1337,
        config: sampleConfig,
      });
      engine.loadAnalysis(createSampleAnalysis());

      const predicted = engine.getPredictedJumps(3);
      expect(predicted).toHaveLength(3);

      const internal = engine as unknown as EngineHarness;
      const actualJumps: Array<{ fromIndex: number; toIndex: number }> = [];
      for (let step = 0; step < 120 && actualJumps.length < 3; step += 1) {
        internal.advanceBeat(step * 0.5);
        if (
          internal.lastJumped &&
          internal.lastJumpWasBranch &&
          internal.lastJumpFromIndex !== null &&
          internal.lastJumpToIndex !== null
        ) {
          actualJumps.push({
            fromIndex: internal.lastJumpFromIndex,
            toIndex: internal.lastJumpToIndex,
          });
        }
      }

      expect(actualJumps).toEqual(
        predicted.map(({ fromIndex, toIndex }) => ({ fromIndex, toIndex })),
      );
    }
  });

  it("does not mutate live neighbor order, branch chance, or future path", () => {
    const createEngineWithAnalysis = () => {
      const engine = new JukeboxEngine(makePlayer(), {
        randomMode: "seeded",
        seed: 42,
        config: sampleConfig,
      });
      engine.loadAnalysis(createSampleAnalysis());
      return engine;
    };

    const baseline = createEngineWithAnalysis();
    const inspected = createEngineWithAnalysis();

    const vizData = inspected.getVisualizationData()!;
    const initialOrder = vizData.beats.map((b) => b.neighbors.map((e) => e.id));
    const firstPrediction = inspected.getPredictedJumps(5);
    expect(inspected.getPredictedJumps(5)).toEqual(firstPrediction);
    expect(vizData.beats.map((b) => b.neighbors.map((e) => e.id))).toEqual(
      initialOrder,
    );

    const baselineInternal = baseline as unknown as EngineHarness;
    const inspectedInternal = inspected as unknown as EngineHarness;
    const baselineTrace: number[] = [];
    const inspectedTrace: number[] = [];

    for (let step = 0; step < 50; step += 1) {
      inspected.getPredictedJumps(5);
      baselineInternal.advanceBeat(step * 0.5);
      inspectedInternal.advanceBeat(step * 0.5);
      baselineTrace.push(baselineInternal.currentBeatIndex);
      inspectedTrace.push(inspectedInternal.currentBeatIndex);
    }

    expect(inspectedTrace).toEqual(baselineTrace);
  });

  it("aligns with pendingAdvance and slides the window after each jump", () => {
    const trackTimeRef = { value: 0 };
    const engine = new JukeboxEngine(makePlayer(trackTimeRef), {
      randomMode: "seeded",
      seed: 1337,
      config: sampleConfig,
    });
    engine.loadAnalysis(createSampleAnalysis());
    const internal = engine as unknown as EngineHarness;

    const initialThree = engine.getPredictedJumps(4);
    expect(initialThree).toHaveLength(4);
    expect(initialThree.map((jump) => jump.sequenceIndex)).toEqual([0, 1, 2, 3]);

    let seenPendingBranch = false;
    let firstJumpObserved = false;
    for (let step = 0; step < 60 && !firstJumpObserved; step += 1) {
      internal.advanceBeat(step * 0.5);
      trackTimeRef.value =
        engine.getVisualizationData()!.beats[internal.currentBeatIndex].start;
      internal.preparePendingAdvance((step + 1) * 0.5);

      const pending = internal.pendingAdvance;
      const upcoming = engine.getPredictedJumps(3);
      expect(upcoming).toHaveLength(3);

      if (pending?.selectedBranch && pending.jumpFromIndex !== null) {
        seenPendingBranch = true;
        expect(upcoming[0]).toEqual({
          fromIndex: pending.jumpFromIndex,
          toIndex: pending.chosenIndex,
          edgeId: pending.selectedEdgeId ?? null,
          sequenceIndex: 0,
        });
      }

      if (internal.lastJumped && internal.lastJumpWasBranch) {
        firstJumpObserved = true;
        // Remaining branches keep their original sequenceIndex [1, 2, 3] instead of shifting to [0, 1, 2].
        expect(upcoming).toEqual(initialThree.slice(1, 4));
        expect(upcoming.map((jump) => jump.sequenceIndex)).toEqual([1, 2, 3]);
      }
    }

    expect(seenPendingBranch).toBe(true);
    expect(firstJumpObserved).toBe(true);

    // Resetting stats or rerolling resets the color sequence counter back to 0.
    engine.resetStats();
    expect(
      engine.getPredictedJumps(3).map((jump) => jump.sequenceIndex),
    ).toEqual([0, 1, 2]);
    engine.rerollRandomSeed();
    expect(
      engine.getPredictedJumps(3).map((jump) => jump.sequenceIndex),
    ).toEqual([0, 1, 2]);
  });

  it("rerolls random seed on parameter edits only in random mode and never on resetStats", () => {
    const seeds = [1001, 2002, 3003, 4004, 5005, 6006];
    let seedCursor = 0;
    const cryptoSpy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((array) => {
        const view = array as Uint32Array;
        view[0] = seeds[seedCursor % seeds.length];
        seedCursor += 1;
        return array;
      });

    try {
      const randomEngine = new JukeboxEngine(makePlayer(), {
        randomMode: "random",
        config: sampleConfig,
      });
      randomEngine.loadAnalysis(createSampleAnalysis());
      const readRngSample = (engine: JukeboxEngine) =>
        (engine as unknown as { rngState: { clone: () => { next: () => number } } }).rngState
          .clone()
          .next();

      const afterLoad = readRngSample(randomEngine);
      randomEngine.resetStats();
      expect(readRngSample(randomEngine)).toBe(afterLoad);

      randomEngine.rebuildGraph();
      const afterRebuild = readRngSample(randomEngine);
      expect(afterRebuild).not.toBe(afterLoad);

      const edges = randomEngine.getVisualizationData()!.edges;
      const nonAnchorEdge = edges.find((edge) => edge.src.which === 4)!;
      randomEngine.setUserAnchorEdge(nonAnchorEdge);
      const afterPin = readRngSample(randomEngine);
      expect(afterPin).not.toBe(afterRebuild);

      randomEngine.setCustomAnchor(8, 2);
      const afterCustom = readRngSample(randomEngine);
      expect(afterCustom).not.toBe(afterPin);

      randomEngine.deleteEdge(nonAnchorEdge);
      const afterDelete = readRngSample(randomEngine);
      expect(afterDelete).not.toBe(afterCustom);

      const seededEngine = new JukeboxEngine(makePlayer(), {
        randomMode: "seeded",
        seed: 777,
        config: sampleConfig,
      });
      seededEngine.loadAnalysis(createSampleAnalysis());
      const seededBefore = readRngSample(seededEngine);
      seededEngine.rebuildGraph();
      seededEngine.setUserAnchorEdge(
        seededEngine.getVisualizationData()!.edges[0],
      );
      seededEngine.setCustomAnchor(8, 2);
      seededEngine.deleteEdge(seededEngine.getVisualizationData()!.edges[0]);
      expect(readRngSample(seededEngine)).toBe(seededBefore);
    } finally {
      cryptoSpy.mockRestore();
    }
  });

  it("handles edge cases, playback overrides, and multi-track slices cleanly", () => {
    const engine = new JukeboxEngine(makePlayer(), {
      randomMode: "seeded",
      seed: 1337,
      config: sampleConfig,
    });
    expect(engine.getPredictedJumps(3)).toEqual([]);

    engine.loadAnalysis(createSampleAnalysis());
    expect(engine.getPredictedJumps(0)).toEqual([]);
    expect(engine.getPredictedJumps(-2)).toEqual([]);

    const normal = engine.getPredictedJumps(3);
    expect(normal).toHaveLength(3);

    engine.setBringItHomeMode(true);
    expect(engine.getPredictedJumps(3)).toEqual([]);
    engine.setBringItHomeMode(false);
    expect(engine.getPredictedJumps(3)).toEqual(normal);

    engine.setFreezeCurrentBeat(true);
    expect(engine.getPredictedJumps(3)).toEqual([]);
    engine.setFreezeCurrentBeat(false);
    expect(engine.getPredictedJumps(3)).toEqual(normal);

    engine.setPlayVelocity(2);
    const velocityJumps = engine.getPredictedJumps(3);
    const internal = engine as unknown as EngineHarness;
    const actualVelocityJumps: Array<{ fromIndex: number; toIndex: number }> = [];
    for (let step = 0; step < 120 && actualVelocityJumps.length < 3; step += 1) {
      internal.advanceBeat(step * 0.5);
      if (
        internal.lastJumped &&
        internal.lastJumpWasBranch &&
        internal.lastJumpFromIndex !== null &&
        internal.lastJumpToIndex !== null
      ) {
        actualVelocityJumps.push({
          fromIndex: internal.lastJumpFromIndex,
          toIndex: internal.lastJumpToIndex,
        });
      }
    }
    expect(actualVelocityJumps).toEqual(
      velocityJumps.map(({ fromIndex, toIndex }) => ({ fromIndex, toIndex })),
    );

    const zeroChanceEngine = new JukeboxEngine(makePlayer(), {
      randomMode: "seeded",
      seed: 1,
      config: {
        ...sampleConfig,
        minRandomBranchChance: 0,
        maxRandomBranchChance: 0,
        randomBranchChanceDelta: 0,
      },
    });
    zeroChanceEngine.loadAnalysis(makeAnalysis(6));
    expect(zeroChanceEngine.getPredictedJumps(3)).toEqual([]);

    // Multi-track analysis: two 5-beat slices with cross-track branches (2 <-> 7, 8 <-> 1).
    const multiTimbres = [500, 100, 10, 700, 900, 1100, 1300, 12, 103, 1500];
    const multiBeats = Array.from({ length: 10 }, (_, idx) =>
      makeBeat(idx, multiTimbres[idx], 0, idx < 5 ? 0 : 1),
    );
    linkBeats(multiBeats);
    const multiAnalysis: TrackAnalysis = {
      sections: [],
      bars: [],
      beats: multiBeats,
      tatums: [],
      segments: multiBeats.map((b) => b.overlappingSegments[0]),
      track: { duration: 5 },
      tracks: [
        {
          trackIndex: 0,
          duration: 2.5,
          tempoRatio: 1,
          startTimeOffset: 0,
          startBeatIndex: 0,
          beatCount: 5,
        },
        {
          trackIndex: 1,
          duration: 2.5,
          tempoRatio: 1,
          startTimeOffset: 2.5,
          startBeatIndex: 5,
          beatCount: 5,
        },
      ],
    };
    const multiEngine = new JukeboxEngine(makePlayer(), {
      randomMode: "seeded",
      seed: 1337,
      config: {
        ...sampleConfig,
        minRandomBranchChance: 1,
        maxRandomBranchChance: 1,
      },
    });
    multiEngine.loadAnalysis(multiAnalysis);
    expect(multiEngine.getVisualizationData()!.edges.length).toBeGreaterThan(0);
    const multiPredicted = multiEngine.getPredictedJumps(3);
    expect(multiPredicted).toHaveLength(3);
    const multiInternal = multiEngine as unknown as EngineHarness;
    const multiActual: Array<{ fromIndex: number; toIndex: number }> = [];
    for (let step = 0; step < 30 && multiActual.length < 3; step += 1) {
      multiInternal.advanceBeat(step * 0.5);
      if (
        multiInternal.lastJumped &&
        multiInternal.lastJumpWasBranch &&
        multiInternal.lastJumpFromIndex !== null &&
        multiInternal.lastJumpToIndex !== null
      ) {
        multiActual.push({
          fromIndex: multiInternal.lastJumpFromIndex,
          toIndex: multiInternal.lastJumpToIndex,
        });
      }
    }
    expect(multiActual).toEqual(
      multiPredicted.map(({ fromIndex, toIndex }) => ({ fromIndex, toIndex })),
    );
  });
});
