import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRenderedTracks } from "@forever-jukebox/shared/audio/renderedTrackCache";
import { ADMIN_KEY_STORAGE_KEY } from "./admin";
import { reanalyzeJob } from "./api";
import type { AppContext } from "./context";
import { discardCustomAnchorEdit } from "./playback/custom-anchor";
import { clearCachedMultiTrackSources } from "./playback/multi-track-mix";
import { clearCachedSongSyncSources } from "./playback/song-sync";
import { updateVizVisibility } from "./playback/status-ui";
import { applyAnalysisResult, pollAnalysis } from "./playback/track-load";
import { stopPlayback } from "./playback/transport";
import {
  estimateReanalyzedBpm,
  getPendingReanalyze,
  normalizeBpmMultiplier,
  performReanalyze,
} from "./reanalyze-job";
import { useAppStore } from "./store";
import { setLoadingStep, showToast } from "./ui";

vi.mock("@forever-jukebox/shared/audio/renderedTrackCache", () => ({
  deleteRenderedTracks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./api", () => ({ reanalyzeJob: vi.fn() }));
vi.mock("./playback/custom-anchor", () => ({
  discardCustomAnchorEdit: vi.fn(),
}));
vi.mock("./playback/multi-track-mix", () => ({
  clearCachedMultiTrackSources: vi.fn(),
}));
vi.mock("./playback/song-sync", () => ({
  clearCachedSongSyncSources: vi.fn(),
}));
vi.mock("./playback/status-ui", () => ({
  updateVizVisibility: vi.fn(),
}));
vi.mock("./playback/track-load", () => ({
  applyAnalysisResult: vi.fn(),
  pollAnalysis: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./playback/transport", () => ({
  stopPlayback: vi.fn(),
}));
vi.mock("./runtime", () => ({
  getPlaybackDeps: vi.fn(() => ({ onAnalysisLoaded: undefined })),
}));
vi.mock("./ui", () => ({
  setLoadingStep: vi.fn(),
  showToast: vi.fn(),
}));

const initialStoreState = useAppStore.getState();

function installLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  } as Storage;
}

function createFakeContext(): AppContext {
  return {
    engine: {
      clearDeletedEdges: vi.fn(),
    } as unknown as AppContext["engine"],
    jukebox: {
      setSelectedEdge: vi.fn(),
    } as unknown as AppContext["jukebox"],
  } as AppContext;
}

describe("reanalyze-job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installLocalStorage();
    useAppStore.setState(initialStoreState, true);
  });

  it("normalizes multipliers and estimates reanalyzed BPM", () => {
    expect(normalizeBpmMultiplier(0.5)).toBe(0.5);
    expect(normalizeBpmMultiplier(2)).toBe(2);
    expect(normalizeBpmMultiplier(1)).toBe(1);
    expect(normalizeBpmMultiplier(1.5)).toBe(1);

    expect(estimateReanalyzedBpm(93, 1, 2)).toBe(186);
    expect(estimateReanalyzedBpm(186, 2, 1)).toBe(93);
    expect(estimateReanalyzedBpm(186, 2, 0.5)).toBe(47);
    expect(estimateReanalyzedBpm(null, 1, 2)).toBeNull();
  });

  it("captures pending reanalysis state from the store", () => {
    expect(getPendingReanalyze()).toBeNull();

    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    useAppStore.setState({
      lastJobId: "job1",
      lastTrackId: "track1",
      trackTempoBpm: 93,
      trackBpmMultiplier: 1,
      trackBpmLocked: true,
    });

    expect(getPendingReanalyze()).toEqual({
      jobId: "job1",
      trackId: "track1",
      currentTempoBpm: 93,
      currentMultiplier: 1,
      bpmLocked: true,
      adminKey: "secret",
    });
  });

  it("updates only lock state when bpmMultiplier is omitted", async () => {
    vi.mocked(reanalyzeJob).mockResolvedValueOnce({
      status: "complete",
      id: "job1",
      result: {},
      bpm_locked: true,
    });
    useAppStore.setState({
      lastJobId: "job1",
      trackBpmLocked: false,
    });

    const ctx = createFakeContext();
    const ok = await performReanalyze(
      ctx,
      {
        jobId: "job1",
        trackId: "job1",
        currentTempoBpm: 93,
        currentMultiplier: 1,
        bpmLocked: false,
        adminKey: "secret",
      },
      { bpmLocked: true },
    );

    expect(ok).toBe(true);
    expect(reanalyzeJob).toHaveBeenCalledWith(
      "job1",
      { bpm_locked: true },
      "secret",
    );
    expect(useAppStore.getState().trackBpmLocked).toBe(true);
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("BPM locked for this track", {
      icon: "lock",
    });
  });

  it("clears derived caches, resets graph state, and polls on queued reanalysis", async () => {
    vi.mocked(reanalyzeJob).mockResolvedValueOnce({
      status: "queued",
      id: "job1",
      bpm_multiplier: 2,
      bpm_locked: false,
    });
    useAppStore.setState({
      lastJobId: "job1",
      lastTrackId: "track1",
      analysisLoaded: true,
      trackBpmMultiplier: 1,
      trackBpmLocked: false,
    });

    const ctx = createFakeContext();
    const ok = await performReanalyze(
      ctx,
      {
        jobId: "job1",
        trackId: "track1",
        currentTempoBpm: 93,
        currentMultiplier: 1,
        bpmLocked: false,
        adminKey: null,
      },
      { bpmMultiplier: 2 },
    );

    expect(ok).toBe(true);
    expect(stopPlayback).toHaveBeenCalledWith(ctx);
    expect(clearCachedMultiTrackSources).toHaveBeenCalledTimes(1);
    expect(clearCachedSongSyncSources).toHaveBeenCalledTimes(1);
    expect(deleteRenderedTracks).toHaveBeenCalledWith("job1");
    expect(deleteRenderedTracks).toHaveBeenCalledWith("track1");
    expect(discardCustomAnchorEdit).toHaveBeenCalledWith(ctx);
    expect(ctx.engine.clearDeletedEdges).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().analysisLoaded).toBe(false);
    expect(useAppStore.getState().trackBpmMultiplier).toBe(2);
    expect(setLoadingStep).toHaveBeenCalled();
    expect(updateVizVisibility).toHaveBeenCalled();
    expect(pollAnalysis).toHaveBeenCalledWith(ctx, expect.anything(), "job1");
    expect(applyAnalysisResult).not.toHaveBeenCalled();
  });

  it("shows specific error toasts for 403 lock and 409 conflict", async () => {
    useAppStore.setState({ lastJobId: "job1" });
    const ctx = createFakeContext();

    const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
    vi.mocked(reanalyzeJob).mockRejectedValueOnce(forbidden);
    expect(
      await performReanalyze(
        ctx,
        {
          jobId: "job1",
          trackId: "job1",
          currentTempoBpm: 93,
          currentMultiplier: 1,
          bpmLocked: false,
          adminKey: null,
        },
        { bpmMultiplier: 2 },
      ),
    ).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith(
      "BPM reanalysis is locked by an admin for this track",
      { tone: "error" },
    );

    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    vi.mocked(reanalyzeJob).mockRejectedValueOnce(conflict);
    expect(
      await performReanalyze(
        ctx,
        {
          jobId: "job1",
          trackId: "job1",
          currentTempoBpm: 93,
          currentMultiplier: 1,
          bpmLocked: false,
          adminKey: null,
        },
        { bpmMultiplier: 2 },
      ),
    ).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith(
      "Track analysis is already in progress",
      { tone: "error" },
    );
  });
});
