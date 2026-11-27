import { act, Profiler } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Listen } from "./Listen";
import { VISUALIZATION_LABELS } from "@forever-jukebox/shared/constants/visualization";
import { getOrCreateSwingBuffer } from "@forever-jukebox/shared/audio/swingBufferCache";
import { renderSwingBuffer } from "@forever-jukebox/shared/audio/swingRenderer";
import { markStoredCopy } from "@forever-jukebox/shared/audio/renderedTrackCache";
import { setFileHandle } from "@/core/infrastructure/cache/fileHandleStore";
import {
  AnalyzeAudioUseCase,
  type AnalyzeAudioResult,
} from "@/core/application/usecases/analyzeAudio";
import {
  cancelInstrumentalRender,
  isInstrumentalModeAvailable,
  renderInstrumentalBuffer,
} from "@forever-jukebox/shared/audio/instrumentalRenderer";
import type { LocalMixTrack } from "../state/mixQueue";
import * as localMix from "./listen/localMix";

const exportMocks = vi.hoisted(() => ({
  exportJukeboxAudio: vi.fn(),
  exportCanonizerAudio: vi.fn(),
  exportRenderedAudio: vi.fn(),
  pickBinaryExportFile: vi.fn(),
  saveExportBinary: vi.fn(),
}));
const wubMachineMocks = vi.hoisted(() => ({
  renderWubMachineBuffer: vi.fn(),
}));

const mockAppState = {
  file: null as File | null,
  fileHandle: null as FileSystemFileHandle | null,
  setIsListenLoading: vi.fn<(loading: boolean) => void>(),
  isSettingsOpen: false,
  setIsSettingsOpen: vi.fn<(isOpen: boolean) => void>(),
  mixQueue: [] as LocalMixTrack[],
  activeQueueIndex: -1,
  mixAddSticky: false,
  setMixAddSticky: vi.fn<(sticky: boolean) => void>(),
  addFilesToMixQueue: vi.fn(),
  removeFromMixQueue: vi.fn(),
  moveMixQueueItem: vi.fn(),
  clearMixQueue: vi.fn(),
  selectMixQueueIndex: vi.fn(),
  updateMixQueueTrackMeta: vi.fn(),
};

type MockAutocanonizerInstance = {
  setFinishOutSong: ReturnType<typeof vi.fn>;
  planRender: ReturnType<typeof vi.fn>;
  setStreamPans: ReturnType<typeof vi.fn>;
  setQuadStreamPans: ReturnType<typeof vi.fn>;
  setDualAudio: ReturnType<typeof vi.fn>;
  setDualAnalysis: ReturnType<typeof vi.fn>;
  setStreamGains: ReturnType<typeof vi.fn>;
  setQuadStreamGains: ReturnType<typeof vi.fn>;
  setQuadMode: ReturnType<typeof vi.fn>;
  setQuadBranchMode: ReturnType<typeof vi.fn>;
  setDualAlignmentMode: ReturnType<typeof vi.fn>;
  getAudioBuffers: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  startAtIndex: ReturnType<typeof vi.fn>;
  emitBeat: (
    index: number,
    cursorTimes: {
      mainSeconds: number;
      otherSeconds: number;
      pinkSeconds?: number;
      goldSeconds?: number;
    },
  ) => void;
  emitSelect: (index: number) => void;
};

const autocanonizerInstances: MockAutocanonizerInstance[] = [];
type MockWubMachineInstance = {
  setRemix: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitTick: (seconds: number) => void;
  emitEnded: () => void;
  emitSelect: (seconds: number) => void;
};
const wubMachineInstances: MockWubMachineInstance[] = [];
type MockPlayerInstance = {
  emitEnded: () => void;
  getAudioMode: () => string;
  getVolume: () => number;
};
const playerInstances: MockPlayerInstance[] = [];
type MockJukeboxControllerInstance = {
  emitEdgeSelect: (edge: unknown) => void;
  setData: ReturnType<typeof vi.fn>;
  setSelectedEdge: ReturnType<typeof vi.fn>;
  setSelectedEdgeActive: ReturnType<typeof vi.fn>;
  setVisualPreferences: ReturnType<typeof vi.fn>;
  setPredictedJumps: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  setAnchorEdit: ReturnType<typeof vi.fn>;
  setOnAnchorEditCommit: ReturnType<typeof vi.fn>;
};
const jukeboxControllerInstances: MockJukeboxControllerInstance[] = [];
type MockEngineInstance = {
  pauseJukebox: ReturnType<typeof vi.fn>;
  syncToPlaybackPosition: ReturnType<typeof vi.fn>;
  stopJukebox: ReturnType<typeof vi.fn>;
  startJukebox: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  clearDeletedEdges: ReturnType<typeof vi.fn>;
  setUserAnchorEdge: ReturnType<typeof vi.fn>;
  getUserAnchorEdgeId: ReturnType<typeof vi.fn>;
  getUserAnchorEdge: ReturnType<typeof vi.fn>;
  getPredictedJumps: ReturnType<typeof vi.fn>;
  getConfig: () => {
    justLongBranches: boolean;
    minLongBranchPercent?: number;
  };
  getLastJumpWasBranch: ReturnType<typeof vi.fn>;
  getPlayVelocity: ReturnType<typeof vi.fn>;
  setPlayVelocity: ReturnType<typeof vi.fn>;
  setFreezeCurrentBeat: ReturnType<typeof vi.fn>;
  setForceBranch: ReturnType<typeof vi.fn>;
  getVisualizationData: () => {
    beats: typeof mockAnalysis.beats;
    edges: any[];
  };
  emitUpdate: (state: any) => void;
};
const engineInstances: MockEngineInstance[] = [];
// Edges the mock engine reports from getVisualizationData; set before
// renderListen so they are picked up when the route syncs viz data on load.
let mockVizEdges: unknown[] = [];
// Beats the engine mock reports to the viz; null falls back to the analysis beats.
let mockVizBeats: typeof mockAnalysis.beats | null = null;

const ARC_VIZ_INDEX = VISUALIZATION_LABELS.indexOf("Arc");

const mockAnalysis = {
  sections: [{ start: 0, duration: 4, confidence: 1 }],
  bars: [{ start: 0, duration: 1, confidence: 1 }],
  beats: [
    { start: 0, duration: 1, confidence: 1 },
    { start: 1, duration: 1, confidence: 1 },
  ],
  tatums: [{ start: 0, duration: 0.5, confidence: 1 }],
  segments: [
    {
      start: 0,
      duration: 1,
      confidence: 1,
      loudness_start: 0,
      loudness_max: 0,
      loudness_max_time: 0,
      pitches: new Array(12).fill(0),
      timbre: new Array(12).fill(0),
    },
  ],
  track: { duration: 4, tempo: 120, time_signature: 4 },
};

vi.mock("../state/AppState", () => ({
  useAppState: () => mockAppState,
}));

vi.mock("@/core/infrastructure/analysis/AnalysisWorkerClient", () => ({
  AnalysisWorkerClient: class AnalysisWorkerClient {},
}));

vi.mock("@/core/infrastructure/audio/AudioDecoder", () => ({
  AudioDecoder: class AudioDecoder {
    readonly context: unknown;

    constructor(context: unknown) {
      this.context = context;
    }

    decode = vi.fn(async (_file: File) => ({
      audioBuffer: { duration: 4 } as AudioBuffer,
      analysisAudio: new Float32Array(0),
      sampleRate: 44100,
      channels: 1,
    }));
  },
}));

vi.mock("@/core/infrastructure/cache/analysisCache", () => ({
  createAnalysisCache: () => ({}),
  getAnalysisCacheBytes: vi.fn(async () => 12.5 * 1024 * 1024),
  clearAllAnalysisCache: vi.fn(async () => {}),
  trimRenderedTracks: vi.fn(async () => {}),
}));

vi.mock("@/core/infrastructure/cache/fileHandleStore", () => ({
  setFileHandle: vi.fn(async () => {}),
}));

vi.mock("@/core/application/usecases/analyzeAudio", () => ({
  AnalyzeAudioUseCase: class AnalyzeAudioUseCase {
    readonly dependencies: unknown[];

    constructor(port: unknown, cache: unknown, decoder: unknown) {
      this.dependencies = [port, cache, decoder];
    }

    async execute({ onProgress }: { onProgress?: (value: any) => void }) {
      onProgress?.({ stage: "loading", progress: 0, message: "Loading file" });
      onProgress?.({ stage: "ready", progress: 100, message: "Ready" });
      return {
        analysis: mockAnalysis,
        audioBuffer: {} as AudioBuffer,
        fingerprint: "fp-test",
        fromCache: false,
      };
    }
  },
}));

vi.mock("@forever-jukebox/shared/audio/BufferedAudioPlayer", () => ({
  BufferedAudioPlayer: class BufferedAudioPlayer {
    private volume = 1;
    private onEnded: (() => void) | null = null;
    private audioMode = "off";
    constructor() {
      playerInstances.push(this);
    }
    loadBuffer = vi.fn(async (_buffer: AudioBuffer) => undefined);
    getContext() {
      return {
        destination: {},
        createGain: () => ({
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
      } as unknown as AudioContext;
    }
    setOnEnded(handler: (() => void) | null) {
      this.onEnded = handler;
    }
    getBuffer() {
      return {} as AudioBuffer;
    }
    getSourceBuffer() {
      return {} as AudioBuffer;
    }
    stop = vi.fn();
    seek = vi.fn((_time: number) => undefined);
    isPlaying() {
      return false;
    }
    setVolume(value: number) {
      this.volume = value;
    }
    getVolume() {
      return this.volume;
    }
    setJukeboxAudioMode = vi.fn((mode: string, _intensityPct?: number) => {
      this.audioMode = mode;
    });
    getJukeboxAudioMode() {
      return this.audioMode;
    }
    setJukeboxAudioModeIntensity = vi.fn((_intensityPct: number) => undefined);
    setRenderedJukeboxAudioBuffer = vi.fn(
      (_mode: string, _buffer: AudioBuffer) => undefined,
    );
    getRenderedJukeboxAudioBuffer(_mode: string) {
      return null;
    }
    getPlaybackRate() {
      return 1;
    }
    getCurrentTime() {
      return 0;
    }
    setPostMixTrackSlices = vi.fn();
    setPostMixTrackGains = vi.fn();
    setPostMixNormalization = vi.fn();
    clearPostMixTrackGains = vi.fn();
    emitEnded() {
      this.onEnded?.();
    }
    getAudioMode() {
      return this.audioMode;
    }
    dispose = vi.fn(async () => undefined);
  },
}));

vi.mock("@forever-jukebox/shared/audio/CowbellOverlayService", () => ({
  CowbellOverlayService: class CowbellOverlayService {
    enable = vi.fn();
    disable = vi.fn();
    setVolume = vi.fn();
    setSectionStartBeatIndices = vi.fn();
    cancelScheduledHits = vi.fn();
    handleBeatEnter = vi.fn();
    dispose = vi.fn();
  },
}));

const metronomeOverlayInstances: Array<{
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  setBeatsPerBar: ReturnType<typeof vi.fn>;
  setBeatsPerBarOverride: ReturnType<typeof vi.fn>;
  setBeatOffset: ReturnType<typeof vi.fn>;
  setMetronomeVolumePct: ReturnType<typeof vi.fn>;
  cancelScheduledHits: ReturnType<typeof vi.fn>;
  handleBeatEnter: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@forever-jukebox/shared/audio/MetronomeOverlayService", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@forever-jukebox/shared/audio/MetronomeOverlayService")
  >();
  return {
    ...actual,
    MetronomeOverlayService: class MetronomeOverlayService {
      enable = vi.fn();
      disable = vi.fn();
      setVolume = vi.fn();
      setBeatsPerBar = vi.fn();
      setBeatsPerBarOverride = vi.fn();
      setBeatOffset = vi.fn();
      setMetronomeVolumePct = vi.fn();
      cancelScheduledHits = vi.fn();
      handleBeatEnter = vi.fn();
      dispose = vi.fn();
      constructor() {
        metronomeOverlayInstances.push(this);
      }
    },
  };
});

vi.mock("@forever-jukebox/shared/audio/swingBufferCache", () => ({
  getOrCreateSwingBuffer: vi.fn(
    (
      _sourceBuffer: AudioBuffer,
      _sourceIdentity: string | null,
      render: () => Promise<AudioBuffer>,
    ) => render(),
  ),
}));

vi.mock("@forever-jukebox/shared/audio/swingRenderer", () => ({
  renderSwingBuffer: vi.fn(async () => ({ duration: 4 }) as AudioBuffer),
}));

vi.mock("@forever-jukebox/shared/audio/instrumentalRenderer", () => ({
  isInstrumentalModeAvailable: vi.fn(() => true),
  renderInstrumentalBuffer: vi.fn(async () => ({ duration: 4 }) as AudioBuffer),
  cancelInstrumentalRender: vi.fn(),
}));

vi.mock("@/shared/export/exporter", () => ({
  exportJukeboxAudio: exportMocks.exportJukeboxAudio,
  exportCanonizerAudio: exportMocks.exportCanonizerAudio,
  exportRenderedAudio: exportMocks.exportRenderedAudio,
}));

vi.mock("@forever-jukebox/shared/wubmachine/wubMachineRender", () => ({
  renderWubMachineBuffer: wubMachineMocks.renderWubMachineBuffer,
}));

vi.mock("@forever-jukebox/shared/wubmachine/WubMachineController", () => ({
  WubMachineController: class WubMachineController {
    private onTick: ((seconds: number) => void) | null = null;
    private onEnded: (() => void) | null = null;
    private onSelect: ((seconds: number) => void) | null = null;
    private remix: AudioBuffer | null = null;
    constructor(_layer: HTMLElement) {
      wubMachineInstances.push(this);
    }
    setVisible = vi.fn((_visible: boolean) => undefined);
    resizeNow = vi.fn();
    setOnTick(handler: ((seconds: number) => void) | null) {
      this.onTick = handler;
    }
    setOnEnded(handler: (() => void) | null) {
      this.onEnded = handler;
    }
    setOnSelect(handler: ((seconds: number) => void) | null) {
      this.onSelect = handler;
    }
    setVolume = vi.fn((_volume: number) => undefined);
    setLoop = vi.fn((_loop: boolean) => undefined);
    setRemix = vi.fn((buffer: AudioBuffer | null) => {
      this.remix = buffer;
    });
    isReady() {
      return this.remix !== null;
    }
    play = vi.fn((_from?: number) => undefined);
    pause = vi.fn();
    stop = vi.fn();
    destroy = vi.fn();
    emitTick(seconds: number) {
      this.onTick?.(seconds);
    }
    emitEnded() {
      this.onEnded?.();
    }
    emitSelect(seconds: number) {
      this.onSelect?.(seconds);
    }
  },
}));

vi.mock("@/shared/utils/exportJson", () => ({
  pickBinaryExportFile: exportMocks.pickBinaryExportFile,
  saveExportBinary: exportMocks.saveExportBinary,
}));

vi.mock("@forever-jukebox/shared", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@forever-jukebox/shared")
  >()),
  DEFAULT_MIN_LONG_BRANCH_PERCENT: 20,
  JukeboxEngine: class JukeboxEngine {
    private updateListener: ((state: any) => void) | null = null;
    private config = {
      maxBranches: 8,
      maxBranchThreshold: 80,
      currentThreshold: 0,
      justBackwards: false,
      justLongBranches: false,
      removeSequentialBranches: false,
      minRandomBranchChance: 0.18,
      maxRandomBranchChance: 0.5,
      randomBranchChanceDelta: 0.02,
      minLongBranch: 0,
      minLongBranchPercent: 20,
    };
    private analysis: typeof mockAnalysis | null = null;
    private playVelocity = 1;
    pauseJukebox = vi.fn();
    syncToPlaybackPosition = vi.fn();
    stopJukebox = vi.fn();
    resetStats = vi.fn();
    startJukebox = vi.fn();
    play = vi.fn();
    seekToBeat = vi.fn();
    setForceBranch = vi.fn();
    setBringItHomeMode = vi.fn();
    getLastJumpWasBranch = vi.fn(() => true);
    getPlayVelocity = vi.fn(() => this.playVelocity);
    setPlayVelocity = vi.fn((velocity: number) => {
      this.playVelocity = Math.max(-16, Math.min(16, Math.trunc(velocity)));
    });
    setFreezeCurrentBeat = vi.fn();
    setUserAnchorEdge = vi.fn();
    getUserAnchorEdgeId = vi.fn(() => null);
    getUserAnchorEdge = vi.fn(() => null);
    getAnchorParam = vi.fn((): unknown => null);
    applyAnchorParam = vi.fn(() => false);
    getActiveAnchor = vi.fn((): unknown => null);
    setCustomAnchor = vi.fn(() => true);
    deleteEdge = vi.fn();
    rebuildGraph = vi.fn();
    clearDeletedEdges = vi.fn();
    getPredictedJumps = vi.fn(() => [] as number[]);
    constructor(_player: unknown) {
      engineInstances.push(this);
    }
    loadAnalysis(data: typeof mockAnalysis) {
      this.analysis = data;
    }
    onUpdate(listener: (state: any) => void) {
      this.updateListener = listener;
    }
    emitUpdate(state: any) {
      this.updateListener?.(state);
    }
    updateConfig(partial: Partial<typeof this.config>) {
      this.config = { ...this.config, ...partial };
    }
    getConfig() {
      return { ...this.config };
    }
    getGraphState() {
      return {
        computedThreshold: 20,
        currentThreshold: 20,
        totalBeats: this.analysis?.beats.length ?? 0,
        allEdges: [],
      };
    }
    getVisualizationData() {
      return {
        beats: mockVizBeats ?? this.analysis?.beats ?? [],
        edges: mockVizEdges,
      };
    }
    getSectionStartBeatIndices() {
      return [];
    }
  },
}));

vi.mock("@forever-jukebox/shared/viz/JukeboxController", () => ({
  JukeboxController: class JukeboxController {
    private onEdgeSelect: ((edge: unknown) => void) | null = null;
    constructor(_layer: HTMLElement) {
      jukeboxControllerInstances.push(this);
    }
    setActiveIndex = vi.fn((_index: number) => undefined);
    setVisible = vi.fn((_visible: boolean) => undefined);
    setAnchorHighlightEnabled = vi.fn((_enabled: boolean) => undefined);
    setVisualPreferences = vi.fn((_prefs: unknown) => undefined);
    setPredictedJumps = vi.fn((_indices: readonly number[]) => undefined);
    resizeActive = vi.fn();
    refresh = vi.fn();
    reset = vi.fn();
    setData = vi.fn((_data: unknown) => undefined);
    setOnSelect = vi.fn((_handler: (index: number) => void) => undefined);
    setOnEdgeSelect(handler: (edge: unknown) => void) {
      this.onEdgeSelect = handler;
    }
    setSelectedEdge = vi.fn((_edge: unknown) => undefined);
    setSelectedEdgeActive = vi.fn((_edge: unknown) => undefined);
    setAnchorEdit = vi.fn((_state: unknown) => undefined);
    setOnAnchorEditChange = vi.fn((_handler: unknown) => undefined);
    setOnAnchorEditCommit = vi.fn((_handler: unknown) => undefined);
    update = vi.fn(
      (_index: number, _animate: boolean, _jumpFrom: number | null) => undefined,
    );
    destroy = vi.fn();
    getCount() {
      return 2;
    }
    emitEdgeSelect(edge: unknown) {
      this.onEdgeSelect?.(edge);
    }
  },
}));

vi.mock("@forever-jukebox/shared/autocanonizer/AutocanonizerController", () => ({
  AutocanonizerController: class AutocanonizerController {
    private onBeat:
      | ((
          index: number,
          beat: unknown,
          cursorTimes: { mainSeconds: number; otherSeconds: number },
        ) => void)
      | null = null;
    private onSelect: ((index: number) => void) | null = null;
    setFinishOutSong = vi.fn((_enabled: boolean) => undefined);
    planRender = vi.fn(() => ({ durationSeconds: 95, voices: [] }));
    constructor(_layer: HTMLElement) {
      autocanonizerInstances.push(this);
    }
    setVisible = vi.fn((_visible: boolean) => undefined);
    resizeNow = vi.fn();
    setOnBeat(
      handler:
        | ((
            index: number,
            beat: unknown,
            cursorTimes: { mainSeconds: number; otherSeconds: number },
          ) => void)
        | null,
    ) {
      this.onBeat = handler;
    }
    setOnEnded = vi.fn((_handler: (() => void) | null) => undefined);
    setOnSelect(handler: ((index: number) => void) | null) {
      this.onSelect = handler;
    }
    setVolume = vi.fn((_volume: number) => undefined);
    setStreamPans = vi.fn(
      (_mainPan: number, _otherPan: number) => undefined,
    );
    setQuadStreamPans = vi.fn();
    setDualAudio = vi.fn();
    setDualAnalysis = vi.fn();
    setStreamGains = vi.fn();
    setQuadStreamGains = vi.fn();
    setQuadMode = vi.fn();
    setQuadBranchMode = vi.fn();
    setDualAlignmentMode = vi.fn();
    getAudioBuffers = vi.fn(() => ({
      mainBuffer: { duration: 4 } as AudioBuffer,
      otherBuffer: null as AudioBuffer | null,
    }));
    setAudio = vi.fn(
      (_buffer: AudioBuffer | null, _context: AudioContext | null) => undefined,
    );
    setAnalysis = vi.fn(
      (_analysis: unknown, _durationOverride?: number | null) => undefined,
    );
    resetVisualization = vi.fn();
    isReady() {
      return true;
    }
    startAtIndex = vi.fn((index: number) => {
      this.onBeat?.(index, {}, { mainSeconds: index, otherSeconds: index });
    });
    emitBeat(
      index: number,
      cursorTimes: { mainSeconds: number; otherSeconds: number },
    ) {
      this.onBeat?.(index, {}, cursorTimes);
    }
    emitSelect(index: number) {
      this.onSelect?.(index);
    }
    stop = vi.fn();
    reset = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock("@forever-jukebox/shared/songsync/SongSyncController", () => ({
  SongSyncController: class SongSyncController {
    private meta: Array<Record<string, unknown>> = [];
    private masterTrackIndex = 0;
    setVisible = vi.fn();
    resizeNow = vi.fn();
    setLoop = vi.fn();
    setVolume = vi.fn();
    setOnBeat = vi.fn();
    setOnEnded = vi.fn();
    setOnSelect = vi.fn();
    setTracks = vi.fn(
      (
        inputs: Array<{ title: string; durationSec: number }>,
        _context: unknown,
        options?: { masterTrackIndex?: number },
      ) => {
        this.masterTrackIndex = options?.masterTrackIndex ?? 0;
        this.meta = inputs.map((input, idx) => ({
          trackIndex: idx,
          title: input.title,
          duration: input.durationSec,
          color: idx === 0 ? "#4cc9f0" : "#51cf66",
          beatCount: 8,
          gain: 1,
          pan: 0,
          muted: false,
          solo: false,
          beatOffset: 0,
          isMaster: idx === this.masterTrackIndex,
        }));
      },
    );
    setTrackConfig = vi.fn();
    getTrackMeta = vi.fn(() => this.meta);
    getMasterTrackIndex = vi.fn(() => this.masterTrackIndex);
    getCurrentIndex = vi.fn(() => 0);
    isReady = vi.fn(() => this.meta.length >= 2);
    start = vi.fn();
    startAtIndex = vi.fn();
    stop = vi.fn();
    resetVisualization = vi.fn();
    reset = vi.fn(() => {
      this.meta = [];
    });
    destroy = vi.fn();
  },
}));

// The pacing of the loading steps is not under test here; finish as soon as the work does.
vi.mock("@forever-jukebox/shared/ui/LoadingProgress", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<object>()),
    LoadingProgress: ({ finished, onFinished }: { finished: boolean; onFinished: () => void }) => {
      useEffect(() => {
        if (finished) {
          onFinished();
        }
      }, [finished, onFinished]);
      return null;
    },
  };
});

vi.mock("@/ui/components/SymbolIcon", () => ({
  SymbolIcon: ({ name, className }: { name: string; className?: string }) => (
    <span className={className}>{name}</span>
  ),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

type RenderedListen = {
  container: HTMLDivElement;
  rerender: () => void;
  unmount: () => void;
};

const activeRenderedListens = new Set<() => void>();

function renderListen(): RenderedListen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Listen />
      </MemoryRouter>
    );
  });
  let unmounted = false;
  const cleanupRoot = () => {
    if (unmounted) {
      return;
    }
    unmounted = true;
    activeRenderedListens.delete(cleanupRoot);
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  activeRenderedListens.add(cleanupRoot);
  return {
    container,
    rerender: () => {
      act(() => {
        root.render(
          <MemoryRouter
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <Listen />
          </MemoryRouter>
        );
      });
    },
    unmount: cleanupRoot,
  };
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function changeSelect(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeRange(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keydown(key: string, code?: string, repeat = false) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
        repeat,
        bubbles: true,
      })
    );
  });
}

async function keyup(key: string, code?: string) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key,
        code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
        bubbles: true,
      })
    );
  });
}

async function blurWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
}

async function hideDocument() {
  Object.defineProperty(document, "hidden", {
    value: true,
    configurable: true,
  });
  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    Reflect.deleteProperty(document, "hidden");
  }
}

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getRequired<T extends Element>(container: ParentNode, selector: string): T {
  const node = container.querySelector(selector);
  if (!node) {
    throw new Error(`Expected element not found: ${selector}`);
  }
  return node as T;
}

// Keeps the next analysis pending until the returned callback resolves it.
function holdNextAnalysis(): () => void {
  let finish: () => void = () => {};
  vi.spyOn(AnalyzeAudioUseCase.prototype, "execute").mockImplementationOnce(
    () =>
      new Promise<AnalyzeAudioResult>((resolve) => {
        finish = () =>
          resolve({
            analysis: mockAnalysis as unknown as AnalyzeAudioResult["analysis"],
            audioBuffer: {} as AudioBuffer,
            fingerprint: "fp-test",
            fromCache: false,
          });
      }),
  );
  return () => finish();
}

async function openTuningModal(container: ParentNode) {
  const tuningButton = getRequired<HTMLButtonElement>(container, "#tuning");
  await click(tuningButton);
}

describe("Listen route behavior", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    autocanonizerInstances.length = 0;
    wubMachineInstances.length = 0;
    wubMachineMocks.renderWubMachineBuffer.mockReset();
    wubMachineMocks.renderWubMachineBuffer.mockResolvedValue({
      buffer: { duration: 30 } as AudioBuffer,
      parts: [],
    });
    exportMocks.exportCanonizerAudio.mockReset();
    exportMocks.exportCanonizerAudio.mockResolvedValue({
      bytes: new Uint8Array([7, 8, 9]),
      extension: "mp3",
      mimeType: "audio/mpeg",
      renderedDurationSeconds: 95,
    });
    exportMocks.exportRenderedAudio.mockReset();
    exportMocks.exportRenderedAudio.mockResolvedValue({
      bytes: new Uint8Array([4, 5, 6]),
      extension: "mp3",
      mimeType: "audio/mpeg",
      renderedDurationSeconds: 30,
    });
    playerInstances.length = 0;
    jukeboxControllerInstances.length = 0;
    engineInstances.length = 0;
    mockVizEdges = [];
    mockVizBeats = null;
    mockAppState.file = new File([new Uint8Array([1, 2, 3])], "song.wav", {
      lastModified: 1234,
    });
    mockAppState.fileHandle = null;
    mockAppState.mixQueue = [];
    mockAppState.activeQueueIndex = -1;
    mockAppState.mixAddSticky = false;
    mockAppState.setMixAddSticky.mockReset();
    mockAppState.addFilesToMixQueue.mockReset();
    mockAppState.removeFromMixQueue.mockReset();
    mockAppState.moveMixQueueItem.mockReset();
    mockAppState.clearMixQueue.mockReset();
    mockAppState.selectMixQueueIndex.mockReset();
    mockAppState.updateMixQueueTrackMeta.mockReset();
    vi.mocked(setFileHandle).mockClear();
    mockAppState.setIsListenLoading.mockReset();
    mockAppState.isSettingsOpen = false;
    mockAppState.setIsSettingsOpen.mockReset();
    mockAppState.setIsSettingsOpen.mockImplementation((isOpen) => {
      mockAppState.isSettingsOpen = isOpen;
    });
    exportMocks.exportJukeboxAudio.mockReset();
    exportMocks.exportJukeboxAudio.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      extension: "mp3",
      mimeType: "audio/mpeg",
      renderedDurationSeconds: 60,
      beatsPlanned: 2,
      segments: [],
    });
    exportMocks.pickBinaryExportFile.mockReset();
    exportMocks.pickBinaryExportFile.mockResolvedValue(null);
    exportMocks.saveExportBinary.mockReset();
    exportMocks.saveExportBinary.mockResolvedValue(undefined);
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
    vi.spyOn(window, "setInterval").mockImplementation(
      ((() =>
        1 as unknown as ReturnType<typeof window.setInterval>) as unknown) as typeof window.setInterval
    );
    vi.spyOn(window, "clearInterval").mockImplementation(
      ((_id: ReturnType<typeof window.setInterval>) => undefined) as typeof window.clearInterval
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.mocked(getOrCreateSwingBuffer).mockImplementation(
      (
        _sourceBuffer: AudioBuffer,
        _sourceIdentity: string | null,
        render: () => Promise<AudioBuffer>,
      ) => render(),
    );
    vi.mocked(renderSwingBuffer).mockClear();
    vi.mocked(renderInstrumentalBuffer).mockClear();
    vi.mocked(renderSwingBuffer).mockResolvedValue({ duration: 4 } as AudioBuffer);
  });

  afterEach(() => {
    for (const cleanupRoot of [...activeRenderedListens]) {
      cleanupRoot();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stores the file's handle under its fingerprint once analyzed", async () => {
    const handle = { kind: "file", name: "song.wav" } as FileSystemFileHandle;
    mockAppState.fileHandle = handle;
    const rendered = renderListen();
    await settleEffects();

    expect(setFileHandle).toHaveBeenCalledWith("fp-test", handle);
    rendered.unmount();
  });

  it("stores no handle for a file opened without one", async () => {
    const rendered = renderListen();
    await settleEffects();

    expect(setFileHandle).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("switches between jukebox and autocanonizer UI modes", async () => {
    const rendered = renderListen();
    await settleEffects();

    const modeSelect = getRequired<HTMLSelectElement>(
      rendered.container,
      "#play-mode-select"
    );
    const tuningButton = getRequired<HTMLButtonElement>(
      rendered.container,
      "#tuning"
    );
    const infoButton = getRequired<HTMLButtonElement>(
      rendered.container,
      "#track-info"
    );
    const playTitle = rendered.container.querySelector(".play-title");

    expect(tuningButton.classList.contains("is-hidden")).toBe(false);
    expect(infoButton.classList.contains("is-hidden")).toBe(false);
    expect(playTitle?.textContent).toBe("song.wav");

    await changeSelect(modeSelect, "autocanonizer");

    expect(tuningButton.classList.contains("is-hidden")).toBe(false);
    expect(infoButton.classList.contains("is-hidden")).toBe(true);
    expect(playTitle?.textContent).toContain("(autocanonized)");
    const beatsLabelHidden = Array.from(
      rendered.container.querySelectorAll(".viz-meta span")
    ).some(
      (span) =>
        span.textContent === "Total Beats:" && span.classList.contains("is-hidden")
    );
    expect(beatsLabelHidden).toBe(true);
    const autocanonizer = autocanonizerInstances[0];
    await act(async () => {
      autocanonizer.emitBeat(1, {
        mainSeconds: 62,
        otherSeconds: 125,
      });
    });
    expect(
      getRequired(rendered.container, "#autocanonizer-main-time").textContent,
    ).toBe("1:02");
    expect(
      getRequired(rendered.container, "#autocanonizer-other-time").textContent,
    ).toBe("2:05");
    expect(
      getRequired(rendered.container, "#autocanonizer-total-time").textContent,
    ).toBe("0:04");

    await changeSelect(modeSelect, "jukebox");

    expect(tuningButton.classList.contains("is-hidden")).toBe(false);
    expect(infoButton.classList.contains("is-hidden")).toBe(false);
    expect(playTitle?.textContent).toBe("song.wav");
    await changeSelect(modeSelect, "autocanonizer");
    expect(
      getRequired(rendered.container, "#autocanonizer-main-time").textContent,
    ).toBe("0:00");
    expect(
      getRequired(rendered.container, "#autocanonizer-other-time").textContent,
    ).toBe("0:00");
    rendered.unmount();
  });

  it("renders the Wub Machine remix on mode switch and plays it", async () => {
    const rendered = renderListen();
    await settleEffects();
    const modeSelect = getRequired<HTMLSelectElement>(
      rendered.container,
      "#play-mode-select",
    );
    const playButton = getRequired<HTMLButtonElement>(rendered.container, "#viz-play");

    await changeSelect(modeSelect, "wubmachine");
    await settleEffects();

    expect(wubMachineMocks.renderWubMachineBuffer).toHaveBeenCalledTimes(1);
    expect(wubMachineMocks.renderWubMachineBuffer.mock.calls[0]?.[3]).toMatchObject({
      trackId: "fp-test",
    });
    const wubmachine = wubMachineInstances[0];
    expect(wubmachine.setRemix).toHaveBeenCalledWith(
      { duration: 30 },
      expect.anything(),
      [],
    );
    expect(
      getRequired(rendered.container, "#wubmachine-total-time").textContent,
    ).toBe("0:30");
    expect(
      getRequired(rendered.container, "#tuning").classList.contains("is-hidden"),
    ).toBe(true);
    expect(
      getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export")
        .disabled,
    ).toBe(false);
    expect(rendered.container.querySelector(".play-title")?.textContent).toContain(
      "(wub machine remix)",
    );

    await click(playButton);
    expect(wubmachine.play).toHaveBeenLastCalledWith(undefined);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");
    await act(async () => {
      wubmachine.emitTick(75.6);
    });
    expect(
      getRequired(rendered.container, "#wubmachine-time").textContent,
    ).toBe("1:15");

    await act(async () => {
      wubmachine.emitSelect(12);
    });
    expect(wubmachine.play).toHaveBeenLastCalledWith(12);

    await click(playButton);
    expect(wubmachine.pause).toHaveBeenCalledTimes(1);
    expect(playButton.getAttribute("aria-label")).toBe("Resume");

    await act(async () => {
      wubmachine.emitEnded();
    });
    // Ended while paused is ignored; resume, then end the track.
    expect(playButton.getAttribute("aria-label")).toBe("Resume");
    await click(playButton);
    await act(async () => {
      wubmachine.emitEnded();
    });
    expect(playButton.getAttribute("aria-label")).toBe("Play");

    // Switching back and forth reuses the remix instead of re-rendering.
    await changeSelect(modeSelect, "jukebox");
    await changeSelect(modeSelect, "wubmachine");
    await settleEffects();
    expect(wubMachineMocks.renderWubMachineBuffer).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("persists the Wub Machine loop preference", async () => {
    window.localStorage.setItem("fj-wub-machine-loop", "true");
    const rendered = renderListen();
    await settleEffects();
    const loop = getRequired<HTMLInputElement>(rendered.container, "#wubmachine-loop");
    expect(loop.checked).toBe(true);
    expect(wubMachineInstances[0].setLoop).toHaveBeenLastCalledWith(true);

    await click(loop);
    expect(loop.checked).toBe(false);
    expect(window.localStorage.getItem("fj-wub-machine-loop")).toBe("false");
    expect(wubMachineInstances[0].setLoop).toHaveBeenLastCalledWith(false);
    rendered.unmount();
  });

  it("reports a failed Wub Machine render and retries from play", async () => {
    wubMachineMocks.renderWubMachineBuffer.mockRejectedValueOnce(
      new Error("no samples"),
    );
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "wubmachine",
    );
    await settleEffects();
    expect(rendered.container.textContent).toContain("Wub Machine remix failed");
    expect(wubMachineInstances[0].setRemix).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    await click(getRequired<HTMLButtonElement>(rendered.container, "#viz-play"));
    await settleEffects();
    expect(wubMachineMocks.renderWubMachineBuffer).toHaveBeenCalledTimes(2);
    expect(wubMachineInstances[0].setRemix).toHaveBeenLastCalledWith(
      { duration: 30 },
      expect.anything(),
      [],
    );
    rendered.unmount();
  });

  it("exports the whole Wub Machine remix, afresh for WAV when stored", async () => {
    const storedRemix = { duration: 30 } as AudioBuffer;
    markStoredCopy(storedRemix);
    wubMachineMocks.renderWubMachineBuffer.mockResolvedValue({
      buffer: storedRemix,
      parts: [],
    });
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "wubmachine",
    );
    await settleEffects();

    const exportWith = async (format: string) => {
      wubMachineMocks.renderWubMachineBuffer.mockClear();
      await click(getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export"));
      expect(rendered.container.textContent).toContain("Remix length:");
      expect(rendered.container.querySelector('input[type="number"]')).toBeNull();
      const formatSelect = Array.from(
        rendered.container.querySelectorAll<HTMLSelectElement>("select"),
      ).find((select) => select.querySelector('option[value="wav"]'));
      if (!formatSelect) {
        throw new Error("Expected export format select");
      }
      await changeSelect(formatSelect, format);
      await click(
        getRequired<HTMLButtonElement>(
          rendered.container,
          ".modal-footer .tab-btn:last-child",
        ),
      );
      await settleEffects();
    };

    await exportWith("mp3");
    expect(wubMachineMocks.renderWubMachineBuffer).not.toHaveBeenCalled();
    expect(exportMocks.exportJukeboxAudio).not.toHaveBeenCalled();
    expect(exportMocks.exportRenderedAudio).toHaveBeenLastCalledWith(
      expect.objectContaining({ buffer: storedRemix, format: "mp3", gain: 1 }),
    );
    expect(exportMocks.saveExportBinary.mock.calls.at(-1)?.[0]).toBe("song_wub.mp3");

    await exportWith("wav");
    expect(wubMachineMocks.renderWubMachineBuffer).toHaveBeenCalledTimes(1);
    expect(wubMachineMocks.renderWubMachineBuffer.mock.calls[0]?.[3]).toMatchObject({
      trackId: null,
    });
    expect(exportMocks.exportRenderedAudio).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "wav" }),
    );
    rendered.unmount();
  });

  it("exports the whole canon in autocanonizer mode", async () => {
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "autocanonizer",
    );
    await settleEffects();
    const plan = { durationSeconds: 95, voices: [] };
    autocanonizerInstances[0].planRender.mockReturnValue(plan);

    const exportButton = getRequired<HTMLButtonElement>(
      rendered.container,
      "#track-audio-export",
    );
    expect(exportButton.disabled).toBe(false);
    expect(exportButton.classList.contains("is-hidden")).toBe(false);
    await click(exportButton);
    expect(rendered.container.textContent).toContain("00:01:35");
    expect(rendered.container.querySelector('input[type="number"]')).toBeNull();
    await click(
      getRequired<HTMLButtonElement>(
        rendered.container,
        ".modal-footer .tab-btn:last-child",
      ),
    );
    await settleEffects();

    expect(exportMocks.exportCanonizerAudio).toHaveBeenLastCalledWith(
      expect.objectContaining({ plan, format: "mp3", gain: 1 }),
    );
    expect(exportMocks.exportJukeboxAudio).not.toHaveBeenCalled();
    expect(exportMocks.exportRenderedAudio).not.toHaveBeenCalled();
    expect(exportMocks.saveExportBinary.mock.calls.at(-1)?.[0]).toBe("song_canon.mp3");
    rendered.unmount();
  });

  it("keeps volume as master volume in autocanonizer mode", async () => {
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "autocanonizer",
    );
    await click(getRequired(rendered.container, "#volume-button"));

    const volumeSlider = getRequired<HTMLInputElement>(
      rendered.container,
      "input[aria-label='Volume']",
    );
    expect(volumeSlider.value).toBe("100");
    await changeRange(volumeSlider, "70");
    expect(autocanonizerInstances[0].setVolume).toHaveBeenLastCalledWith(0.7);
    rendered.unmount();
  });

  it("restores and persists the stored volume", async () => {
    window.localStorage.setItem("fj-volume", "40");
    const rendered = renderListen();
    await settleEffects();
    expect(playerInstances[0].getVolume()).toBe(0.4);
    expect(autocanonizerInstances[0].setVolume).toHaveBeenLastCalledWith(0.4);
    expect(wubMachineInstances[0].setVolume).toHaveBeenLastCalledWith(0.4);
    await click(getRequired(rendered.container, "#volume-button"));

    const volumeSlider = getRequired<HTMLInputElement>(
      rendered.container,
      "input[aria-label='Volume']",
    );
    expect(volumeSlider.value).toBe("40");
    const icon = getRequired(rendered.container, "#volume-button .volume-icon");
    expect(icon.textContent).toBe("volume_up");
    await changeRange(volumeSlider, "0");
    expect(window.localStorage.getItem("fj-volume")).toBe("0");
    expect(icon.textContent).toBe("volume_off");
    rendered.unmount();
  });

  it("shows independent autocanonizer stream pans in the pan popover", async () => {
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "autocanonizer",
    );
    await click(getRequired(rendered.container, "#autocanonizer-pan-button"));

    const mainSlider = getRequired<HTMLInputElement>(
      rendered.container,
      "#autocanonizer-main-pan",
    );
    const otherSlider = getRequired<HTMLInputElement>(
      rendered.container,
      "#autocanonizer-other-pan",
    );
    expect(mainSlider.value).toBe("0");
    expect(otherSlider.value).toBe("0");

    await changeRange(mainSlider, "-40");

    expect(autocanonizerInstances[0].setStreamPans).toHaveBeenLastCalledWith(
      -0.4,
      0,
    );
    expect(mainSlider.value).toBe("-40");
    rendered.unmount();
  });

  it("renames the beats counter in cowbell mode", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(
      getRequired<HTMLInputElement>(rendered.container, "#audio-mode-cowbell")
    );

    expect(rendered.container.textContent).toContain("Total Cowbells:");
    rendered.unmount();
  });

  it("loads and persists finish-out-song preference", async () => {
    window.localStorage.setItem("fj-canonizer-finish", "true");
    const rendered = renderListen();
    await settleEffects();

    const instance = autocanonizerInstances[0];
    expect(instance.setFinishOutSong).toHaveBeenCalledWith(true);

    const checkbox = rendered.container.querySelector(
      "#canonizer-finish"
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await click(checkbox);

    expect(window.localStorage.getItem("fj-canonizer-finish")).toBe("false");
    expect(instance.setFinishOutSong).toHaveBeenLastCalledWith(false);
    rendered.unmount();
  });

  it("moves the sleep timer from tuning into global settings", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const headerActions = getRequired<HTMLDivElement>(
      rendered.container,
      ".modal-header-actions",
    );
    const closeButton = getRequired<HTMLButtonElement>(
      headerActions,
      ".modal-close",
    );
    expect(Array.from(headerActions.children)).toEqual([closeButton]);
    expect(headerActions.querySelector("#sleep-timer-open")).toBeNull();

    mockAppState.isSettingsOpen = true;
    rendered.rerender();
    await settleEffects();
    const sleepTimerModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    expect(sleepTimerModal.parentElement).toBe(document.body);
    const sleepTimerCurrent = getRequired<HTMLDivElement>(
      sleepTimerModal,
      "#sleep-timer-current",
    );
    const sleepTimerSelect = getRequired<HTMLSelectElement>(
      sleepTimerModal,
      "#sleep-timer-select",
    );
    expect(sleepTimerCurrent.textContent).toBe("Off");

    await changeSelect(sleepTimerSelect, "900000");
    await click(getRequired<HTMLButtonElement>(sleepTimerModal, "#settings-close"));
    rendered.rerender();
    expect(document.body.querySelector("#settings-modal")).toBe(null);

    mockAppState.isSettingsOpen = true;
    rendered.rerender();
    await settleEffects();
    const reopenedModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    const reopenedSelect = getRequired<HTMLSelectElement>(
      reopenedModal,
      "#sleep-timer-select",
    );
    expect(reopenedSelect.value).toBe("off");

    await changeSelect(reopenedSelect, "900000");
    await click(getRequired<HTMLButtonElement>(reopenedModal, "#sleep-timer-set"));
    rendered.rerender();
    expect(document.body.querySelector("#settings-modal")).toBe(null);

    mockAppState.isSettingsOpen = true;
    rendered.rerender();
    await settleEffects();
    const appliedModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    expect(
      getRequired<HTMLSelectElement>(appliedModal, "#sleep-timer-select").value,
    ).toBe("900000");
    expect(
      getRequired<HTMLDivElement>(appliedModal, "#sleep-timer-current").textContent,
    ).toBe("Current countdown: 00:15:00");
    rendered.unmount();
  });

  it("keeps settings available without a loaded file", async () => {
    mockAppState.file = null;
    mockAppState.isSettingsOpen = true;
    const rendered = renderListen();
    await settleEffects();

    const settingsModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    expect(settingsModal.textContent).toContain("Settings");
    expect(
      getRequired<HTMLSelectElement>(settingsModal, "#settings-language").value,
    ).toBe("en");
    await click(
      getRequired<HTMLButtonElement>(settingsModal, ".modal-backdrop"),
    );
    rendered.rerender();
    expect(document.body.querySelector("#settings-modal")).toBeNull();
    rendered.unmount();
  });

  it("clears the analysis cache from settings", async () => {
    const cache = await import("@/core/infrastructure/cache/analysisCache");
    mockAppState.isSettingsOpen = true;
    const rendered = renderListen();
    await settleEffects();

    const settingsModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    const clearButton = getRequired<HTMLButtonElement>(
      settingsModal,
      "#cached-analysis-clear",
    );
    expect(clearButton.textContent).toBe("Clear 12.5MB");
    expect(clearButton.disabled).toBe(false);
    await click(clearButton);
    await settleEffects();
    expect(cache.clearAllAnalysisCache).toHaveBeenCalled();
    rendered.unmount();
  });

  it("associates the timer label with the select", async () => {
    const rendered = renderListen();
    await settleEffects();
    mockAppState.isSettingsOpen = true;
    rendered.rerender();

    const settingsModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    const timerLabel = getRequired<HTMLLabelElement>(
      settingsModal,
      'label[for="sleep-timer-select"]',
    );
    expect(timerLabel.control).toBe(
      getRequired<HTMLSelectElement>(settingsModal, "#sleep-timer-select"),
    );
    rendered.unmount();
  });

  it("applies and persists theme changes immediately", async () => {
    const rendered = renderListen();
    await settleEffects();
    mockAppState.isSettingsOpen = true;
    rendered.rerender();

    const lightTheme = getRequired<HTMLInputElement>(
      document.body,
      'input[name="settings-theme"][value="light"]',
    );
    await click(lightTheme);

    expect(window.localStorage.getItem("fj-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(jukeboxControllerInstances[0]?.refresh).toHaveBeenCalled();
    rendered.unmount();
  });

  it("expires the sleep timer through the playback stop path", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const rendered = renderListen();
    await settleEffects();

    mockAppState.isSettingsOpen = true;
    rendered.rerender();
    await settleEffects();
    const sleepTimerModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    await changeSelect(
      getRequired<HTMLSelectElement>(sleepTimerModal, "#sleep-timer-select"),
      "900000",
    );
    await click(getRequired<HTMLButtonElement>(sleepTimerModal, "#sleep-timer-set"));

    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    engine.stopJukebox.mockClear();

    await act(async () => {
      nowMs = 900000;
      vi.advanceTimersByTime(1000);
    });

    expect(engine.stopJukebox).toHaveBeenCalledTimes(1);
    mockAppState.isSettingsOpen = true;
    rendered.rerender();
    await settleEffects();
    const expiredModal = getRequired<HTMLDivElement>(
      document.body,
      "#settings-modal",
    );
    expect(
      getRequired<HTMLDivElement>(expiredModal, "#sleep-timer-current").textContent,
    ).toBe("Off");
    rendered.unmount();
  });

  it("supports play, pause, and resume controls", async () => {
    const rendered = renderListen();
    await settleEffects();

    const playButton = getRequired<HTMLButtonElement>(rendered.container, "#viz-play");

    expect(playButton.getAttribute("aria-label")).toBe("Play");

    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Resume");

    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    rendered.unmount();
  });

  it("keeps listen time running when selecting an autocanonizer beat", async () => {
    let nowMs = 1000;
    let listenTimer: (() => void) | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.mocked(window.setInterval).mockImplementation(
      ((callback: TimerHandler) => {
        if (typeof callback === "function") {
          listenTimer = () => callback();
        }
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      }) as unknown as typeof window.setInterval,
    );
    const rendered = renderListen();
    await settleEffects();
    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
      "autocanonizer",
    );
    await click(getRequired<HTMLButtonElement>(rendered.container, "#viz-play"));

    nowMs = 6000;
    await act(async () => {
      listenTimer?.();
    });
    expect(
      getRequired(rendered.container, ".viz-meta-stats span:nth-child(2)")
        .textContent,
    ).toBe("00:00:05");

    await act(async () => {
      autocanonizerInstances[0]?.emitSelect(1);
    });
    nowMs = 7000;
    await act(async () => {
      listenTimer?.();
    });

    expect(autocanonizerInstances[0]?.startAtIndex).toHaveBeenLastCalledWith(1);
    expect(
      getRequired(rendered.container, ".viz-meta-stats span:nth-child(2)")
        .textContent,
    ).toBe("00:00:06");
    rendered.unmount();
  });

  it("draws the promoted jump target before moving a caught-up cursor", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    const jukebox = jukeboxControllerInstances[0];
    jukebox?.update.mockClear();

    await act(async () => {
      engine?.emitUpdate({
        beatsPlayed: 12,
        currentBeatIndex: 2,
        lastJumped: true,
        lastJumpFromIndex: 1,
        lastJumpToIndex: 0,
      });
    });

    expect(jukebox?.update).toHaveBeenNthCalledWith(1, 0, true, 1);
    expect(jukebox?.update).toHaveBeenNthCalledWith(2, 2, false, 0);
    rendered.unmount();
  });

  it("moves the cursor without highlighting a transport-only jump", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    const jukebox = jukeboxControllerInstances[0];
    engine?.getLastJumpWasBranch.mockReturnValue(false);
    jukebox?.update.mockClear();

    await act(async () => {
      engine?.emitUpdate({
        beatsPlayed: 12,
        currentBeatIndex: 2,
        lastJumped: true,
        lastJumpFromIndex: 1,
        lastJumpToIndex: 0,
      });
    });

    expect(jukebox?.update).toHaveBeenCalledTimes(1);
    expect(jukebox?.update.mock.calls[0]?.[0]).toBe(2);
    expect(jukebox?.update.mock.calls[0]?.[1]).toBe(false);
    rendered.unmount();
  });

  it("updates beat and listen counters in the DOM without a React commit", async () => {
    let nowMs = 1000;
    let listenTimer: (() => void) | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.mocked(window.setInterval).mockImplementation(
      ((callback: TimerHandler) => {
        if (typeof callback === "function") {
          listenTimer = () => callback();
        }
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      }) as unknown as typeof window.setInterval,
    );
    let commits = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <Profiler id="listen" onRender={() => (commits += 1)}>
          <MemoryRouter
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <Listen />
          </MemoryRouter>
        </Profiler>,
      );
    });
    await settleEffects();
    await click(getRequired<HTMLButtonElement>(container, "#viz-play"));
    const listenTime = getRequired(container, ".viz-meta-stats span:nth-child(2)");
    const beatsPlayed = getRequired(container, ".viz-meta-stats span:nth-child(5)");
    expect(listenTime.textContent).toBe("00:00:00");
    expect(beatsPlayed.textContent).toBe("0");

    commits = 0;
    nowMs = 6000;
    await act(async () => {
      engineInstances[0]?.emitUpdate({ beatsPlayed: 12, currentBeatIndex: 2 });
      listenTimer?.();
    });

    expect(beatsPlayed.textContent).toBe("12");
    expect(listenTime.textContent).toBe("00:00:05");
    expect(commits).toBe(0);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps jukebox running when audio ended fires during normal looping", async () => {
    const rendered = renderListen();
    await settleEffects();

    const playButton = getRequired<HTMLButtonElement>(rendered.container, "#viz-play");
    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    const player = playerInstances[0];
    if (!player) {
      throw new Error("Expected buffered player instance");
    }
    await act(async () => {
      player.emitEnded();
    });

    expect(playButton.getAttribute("aria-label")).toBe("Pause");
    rendered.unmount();
  });

  it("shows export modal with 2-hour max and compressed mp3 label", async () => {
    const rendered = renderListen();
    await settleEffects();

    const exportButton = getRequired<HTMLButtonElement>(
      rendered.container,
      "#track-audio-export"
    );
    await click(exportButton);

    const durationInput = getRequired<HTMLInputElement>(
      rendered.container,
      '.export-body input[type=\"number\"]'
    );
    expect(durationInput.max).toBe("7200");

    const formatSelect = getRequired<HTMLSelectElement>(
      rendered.container,
      ".export-body select"
    );
    const mp3Option = Array.from(formatSelect.options).find(
      (option) => option.value === "mp3"
    );
    expect(mp3Option?.textContent).toBe("MP3 (compressed)");
    expect(rendered.container.textContent).not.toContain(
      "Match Current Playback Exactly"
    );

    rendered.unmount();
  });

  it("passes the active extras audio mode to jukebox export", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-daycore"));

    await click(getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export"));
    await click(
      getRequired<HTMLButtonElement>(
        rendered.container,
        ".modal-footer .tab-btn:last-child",
      ),
    );
    await settleEffects();

    expect(exportMocks.exportJukeboxAudio).toHaveBeenCalledTimes(1);
    expect(exportMocks.exportJukeboxAudio.mock.calls[0]?.[0]).toMatchObject({
      audioMode: "daycore",
      sectionStartBeatIndices: [],
      userAnchorEdge: null,
    });
    rendered.unmount();
  });

  it("renders swing afresh for a WAV export and from the store for MP3", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-swing"));
    await settleEffects();

    const exportWith = async (format: string) => {
      vi.mocked(renderSwingBuffer).mockClear();
      await click(getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export"));
      const formatSelect = Array.from(
        rendered.container.querySelectorAll<HTMLSelectElement>("select"),
      ).find((select) => select.querySelector('option[value="wav"]'));
      if (!formatSelect) {
        throw new Error("Expected export format select");
      }
      await changeSelect(formatSelect, format);
      await click(
        getRequired<HTMLButtonElement>(
          rendered.container,
          ".modal-footer .tab-btn:last-child",
        ),
      );
      await settleEffects();
      return vi.mocked(renderSwingBuffer).mock.calls.at(-1)?.[2];
    };

    expect(await exportWith("wav")).toMatchObject({ trackId: null });
    expect(await exportWith("mp3")).toMatchObject({ trackId: "fp-test" });
    rendered.unmount();
  });

  it("applies extras settings live and updates title/url", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const titleText = getRequired<HTMLSpanElement>(
      rendered.container,
      "#tuning-title-text"
    );
    expect(titleText.textContent).toBe("Tuning");
    expect(rendered.container.querySelector("#tuning-tab-toggle")).toBeNull();
    expect(rendered.container.querySelector("#tuning-panel-tuning")).not.toBeNull();
    expect(rendered.container.querySelector("#tuning-panel-visuals")).not.toBeNull();
    expect(rendered.container.querySelector("#tuning-panel-extras")).not.toBeNull();
    expect(rendered.container.querySelector("#tuning-panel-advanced")).not.toBeNull();

    const branchStatsInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#extras-enabled"
    );
    await click(branchStatsInput);
    const bringHomeInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#bring-home-enabled"
    );
    await click(bringHomeInput);
    const daycoreInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-mode-daycore"
    );
    await click(daycoreInput);

    expect(window.localStorage.getItem("fj-branch-stats-enabled")).toBe("1");
    const playTitle = getRequired<HTMLDivElement>(rendered.container, ".play-title");
    expect(playTitle.textContent).toContain("(daycore)");
    expect(rendered.container.textContent).toContain("Bringing it on home");
    expect(window.location.search).toContain("am=daycore");
    rendered.unmount();
  });

  it("shows the intensity slider only for supported playback styles and applies it", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    expect(rendered.container.querySelector("#audio-intensity")).toBeNull();

    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-lofi"));
    expect(rendered.container.querySelector("#audio-intensity")).toBeNull();

    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-nightcore"));
    const slider = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-intensity",
    );
    await changeRange(slider, "130");

    expect(window.location.search).toContain("am=nightcore");
    expect(window.location.search).toContain("ai=130");
    const player = playerInstances.at(-1) as unknown as {
      setJukeboxAudioMode: ReturnType<typeof vi.fn>;
    };
    expect(player.setJukeboxAudioMode).toHaveBeenCalledWith("nightcore", 130);
    rendered.unmount();
  });

  it("passes the audio intensity to jukebox export", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-nightcore"));
    await changeRange(
      getRequired<HTMLInputElement>(rendered.container, "#audio-intensity"),
      "150",
    );

    await click(getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export"));
    await click(
      getRequired<HTMLButtonElement>(
        rendered.container,
        ".modal-footer .tab-btn:last-child",
      ),
    );
    await settleEffects();

    expect(exportMocks.exportJukeboxAudio.mock.calls[0]?.[0]).toMatchObject({
      audioMode: "nightcore",
      audioIntensityPct: 150,
    });
    rendered.unmount();
  });

  it("resumes jukebox playback after preparing swing while already running", async () => {
    const rendered = renderListen();
    await settleEffects();

    const playButton = getRequired<HTMLButtonElement>(rendered.container, "#viz-play");
    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-swing"));
    await settleEffects();

    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    expect(engine.pauseJukebox).toHaveBeenCalledTimes(1);
    expect(engine.startJukebox).toHaveBeenLastCalledWith(false);
    expect(engine.play).toHaveBeenCalledTimes(2);
    // Stored by analysis fingerprint so cached-analysis removal covers it.
    expect(vi.mocked(renderSwingBuffer).mock.calls.at(-1)?.[2]).toMatchObject({
      trackId: "fp-test",
    });
    // Loading a track trims stored renders to the cap, sparing its own.
    const cache = await import("@/core/infrastructure/cache/analysisCache");
    expect(cache.trimRenderedTracks).toHaveBeenCalledWith("fp-test");
    expect(playButton.getAttribute("aria-label")).toBe("Pause");
    expect(window.location.search).toContain("am=swing");
    rendered.unmount();
  });

  it("prepares instrumental mode, swaps the rendered buffer in and resumes", async () => {
    const rendered = renderListen();
    await settleEffects();

    const playButton = getRequired<HTMLButtonElement>(rendered.container, "#viz-play");
    await click(playButton);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-instrumental"));
    await settleEffects();

    const player = playerInstances.at(-1) as unknown as {
      setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
      setJukeboxAudioMode: ReturnType<typeof vi.fn>;
    };
    expect(vi.mocked(renderInstrumentalBuffer)).toHaveBeenCalledTimes(1);
    // Stored by analysis fingerprint so cached-analysis removal covers it.
    expect(vi.mocked(renderInstrumentalBuffer).mock.calls[0]?.[1]).toBe("fp-test");
    expect(player.setRenderedJukeboxAudioBuffer).toHaveBeenCalledWith(
      "instrumental",
      { duration: 4 },
    );
    expect(player.setJukeboxAudioMode).toHaveBeenLastCalledWith("instrumental");
    const engine = engineInstances[0];
    expect(engine?.pauseJukebox).toHaveBeenCalledTimes(1);
    expect(engine?.startJukebox).toHaveBeenLastCalledWith(false);
    expect(playButton.getAttribute("aria-label")).toBe("Pause");
    expect(window.location.search).toContain("am=instrumental");
    rendered.unmount();
  });

  it("returns to normal mode when the instrumental render fails", async () => {
    vi.mocked(renderInstrumentalBuffer).mockRejectedValueOnce(new Error("no gpu"));
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-instrumental"));
    await settleEffects();

    const player = playerInstances.at(-1) as unknown as {
      setJukeboxAudioMode: ReturnType<typeof vi.fn>;
    };
    expect(player.setJukeboxAudioMode).toHaveBeenLastCalledWith("off", 100);
    expect(window.location.search).not.toContain("am=");
    rendered.unmount();
  });

  it("cancels an instrumental render when another mode is applied", async () => {
    vi.mocked(renderInstrumentalBuffer).mockImplementationOnce(
      () => new Promise<AudioBuffer>(() => {}),
    );
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-instrumental"));
    await settleEffects();
    expect(getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute("aria-label")).toBe(
      "Preparing Instrumental mode",
    );

    // Close and reopen via E while preparing, then select another mode.
    await click(getRequired<HTMLButtonElement>(rendered.container, "#tuning-close"));
    await keydown("e", "KeyE");
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-nightcore"));
    await settleEffects();

    expect(vi.mocked(cancelInstrumentalRender)).toHaveBeenCalled();
    expect(getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute("aria-label")).toBe(
      "Play",
    );
    rendered.unmount();
  });

  it("hides the instrumental option where the renderer does not allow it", async () => {
    vi.mocked(isInstrumentalModeAvailable).mockReturnValue(false);
    const rendered = renderListen();
    await settleEffects();
    await openTuningModal(rendered.container);
    expect(rendered.container.querySelector("#audio-mode-instrumental")).toBeNull();
    expect(rendered.container.querySelector("#audio-mode-swing")).not.toBeNull();
    rendered.unmount();
    vi.mocked(isInstrumentalModeAvailable).mockReturnValue(true);
  });

  it("resets audio mode and intensity together when swing render fails", async () => {
    vi.mocked(renderSwingBuffer).mockRejectedValueOnce(new Error("render failed"));
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-nightcore"));
    await changeRange(
      getRequired<HTMLInputElement>(rendered.container, "#audio-intensity"),
      "150",
    );
    expect(window.location.search).toContain("ai=150");

    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-swing"));
    await settleEffects();

    const player = playerInstances.at(-1) as unknown as {
      setJukeboxAudioMode: ReturnType<typeof vi.fn>;
    };
    expect(player.setJukeboxAudioMode).toHaveBeenLastCalledWith("off", 100);
    expect(window.location.search).not.toContain("am=");
    expect(window.location.search).not.toContain("ai=");

    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-nightcore"));
    const slider = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-intensity",
    );
    expect(slider.value).toBe("100");
    rendered.unmount();
  });

  it.each(["swing", "instrumental"] as const)(
    "prepares %s from the url once the track is analyzed",
    async (mode) => {
      window.history.replaceState({}, "", `/?am=${mode}`);
      const rendered = renderListen();
      await settleEffects();

      const render =
        mode === "swing" ? renderSwingBuffer : renderInstrumentalBuffer;
      expect(vi.mocked(render)).toHaveBeenCalled();
      const player = playerInstances.at(-1) as unknown as {
        setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
      };
      expect(player.setRenderedJukeboxAudioBuffer).toHaveBeenCalledWith(mode, {
        duration: 4,
      });
      expect(
        getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute(
          "aria-label",
        ),
      ).toBe("Play");
      rendered.unmount();
    },
  );

  it("blocks play with a toast while instrumental is preparing", async () => {
    vi.mocked(renderInstrumentalBuffer).mockImplementationOnce(
      () => new Promise<AudioBuffer>(() => {}),
    );
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-instrumental"));
    await settleEffects();
    (document.activeElement as HTMLElement | null)?.blur?.();

    await keydown(" ", "Space");
    expect(rendered.container.textContent).toContain("Preparing Instrumental mode...");
    expect(engineInstances[0]?.play).not.toHaveBeenCalled();
    expect(getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute("aria-label")).toBe(
      "Preparing Instrumental mode",
    );
    rendered.unmount();
  });

  it("drops an instrumental render that finishes after a track change", async () => {
    let finishRender: (buffer: AudioBuffer) => void = () => {};
    vi.mocked(renderInstrumentalBuffer).mockImplementationOnce(
      () =>
        new Promise<AudioBuffer>((resolve) => {
          finishRender = resolve;
        }),
    );
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-instrumental"));
    await settleEffects();
    vi.mocked(cancelInstrumentalRender).mockClear();

    mockAppState.file = new File([new Uint8Array([9, 9, 9])], "song-two.wav", {
      lastModified: 9999,
    });
    rendered.rerender();
    await settleEffects();
    expect(vi.mocked(cancelInstrumentalRender)).toHaveBeenCalled();

    const staleBuffer = { duration: 1 } as AudioBuffer;
    await act(async () => {
      finishRender(staleBuffer);
    });
    await settleEffects();

    const player = playerInstances.at(-1) as unknown as {
      setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
    };
    expect(player.setRenderedJukeboxAudioBuffer).not.toHaveBeenCalledWith(
      "instrumental",
      staleBuffer,
    );
    expect(getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute("aria-label")).toBe(
      "Play",
    );
    rendered.unmount();
  });

  it("opens inline tuning panel with E keyboard shortcut", async () => {
    const rendered = renderListen();
    await settleEffects();

    await keydown("e", "KeyE");

    const titleText = getRequired<HTMLSpanElement>(
      rendered.container,
      "#tuning-title-text"
    );
    expect(titleText.textContent).toBe("Tuning");
    const tuningPanel = getRequired<HTMLDivElement>(
      rendered.container,
      "#tuning-panel-tuning"
    );
    const extrasPanel = getRequired<HTMLDivElement>(
      rendered.container,
      "#tuning-panel-extras"
    );
    expect(tuningPanel.classList.contains("hidden")).toBe(false);
    expect(extrasPanel.classList.contains("hidden")).toBe(false);
    rendered.unmount();
  });

  it("adjusts play velocity with brackets, Down, and Up", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }

    await keydown("]", "BracketRight", true);
    await keydown("[", "BracketLeft");
    await keydown("ArrowDown");
    await keydown("ArrowUp");

    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(1, 2);
    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(2, 1);
    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(3, 0);
    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(4, 1);
    expect(rendered.container.textContent).toContain("Play velocity: +1");
    rendered.unmount();
  });

  it("adjusts play velocity via physical bracket positions on non-US layouts", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }

    // Latin American layout: the physical bracket keys produce ´ (dead) and +
    await keydown("Dead", "BracketRight");
    await keydown("´", "BracketLeft");

    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(1, 2);
    expect(engine.setPlayVelocity).toHaveBeenNthCalledWith(2, 1);
    rendered.unmount();
  });

  it("reports the capped play velocity", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    engine.setPlayVelocity(16);
    engine.setPlayVelocity.mockClear();

    await keydown("]", "BracketRight");

    expect(engine.setPlayVelocity).toHaveBeenCalledWith(17);
    expect(engine.getPlayVelocity()).toBe(16);
    expect(rendered.container.textContent).toContain("Play velocity: +16");
    rendered.unmount();
  });

  it("holds Control to freeze and clears it on keyup, blur, and cleanup", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    engine.setFreezeCurrentBeat.mockClear();

    await keydown("Control");
    await keyup("Control");
    await keydown("Control");
    await blurWindow();

    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(1, true);
    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(2, false);
    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(3, true);
    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(4, false);

    rendered.unmount();
    expect(engine.setFreezeCurrentBeat).toHaveBeenLastCalledWith(false);
    expect(engine.setForceBranch).toHaveBeenLastCalledWith(false);
  });

  it("clears freeze and force-branch when the tab is hidden", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    engine.setFreezeCurrentBeat.mockClear();
    engine.setForceBranch.mockClear();

    await keydown("Control");
    await hideDocument();

    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(1, true);
    expect(engine.setFreezeCurrentBeat).toHaveBeenNthCalledWith(2, false);
    expect(engine.setForceBranch).toHaveBeenLastCalledWith(false);
    rendered.unmount();
  });

  it("keeps Left and Right assigned to selected branch cycling", async () => {
    const rendered = renderListen();
    await settleEffects();
    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    const edges = [
      {
        id: 1,
        deleted: false,
        src: { start: 1, which: 1 },
        dest: { start: 0, which: 0 },
        distance: 8,
      },
      {
        id: 2,
        deleted: false,
        src: { start: 2, which: 2 },
        dest: { start: 0, which: 0 },
        distance: 8,
      },
    ];
    vi.spyOn(engine, "getVisualizationData").mockReturnValue({
      beats: mockAnalysis.beats,
      edges,
    });
    await act(async () => {
      controller.emitEdgeSelect(edges[0]);
    });

    await keydown("ArrowRight");

    expect(controller.setSelectedEdgeActive).toHaveBeenLastCalledWith(edges[1]);
    expect(engine.setPlayVelocity).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("sets and clears the selected backward branch as the user anchor with A", async () => {
    const edge = {
      id: 7,
      deleted: false,
      src: { start: 12, which: 12 },
      dest: { start: 4, which: 4 },
      distance: 8,
    };
    mockVizEdges = [edge];
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    controller.setData.mockClear();
    controller.setSelectedEdgeActive.mockClear();
    await act(async () => {
      controller.emitEdgeSelect(edge);
    });

    await keydown("A", "KeyA");

    expect(engine.setUserAnchorEdge).toHaveBeenCalledWith(edge);
    expect(controller.setData).toHaveBeenCalled();
    expect(controller.setSelectedEdgeActive).toHaveBeenCalledWith(edge);
    expect(rendered.container.textContent).toContain("Anchor branch set");

    engine.getUserAnchorEdgeId.mockReturnValue(edge.id);
    await keydown("a", "KeyA");

    expect(engine.setUserAnchorEdge).toHaveBeenLastCalledWith(null);
    expect(rendered.container.textContent).toContain("Anchor branch reset");
    rendered.unmount();
  });

  it("clears the selection when A unpins a branch the tuning filters out", async () => {
    const edge = {
      id: 7,
      deleted: false,
      src: { start: 12, which: 12 },
      dest: { start: 4, which: 4 },
      distance: 8,
    };
    mockVizEdges = [edge];
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    await act(async () => {
      controller.emitEdgeSelect(edge);
    });
    engine.getUserAnchorEdgeId.mockReturnValue(edge.id);
    mockVizEdges = [];
    controller.setSelectedEdge.mockClear();
    controller.setSelectedEdgeActive.mockClear();

    await keydown("a", "KeyA");

    expect(engine.setUserAnchorEdge).toHaveBeenLastCalledWith(null);
    expect(controller.setSelectedEdge).toHaveBeenLastCalledWith(null);
    expect(controller.setSelectedEdgeActive).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("redirects A on a forward branch to its backward twin", async () => {
    const forward = {
      id: 8,
      deleted: false,
      src: { start: 4, which: 4 },
      dest: { start: 12, which: 12 },
      distance: 8,
    };
    const twin = {
      id: 9,
      deleted: false,
      src: { start: 12, which: 12 },
      dest: { start: 4, which: 4 },
      distance: 8,
    };
    mockVizEdges = [forward, twin];
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    await act(async () => {
      controller.emitEdgeSelect(forward);
    });

    await keydown("A", "KeyA");

    expect(engine.setUserAnchorEdge).toHaveBeenCalledWith(twin);
    expect(controller.setSelectedEdgeActive).toHaveBeenLastCalledWith(twin);
    expect(rendered.container.textContent).toContain("Anchor branch set");
    rendered.unmount();
  });

  it("shows a toast instead of anchoring a forward branch with no backward twin", async () => {
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    await act(async () => {
      controller.emitEdgeSelect({
        id: 8,
        deleted: false,
        src: { start: 4, which: 4 },
        dest: { start: 12, which: 12 },
        distance: 8,
      });
    });

    await keydown("A", "KeyA");

    expect(engine.setUserAnchorEdge).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain(
      "Anchor requires a backward branch",
    );
    rendered.unmount();
  });

  it("does not redirect to the backward twin on the arc visualization", async () => {
    window.localStorage.setItem("fj-viz", String(ARC_VIZ_INDEX));
    const forward = {
      id: 8,
      deleted: false,
      src: { start: 4, which: 4 },
      dest: { start: 12, which: 12 },
      distance: 8,
    };
    const twin = {
      id: 9,
      deleted: false,
      src: { start: 12, which: 12 },
      dest: { start: 4, which: 4 },
      distance: 8,
    };
    mockVizEdges = [forward, twin];
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    await act(async () => {
      controller.emitEdgeSelect(forward);
    });

    await keydown("A", "KeyA");

    expect(engine.setUserAnchorEdge).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain(
      "Anchor requires a backward branch",
    );
    rendered.unmount();
  });

  it("honors a visualization switch made after the branch was selected", async () => {
    const forward = {
      id: 8,
      deleted: false,
      src: { start: 4, which: 4 },
      dest: { start: 12, which: 12 },
      distance: 8,
    };
    const twin = {
      id: 9,
      deleted: false,
      src: { start: 12, which: 12 },
      dest: { start: 4, which: 4 },
      distance: 8,
    };
    mockVizEdges = [forward, twin];
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    await act(async () => {
      controller.emitEdgeSelect(forward);
    });

    // Switching to the arc viz after the selection must apply to the A
    // shortcut even though the hotkey effect does not re-run.
    const vizSelect = getRequired<HTMLSelectElement>(
      rendered.container,
      "#viz-select",
    );
    await changeSelect(vizSelect, String(ARC_VIZ_INDEX));

    await keydown("A", "KeyA");

    expect(engine.setUserAnchorEdge).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain(
      "Anchor requires a backward branch",
    );
    rendered.unmount();
  });

  it("updates the velocity toast in place while ramping", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }

    await keydown("]", "BracketRight");
    await keydown("]", "BracketRight", true);

    const toasts = rendered.container.querySelectorAll(".toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toBe("Play velocity: +3");
    rendered.unmount();
  });

  async function openCustomAnchorEditor() {
    window.localStorage.setItem("fj-custom-anchor-enabled", "1");
    mockVizBeats = Array.from({ length: 32 }, (_, which) => ({
      which,
      start: which,
      duration: 1,
      confidence: 1,
      neighbors: [],
      overlappingSegments: [],
    }));
    const rendered = renderListen();
    await settleEffects();
    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0] as unknown as {
      getActiveAnchor: ReturnType<typeof vi.fn>;
      getAnchorParam: ReturnType<typeof vi.fn>;
      setCustomAnchor: ReturnType<typeof vi.fn>;
      setForceBranch: ReturnType<typeof vi.fn>;
    };
    if (!controller || !engine) {
      throw new Error("Expected jukebox controller and engine instances");
    }
    engine.getActiveAnchor.mockReturnValue({ src: 20, dest: 5 });
    await click(getRequired<HTMLButtonElement>(rendered.container, "#custom-anchor-start"));
    return { rendered, controller, engine };
  }

  it("opens the custom anchor editor, saves a dragged pair as ab, and closes on Escape", async () => {
    const { rendered, controller, engine } = await openCustomAnchorEditor();
    expect(controller.setAnchorEdit).toHaveBeenLastCalledWith({ src: 20, dest: 5, active: "src" });
    expect(rendered.container.querySelector("#custom-anchor-toolbar")).not.toBeNull();
    expect(rendered.container.querySelector("#viz-select")).toBeNull();

    engine.getAnchorParam.mockReturnValue({ custom: { src: 24, dest: 5 } });
    const commit = controller.setOnAnchorEditCommit.mock.calls.at(-1)?.[0] as (state: unknown) => void;
    await act(async () => {
      commit({ src: 24, dest: 5, active: "src" });
    });
    expect(engine.setCustomAnchor).toHaveBeenCalledWith(24, 5);
    const savedKey = Object.keys(window.localStorage).find((key) => key.startsWith("fj-tuning:"));
    expect(savedKey).toBeDefined();
    expect(JSON.parse(window.localStorage.getItem(savedKey!)!).anchor).toBe("24-5");

    await keydown("Escape", "Escape");
    expect(rendered.container.querySelector("#custom-anchor-toolbar")).toBeNull();
    expect(controller.setAnchorEdit).toHaveBeenLastCalledWith(null);
    rendered.unmount();
  });

  it("nudges the selected end with arrows and keeps Shift from force-branching while editing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rendered, controller, engine } = await openCustomAnchorEditor();

    await keydown("ArrowRight", "ArrowRight");
    expect(controller.setAnchorEdit).toHaveBeenLastCalledWith({ src: 21, dest: 5, active: "src" });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
      );
    });
    expect(controller.setAnchorEdit).toHaveBeenLastCalledWith({ src: 17, dest: 5, active: "src" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(engine.setCustomAnchor).toHaveBeenLastCalledWith(17, 5);

    engine.setForceBranch.mockClear();
    await keydown("Shift", "ShiftLeft");
    expect(engine.setForceBranch).not.toHaveBeenCalledWith(true);

    await keydown("Enter", "Enter");
    expect(rendered.container.querySelector("#custom-anchor-toolbar")).toBeNull();
    rendered.unmount();
  });

  it("hides visible branch stats popup when branch stats is disabled", async () => {
    window.localStorage.setItem("fj-branch-stats-enabled", "1");
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    if (!controller) {
      throw new Error("Expected jukebox controller instance");
    }
    await act(async () => {
      controller.emitEdgeSelect({
        id: 7,
        src: { start: 10, which: 10 },
        dest: { start: 20, which: 20 },
        distance: 10,
      });
    });
    expect(rendered.container.querySelector(".branch-stats-popup")).not.toBeNull();

    await openTuningModal(rendered.container);
    const branchStatsInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#extras-enabled"
    );
    expect(branchStatsInput.checked).toBe(true);
    await click(branchStatsInput);

    expect(rendered.container.querySelector(".branch-stats-popup")).toBeNull();
    rendered.unmount();
  });

  it("deletes selected branch from branch stats popup delete button", async () => {
    window.localStorage.setItem("fj-branch-stats-enabled", "1");
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    if (!controller) {
      throw new Error("Expected jukebox controller instance");
    }
    await act(async () => {
      controller.emitEdgeSelect({
        id: 9,
        deleted: false,
        src: { start: 12, which: 12 },
        dest: { start: 24, which: 24 },
        distance: 8,
      });
    });

    const deleteButton = getRequired<HTMLButtonElement>(
      rendered.container,
      "#branch-stats-delete"
    );
    await click(deleteButton);

    expect(rendered.container.querySelector(".branch-stats-popup")).toBeNull();
    rendered.unmount();
  });

  it("resets tuning and extras settings together when reset is clicked", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    await changeRange(
      getRequired<HTMLInputElement>(rendered.container, "#threshold"),
      "40",
    );
    await click(getRequired<HTMLInputElement>(rendered.container, "#extras-enabled"));
    await click(getRequired<HTMLInputElement>(rendered.container, "#bring-home-enabled"));
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-daycore"));

    expect(window.localStorage.getItem("fj-branch-stats-enabled")).toBe("1");
    expect(
      getRequired<HTMLDivElement>(rendered.container, ".play-title").textContent
    ).toContain("(daycore)");
    expect(rendered.container.textContent).toContain("Bringing it on home");
    expect(window.location.search).toContain("am=daycore");

    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    engine.clearDeletedEdges.mockClear();

    await click(getRequired<HTMLButtonElement>(rendered.container, "#tuning-reset"));

    expect(engine.clearDeletedEdges).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("fj-branch-stats-enabled")).toBe("1");
    expect(
      getRequired<HTMLDivElement>(rendered.container, ".play-title").textContent
    ).not.toContain("(daycore)");
    expect(rendered.container.textContent).not.toContain("Bringing it on home");
    expect(window.location.search).not.toContain("am=daycore");
    rendered.unmount();
  });

  it("hides reset until a tuning or extras setting differs from defaults", async () => {
    const rendered = renderListen();
    await settleEffects();
    const hasReset = () =>
      rendered.container.querySelector("#tuning-reset") !== null;

    await openTuningModal(rendered.container);
    expect(hasReset()).toBe(false);
    const threshold = getRequired<HTMLInputElement>(
      rendered.container,
      "#threshold",
    );
    await changeRange(threshold, "40");
    expect(hasReset()).toBe(true);
    await changeRange(threshold, "20");
    expect(hasReset()).toBe(false);

    await click(getRequired<HTMLInputElement>(rendered.container, "#extras-enabled"));
    expect(hasReset()).toBe(false);
    await click(getRequired<HTMLInputElement>(rendered.container, "#audio-mode-daycore"));
    expect(hasReset()).toBe(true);
    rendered.unmount();
  });

  it("shows tuning reset for a deleted branch or a non-default anchor", async () => {
    const rendered = renderListen();
    await settleEffects();
    const engine = engineInstances[0];
    if (!engine) {
      throw new Error("Expected jukebox engine instance");
    }
    const hasReset = () =>
      rendered.container.querySelector("#tuning-reset") !== null;
    const closeButton = () =>
      getRequired<HTMLButtonElement>(rendered.container, "#tuning-close");

    const graphSpy = vi.spyOn(engine as unknown as { getGraphState: () => unknown }, "getGraphState");
    graphSpy.mockReturnValue({
      computedThreshold: 20,
      currentThreshold: 20,
      totalBeats: 0,
      allEdges: [{ id: 3, deleted: true }],
    });
    await openTuningModal(rendered.container);
    expect(hasReset()).toBe(true);
    await click(closeButton());
    graphSpy.mockRestore();

    vi.spyOn(engine, "getVisualizationData").mockReturnValue({
      beats: [],
      edges: [],
      userAnchorEdgeId: 7,
    } as ReturnType<typeof engine.getVisualizationData>);
    await openTuningModal(rendered.container);
    expect(hasReset()).toBe(true);
    rendered.unmount();
  });

  it("resets audio mode when switching to a different track", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const daycoreInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-mode-daycore"
    );
    await click(daycoreInput);

    const playTitle = getRequired<HTMLDivElement>(rendered.container, ".play-title");
    expect(playTitle.textContent).toContain("(daycore)");
    expect(window.location.search).toContain("am=daycore");

    mockAppState.file = new File([new Uint8Array([9, 9, 9])], "song-two.wav", {
      lastModified: 9999,
    });
    rendered.rerender();
    await settleEffects();

    const player = playerInstances[0];
    if (!player) {
      throw new Error("Expected buffered player instance");
    }
    expect(player.getAudioMode()).toBe("off");
    expect(window.location.search).not.toContain("am=daycore");
    rendered.unmount();
  });

  it.each(["swing", "instrumental"] as const)(
    "keeps %s off for the next track once a track change resets it",
    async (mode) => {
      const rendered = renderListen();
      await settleEffects();

      await openTuningModal(rendered.container);
      await click(getRequired<HTMLInputElement>(rendered.container, `#audio-mode-${mode}`));
      await settleEffects();

      const render = mode === "swing" ? renderSwingBuffer : renderInstrumentalBuffer;
      const player = playerInstances.at(-1) as unknown as {
        setJukeboxAudioMode: ReturnType<typeof vi.fn>;
        setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
        getJukeboxAudioMode: () => string;
      };
      expect(player.setRenderedJukeboxAudioBuffer).toHaveBeenCalledWith(mode, {
        duration: 4,
      });
      vi.mocked(render).mockClear();
      player.setJukeboxAudioMode.mockClear();
      player.setRenderedJukeboxAudioBuffer.mockClear();

      mockAppState.file = new File([new Uint8Array([9, 9, 9])], "song-two.wav", {
        lastModified: 9999,
      });
      rendered.rerender();
      await settleEffects();

      expect(vi.mocked(render)).not.toHaveBeenCalled();
      expect(player.setRenderedJukeboxAudioBuffer).not.toHaveBeenCalled();
      expect(player.setJukeboxAudioMode).not.toHaveBeenCalledWith(mode);
      expect(player.getJukeboxAudioMode()).toBe("off");
      expect(window.location.search).not.toContain(`am=${mode}`);
      rendered.unmount();
    },
  );

  it.each(["swing", "instrumental"] as const)(
    "prepares %s applied in extras while the track is analyzing once it is ready",
    async (mode) => {
      const finishAnalysis = holdNextAnalysis();
      const rendered = renderListen();
      await settleEffects();

      // The playback controls are hidden while analyzing; the shortcut still opens Tuning & Extras.
      await keydown("e", "KeyE");
      await click(getRequired<HTMLInputElement>(rendered.container, `#audio-mode-${mode}`));
      const render = mode === "swing" ? renderSwingBuffer : renderInstrumentalBuffer;
      expect(vi.mocked(render)).not.toHaveBeenCalled();
      expect(window.location.search).toContain(`am=${mode}`);

      await act(async () => {
        finishAnalysis();
      });
      await settleEffects();

      const player = playerInstances.at(-1) as unknown as {
        setJukeboxAudioMode: ReturnType<typeof vi.fn>;
        setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
        getJukeboxAudioMode: () => string;
      };
      expect(vi.mocked(render)).toHaveBeenCalledTimes(1);
      expect(player.setRenderedJukeboxAudioBuffer).toHaveBeenCalledTimes(1);
      expect(player.setRenderedJukeboxAudioBuffer).toHaveBeenCalledWith(mode, {
        duration: 4,
      });
      expect(player.setJukeboxAudioMode).toHaveBeenLastCalledWith(mode);
      expect(player.getJukeboxAudioMode()).toBe(mode);
      expect(window.location.search).toContain(`am=${mode}`);
      expect(
        getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute(
          "aria-label",
        ),
      ).toBe("Play");
      rendered.unmount();
    },
  );

  it.each(["swing", "instrumental"] as const)(
    "drops %s applied while analyzing when the track changes before it is ready",
    async (mode) => {
      const finishFirstAnalysis = holdNextAnalysis();
      const rendered = renderListen();
      await settleEffects();

      await keydown("e", "KeyE");
      await click(getRequired<HTMLInputElement>(rendered.container, `#audio-mode-${mode}`));
      expect(window.location.search).toContain(`am=${mode}`);

      const finishSecondAnalysis = holdNextAnalysis();
      mockAppState.file = new File([new Uint8Array([9, 9, 9])], "song-two.wav", {
        lastModified: 9999,
      });
      rendered.rerender();
      await settleEffects();
      await act(async () => {
        finishFirstAnalysis();
        finishSecondAnalysis();
      });
      await settleEffects();

      const render = mode === "swing" ? renderSwingBuffer : renderInstrumentalBuffer;
      const player = playerInstances.at(-1) as unknown as {
        setRenderedJukeboxAudioBuffer: ReturnType<typeof vi.fn>;
        getJukeboxAudioMode: () => string;
      };
      expect(vi.mocked(render)).not.toHaveBeenCalled();
      expect(player.setRenderedJukeboxAudioBuffer).not.toHaveBeenCalled();
      expect(player.getJukeboxAudioMode()).toBe("off");
      expect(window.location.search).not.toContain("am=");
      expect(
        getRequired<HTMLButtonElement>(rendered.container, "#viz-play").getAttribute(
          "aria-label",
        ),
      ).toBe("Play");
      rendered.unmount();
    },
  );

  it("live-updates tuning and extras controls without an Apply button", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const thresholdInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#threshold",
    );
    await changeRange(thresholdInput, "55");

    const nightcoreInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-mode-nightcore",
    );
    await click(nightcoreInput);

    expect(window.location.search).toContain("am=nightcore");
    expect(thresholdInput.value).toBe("55");
    rendered.unmount();
  });

  it("applies minimum jump distance slider checkpoints", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const slider = getRequired<HTMLInputElement>(
      rendered.container,
      "#min-jump-distance",
    );
    expect(slider.value).toBe("0");
    await changeRange(slider, "4");
    expect(slider.parentElement?.textContent).toContain(">30% of track");

    expect(engineInstances[0]?.getConfig()).toEqual(
      expect.objectContaining({
        justLongBranches: true,
        minLongBranchPercent: 30,
      }),
    );
    rendered.unmount();
  });

  it("closes the inline tuning panel from its close button", async () => {
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    const modal = getRequired<HTMLDivElement>(rendered.container, "#tuning-modal");
    expect(modal.getAttribute("aria-modal")).toBe("false");

    await click(getRequired<HTMLButtonElement>(rendered.container, "#tuning-close"));
    expect(rendered.container.querySelector("#tuning-modal")).toBeNull();
    rendered.unmount();
  });

  it("loads audio mode from url params into title and extras radios", async () => {
    window.history.replaceState({}, "", "/?am=eight_bit");
    const rendered = renderListen();
    await settleEffects();

    const playTitle = getRequired<HTMLDivElement>(rendered.container, ".play-title");
    expect(playTitle.textContent).toContain("(8-bit)");

    await openTuningModal(rendered.container);
    const eightBitInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-mode-eight-bit"
    );
    expect(eightBitInput.checked).toBe(true);
    rendered.unmount();
  });

  it("loads cathedral audio mode from url params", async () => {
    window.history.replaceState({}, "", "/?am=cathedral");
    const rendered = renderListen();
    await settleEffects();

    const playTitle = getRequired<HTMLDivElement>(rendered.container, ".play-title");
    expect(playTitle.textContent).toContain("(cathedral)");

    await openTuningModal(rendered.container);
    const cathedralInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#audio-mode-cathedral"
    );
    expect(cathedralInput.checked).toBe(true);
    rendered.unmount();
  });

  it("toggles metronome inside the BPM bar panel, syncs signature/offset, and disables when BPM bar turns off", async () => {
    metronomeOverlayInstances.length = 0;
    const rendered = renderListen();
    await settleEffects();

    await openTuningModal(rendered.container);
    expect(
      rendered.container.querySelector("#audio-mode-metronome"),
    ).toBeNull();

    const metronomeToggle = getRequired<HTMLInputElement>(
      rendered.container,
      "#bpm-bar-metronome-toggle",
    );
    await click(metronomeToggle);

    const volSlider = getRequired<HTMLInputElement>(
      rendered.container,
      "#metronome-volume",
    );
    const tsModeSelect = getRequired<HTMLSelectElement>(
      rendered.container,
      "#bpm-bar-time-sig-mode",
    );
    await changeRange(volSlider, "160");
    await act(async () => {
      tsModeSelect.value = "custom";
      tsModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const numInput = getRequired<HTMLInputElement>(
      rendered.container,
      "#bpm-bar-numerator",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(numInput, "3");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
      numInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const incBtn = getRequired<HTMLButtonElement>(
      rendered.container,
      "#bpm-bar-beat-offset-inc",
    );
    await click(incBtn);

    expect(metronomeOverlayInstances[0]?.enable).toHaveBeenCalled();
    expect(
      metronomeOverlayInstances[0]?.setMetronomeVolumePct,
    ).toHaveBeenLastCalledWith(160);
    expect(
      metronomeOverlayInstances[0]?.setBeatsPerBarOverride,
    ).toHaveBeenLastCalledWith(3);
    expect(
      metronomeOverlayInstances[0]?.setBeatOffset,
    ).toHaveBeenLastCalledWith(1);

    const bpmBarToggle = getRequired<HTMLInputElement>(
      rendered.container,
      "#bpm-bar-toggle",
    );
    await click(bpmBarToggle);
    expect(metronomeOverlayInstances[0]?.disable).toHaveBeenCalled();
    rendered.unmount();
  });

  it("updates visual preferences, smooth BPM bar, and upcoming branch lookahead", async () => {
    const rendered = renderListen();
    await settleEffects();

    const controller = jukeboxControllerInstances[0];
    const engine = engineInstances[0];
    if (!controller || !engine) {
      throw new Error("Expected controller and engine instances");
    }
    vi.spyOn(engine, "getPredictedJumps").mockReturnValue([1]);

    await openTuningModal(rendered.container);
    await click(getRequired<HTMLInputElement>(rendered.container, "#use-square-beats"));
    await click(getRequired<HTMLInputElement>(rendered.container, "#use-alt-seek-shape"));
    expect(controller.setVisualPreferences).toHaveBeenLastCalledWith({
      visualEffectMode: "0",
      useSquareBeats: true,
      useAltSeekShape: true,
    });

    await changeSelect(
      getRequired<HTMLSelectElement>(rendered.container, "#bpm-bar-style"),
      "smooth",
    );
    expect(rendered.container.querySelector("#bpm-bar-smooth")).not.toBeNull();

    await click(getRequired<HTMLInputElement>(rendered.container, "#branch-lookahead-toggle"));
    expect(controller.setPredictedJumps).toHaveBeenLastCalledWith([1]);

    // Trigger a beat update and verify BPM bar animates without forcing a React commit.
    await act(async () => {
      engine.emitUpdate({
        beatsPlayed: 1,
        currentBeatIndex: 0,
        currentTime: 0.2,
        curRandomBranchChance: 0.32,
        lastJumped: false,
        lastJumpFromIndex: null,
        lastJumpToIndex: null,
      });
    });
    const smoothFill = getRequired<HTMLSpanElement>(
      rendered.container,
      "#bpm-bar-smooth-fill",
    );
    expect(smoothFill.classList.contains("is-animating")).toBe(true);
    expect(getRequired<HTMLSpanElement>(rendered.container, "#branch-chance").textContent).toBe(
      "32%",
    );
    rendered.unmount();
  });

  it("opens MixQueueModal when clicking Mix Songs with fewer than 2 queued tracks and enables multi-track mixing when 2+ tracks are queued", async () => {
    const songTwo = new File([new Uint8Array([4, 5, 6])], "track-two.wav", {
      lastModified: 5678,
    });
    mockAppState.mixQueue = [
      {
        id: "q-1",
        file: mockAppState.file,
        fileHandle: null,
        title: "Track One",
      },
    ];

    const rendered = renderListen();
    await settleEffects();

    const queueBtn = getRequired<HTMLButtonElement>(
      rendered.container,
      "#playlist-open",
    );
    await click(queueBtn);
    expect(rendered.container.querySelector("#playlist-modal")).not.toBeNull();
    await click(getRequired<HTMLButtonElement>(rendered.container, "#playlist-close"));
    expect(rendered.container.querySelector("#playlist-modal")).toBeNull();

    const mixBtn = getRequired<HTMLButtonElement>(
      rendered.container,
      "#multi-track-mix-toggle",
    );
    expect(mixBtn.textContent).toBe("Mix Songs");
    await click(mixBtn);
    expect(mockAppState.setMixAddSticky).toHaveBeenCalledWith(true);

    // Queue a second track and trigger Multi-Track Mix.
    mockAppState.mixQueue = [
      {
        id: "q-1",
        file: mockAppState.file,
        fileHandle: null,
        title: "Track One",
        fingerprint: "fp-1",
      },
      {
        id: "q-2",
        file: songTwo,
        fileHandle: null,
        title: "Track Two",
        fingerprint: "fp-2",
      },
    ];
    rendered.rerender();

    const merged = {
      ...mockAnalysis,
      beats: [
        { ...mockAnalysis.beats[0], which: 0, localWhich: 0, trackIndex: 0 },
        { ...mockAnalysis.beats[1], which: 1, localWhich: 0, trackIndex: 1 },
      ],
      tracks: [
        {
          id: "0",
          title: "Track One",
          start: 0,
          duration: 4,
          beatCount: 1,
          beatStart: 0,
          tempo: 120,
        },
        {
          id: "1",
          title: "Track Two",
          start: 4,
          duration: 4,
          beatCount: 1,
          beatStart: 1,
          tempo: 120,
        },
      ],
      beatCount: 2,
    };
    const resolveSpy = vi.spyOn(localMix, "resolveLocalMixSources").mockResolvedValue([
      {
        id: "q-1",
        fingerprint: "fp-1",
        title: "Track One",
        analysis: mockAnalysis as never,
        audioBuffer: { duration: 4 } as AudioBuffer,
        tempo: 120,
        file: mockAppState.file!,
        fileHandle: null,
      },
      {
        id: "q-2",
        fingerprint: "fp-2",
        title: "Track Two",
        analysis: mockAnalysis as never,
        audioBuffer: { duration: 4 } as AudioBuffer,
        tempo: 120,
        file: songTwo,
        fileHandle: null,
      },
    ]);
    const buildSpy = vi.spyOn(localMix, "buildJukeboxMix").mockReturnValue({
      combined: {
        buffer: { duration: 8 } as AudioBuffer,
        sliceDurations: [4, 4],
        appliedGains: [1, 1],
      },
      mergedAnalysis: merged as never,
      resolvedGainsPct: [100, 100],
      resolvedTrackOffsets: [0, 0],
    });

    try {
      await click(
        getRequired<HTMLButtonElement>(rendered.container, "#multi-track-mix-toggle"),
      );
      await settleEffects();

      expect(mixBtn.textContent).toBe("Unmix Songs");
      expect(
        getRequired<HTMLDivElement>(rendered.container, ".play-title").textContent,
      ).toContain("Track One × Track Two");

      await openTuningModal(rendered.container);
      expect(rendered.container.querySelector("#tuning-panel-multi")).not.toBeNull();
      await click(getRequired<HTMLInputElement>(rendered.container, "#cross-track-only"));

      await click(mixBtn);
      await settleEffects();
      expect(mixBtn.textContent).toBe("Mix Songs");
      expect(rendered.container.querySelector("#tuning-panel-multi")).toBeNull();
    } finally {
      resolveSpy.mockRestore();
      buildSpy.mockRestore();
    }
    rendered.unmount();
  });

  it("supports 2-song and 4-voice quad Autocanonizer mixing, pan/gain reset, and dual export", async () => {
    const songTwo = new File([new Uint8Array([4, 5, 6])], "track-two.wav", {
      lastModified: 5678,
    });
    const mainDualBuf = { duration: 4, tag: "main-dual" } as unknown as AudioBuffer;
    const otherDualBuf = { duration: 4, tag: "other-dual" } as unknown as AudioBuffer;

    mockAppState.mixQueue = [
      {
        id: "q-1",
        file: mockAppState.file,
        fileHandle: null,
        title: "Song A",
        fingerprint: "fp-a",
      },
      {
        id: "q-2",
        file: songTwo,
        fileHandle: null,
        title: "Song B",
        fingerprint: "fp-b",
      },
    ];

    const resolveSpy = vi.spyOn(localMix, "resolveLocalMixSources").mockResolvedValue([
      {
        id: "q-1",
        fingerprint: "fp-a",
        title: "Song A",
        analysis: mockAnalysis as never,
        audioBuffer: mainDualBuf,
        tempo: 120,
        file: mockAppState.file!,
        fileHandle: null,
      },
      {
        id: "q-2",
        fingerprint: "fp-b",
        title: "Song B",
        analysis: mockAnalysis as never,
        audioBuffer: otherDualBuf,
        tempo: 120,
        file: songTwo,
        fileHandle: null,
      },
    ]);
    const canonizerMixSpy = vi.spyOn(localMix, "buildAutocanonizerMix").mockReturnValue({
      prepared: {
        mainBuffer: mainDualBuf,
        otherBuffer: otherDualBuf,
        mainDurationSec: 4,
        otherDurationSec: 4,
        appliedOtherGain: 1,
      },
      otherTempoRatio: 1,
    });

    try {
      const rendered = renderListen();
      await settleEffects();

      await changeSelect(
        getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
        "autocanonizer",
      );
      const canonizer = autocanonizerInstances[0];
      if (!canonizer) {
        throw new Error("Expected autocanonizer instance");
      }
      canonizer.getAudioBuffers.mockReturnValue({
        mainBuffer: mainDualBuf,
        otherBuffer: otherDualBuf,
      });

      const mixBtn = getRequired<HTMLButtonElement>(
        rendered.container,
        "#multi-track-mix-toggle",
      );
      expect(mixBtn.textContent).toBe("Mix 2 Songs");
      await click(mixBtn);
      await settleEffects();

      expect(mixBtn.textContent).toBe("Unmix Songs");
      expect(canonizer.setDualAudio).toHaveBeenCalled();
      expect(canonizer.setDualAnalysis).toHaveBeenCalled();
      expect(
        getRequired<HTMLButtonElement>(rendered.container, "#canonizer-mix-swap"),
      ).not.toBeNull();

      await click(
        getRequired<HTMLButtonElement>(rendered.container, "#canonizer-quad-toggle"),
      );
      expect(canonizer.setQuadMode).toHaveBeenLastCalledWith(true);

      await click(
        getRequired<HTMLButtonElement>(rendered.container, "#autocanonizer-pan-button"),
      );
      await changeRange(
        getRequired<HTMLInputElement>(rendered.container, "#autocanonizer-pink-pan"),
        "-50",
      );
      expect(canonizer.setQuadStreamPans).toHaveBeenCalled();

      await click(
        getRequired<HTMLButtonElement>(rendered.container, "#autocanonizer-balance-reset"),
      );
      expect(canonizer.setStreamPans).toHaveBeenLastCalledWith(0, 0);
      expect(canonizer.setQuadStreamPans).toHaveBeenLastCalledWith(0, 0);

      await click(getRequired<HTMLButtonElement>(rendered.container, "#track-audio-export"));
      await click(
        getRequired<HTMLButtonElement>(
          rendered.container,
          ".modal-footer .tab-btn:last-child",
        ),
      );
      await settleEffects();

      expect(exportMocks.exportCanonizerAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceBuffer: mainDualBuf,
          otherSourceBuffer: otherDualBuf,
        }),
      );
      rendered.unmount();
    } finally {
      resolveSpy.mockRestore();
      canonizerMixSpy.mockRestore();
    }
  });

  it("reloads Song Sync when queued tracks are added or removed and resets below two tracks", async () => {
    const songTwo = new File([new Uint8Array([4, 5, 6])], "track-two.wav", {
      lastModified: 5678,
    });
    const songThree = new File([new Uint8Array([7, 8, 9])], "track-three.wav", {
      lastModified: 9012,
    });
    const bufA = { duration: 4, tag: "a" } as unknown as AudioBuffer;
    const bufB = { duration: 3, tag: "b" } as unknown as AudioBuffer;
    const bufC = { duration: 2, tag: "c" } as unknown as AudioBuffer;

    mockAppState.mixQueue = [
      {
        id: "q-1",
        file: mockAppState.file,
        fileHandle: null,
        title: "Song A",
        fingerprint: "fp-a",
      },
      {
        id: "q-2",
        file: songTwo,
        fileHandle: null,
        title: "Song B",
        fingerprint: "fp-b",
      },
    ];

    const resolveSpy = vi
      .spyOn(localMix, "resolveLocalMixSources")
      .mockImplementation(async (tracks) =>
        tracks.map((track) => ({
          id: track.id,
          fingerprint: track.fingerprint ?? track.id,
          title: track.title,
          analysis: mockAnalysis as never,
          audioBuffer:
            track.id === "q-1" ? bufA : track.id === "q-2" ? bufB : bufC,
          tempo: 120,
          file: track.file ?? mockAppState.file!,
          fileHandle: null,
        })),
      );
    const buildSyncSpy = vi
      .spyOn(localMix, "buildSongSyncMix")
      .mockImplementation((_ctx, sources) => ({
        prepared: {
          buffers: sources.map((s) => s.audioBuffer),
          durationsSec: sources.map((s) => s.audioBuffer.duration),
          appliedGains: sources.map(() => 1),
        },
        tempoRatios: sources.map(() => 1),
        masterTempo: 120,
      }));

    const rendered = renderListen();
    try {
      await settleEffects();

      await changeSelect(
        getRequired<HTMLSelectElement>(rendered.container, "#play-mode-select"),
        "songsync",
      );
      await settleEffects();

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0]?.[0].map((t) => t.id)).toEqual([
        "q-1",
        "q-2",
      ]);
      expect(buildSyncSpy).toHaveBeenCalledTimes(1);

      // Adding a 3rd queued song reuses q-1 and q-2 and only resolves q-3.
      mockAppState.mixQueue = [
        ...mockAppState.mixQueue,
        {
          id: "q-3",
          file: songThree,
          fileHandle: null,
          title: "Song C",
          fingerprint: "fp-c",
        },
      ];
      rendered.rerender();
      await settleEffects();

      expect(resolveSpy).toHaveBeenCalledTimes(2);
      expect(resolveSpy.mock.calls[1]?.[0].map((t) => t.id)).toEqual(["q-3"]);
      expect(buildSyncSpy).toHaveBeenCalledTimes(2);

      // Removing q-3 reuses cached sources without re-resolving and updates the mix.
      mockAppState.mixQueue = mockAppState.mixQueue.slice(0, 2);
      rendered.rerender();
      await settleEffects();

      expect(resolveSpy).toHaveBeenCalledTimes(2);
      expect(buildSyncSpy).toHaveBeenCalledTimes(3);

      // Dropping below 2 tracks exits the active Song Sync mix cleanly.
      mockAppState.mixQueue = mockAppState.mixQueue.slice(0, 1);
      rendered.rerender();
      await settleEffects();

      expect(rendered.container.querySelector("#songsync-mixer-button")).toBeNull();
    } finally {
      resolveSpy.mockRestore();
      buildSyncSpy.mockRestore();
      rendered.unmount();
    }
  });
});
