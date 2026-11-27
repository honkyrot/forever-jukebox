import { deleteRenderedTracks } from "@forever-jukebox/shared/audio/renderedTrackCache";
import { getAdminKey } from "./admin";
import { isAnalysisComplete, isAnalysisInProgress } from "./analysisStatus";
import { reanalyzeJob } from "./api";
import type { AppContext } from "./context";
import i18n from "./i18n";
import { jobLoadingStep } from "./job-progress";
import { discardCustomAnchorEdit } from "./playback/custom-anchor";
import { clearCachedMultiTrackSources } from "./playback/multi-track-mix";
import { clearCachedSongSyncSources } from "./playback/song-sync";
import { updateVizVisibility } from "./playback/status-ui";
import { applyAnalysisResult, pollAnalysis } from "./playback/track-load";
import { stopPlayback } from "./playback/transport";
import { getPlaybackDeps } from "./runtime";
import { useAppStore } from "./store";
import { setLoadingStep, showToast } from "./ui";

export type BpmMultiplier = 0.5 | 1 | 2;

export const BPM_MULTIPLIER_OPTIONS: readonly BpmMultiplier[] = [0.5, 1, 2];

export type PendingReanalyze = {
  jobId: string;
  trackId: string | null;
  currentTempoBpm: number | null;
  currentMultiplier: BpmMultiplier;
  bpmLocked: boolean;
  adminKey: string | null;
};

/**
 * Normalizes a numeric BPM multiplier to one of the supported presets (0.5, 1, 2).
 */
export function normalizeBpmMultiplier(value: unknown): BpmMultiplier {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value - 0.5) < 1e-6) {
      return 0.5;
    }
    if (Math.abs(value - 2) < 1e-6) {
      return 2;
    }
  }
  return 1;
}

/**
 * Estimates the resulting BPM when switching from `currentMultiplier` to `targetMultiplier`.
 */
export function estimateReanalyzedBpm(
  currentBpm: number | null,
  currentMultiplier: BpmMultiplier,
  targetMultiplier: BpmMultiplier,
): number | null {
  if (
    typeof currentBpm !== "number" ||
    !Number.isFinite(currentBpm) ||
    currentBpm <= 0
  ) {
    return null;
  }
  const baseBpm = currentBpm / currentMultiplier;
  return Math.round(baseBpm * targetMultiplier);
}

/**
 * Captures the active track's job identity, BPM state, and admin key before opening the modal.
 */
export function getPendingReanalyze(): PendingReanalyze | null {
  const state = useAppStore.getState();
  const jobId = state.lastJobId;
  if (!jobId) {
    return null;
  }
  return {
    jobId,
    trackId: state.lastTrackId,
    currentTempoBpm: state.trackTempoBpm,
    currentMultiplier: normalizeBpmMultiplier(state.trackBpmMultiplier),
    bpmLocked: Boolean(state.trackBpmLocked),
    adminKey: getAdminKey(),
  };
}

/**
 * Submits a server-side BPM reanalysis or admin lock change and refreshes active playback state.
 */
export async function performReanalyze(
  context: AppContext,
  pending: PendingReanalyze,
  next: { bpmMultiplier?: BpmMultiplier; bpmLocked?: boolean },
): Promise<boolean> {
  if (next.bpmMultiplier === undefined && next.bpmLocked === undefined) {
    return false;
  }

  const requestPayload: { bpm_multiplier?: BpmMultiplier; bpm_locked?: boolean } = {};
  if (next.bpmMultiplier !== undefined) {
    requestPayload.bpm_multiplier = next.bpmMultiplier;
  }
  if (next.bpmLocked !== undefined) {
    requestPayload.bpm_locked = next.bpmLocked;
  }

  try {
    const response = await reanalyzeJob(
      pending.jobId,
      requestPayload,
      pending.adminKey,
    );
    const liveState = useAppStore.getState();
    const stillViewingJob = liveState.lastJobId === pending.jobId;

    // Lock-only update: update the store flag without interrupting playback or re-polling.
    if (next.bpmMultiplier === undefined) {
      const nextLocked = Boolean(response?.bpm_locked ?? next.bpmLocked);
      if (stillViewingJob) {
        useAppStore.setState({ trackBpmLocked: nextLocked });
      }
      showToast(
        nextLocked ? i18n.t("reanalyze.lockedToast") : i18n.t("reanalyze.unlockedToast"),
        { icon: "lock" },
      );
      return true;
    }

    if (!stillViewingJob) {
      return true;
    }

    // Invalidate derived client caches so swing/wubmachine/mixes rebuild from the new beat grid.
    stopPlayback(context);
    clearCachedMultiTrackSources();
    clearCachedSongSyncSources();
    await deleteRenderedTracks(pending.jobId).catch((err: unknown) => {
      console.warn(`Rendered track delete failed: ${String(err)}`);
    });
    if (pending.trackId && pending.trackId !== pending.jobId) {
      await deleteRenderedTracks(pending.trackId).catch((err: unknown) => {
        console.warn(`Rendered track delete failed: ${String(err)}`);
      });
    }

    discardCustomAnchorEdit(context);
    context.engine.clearDeletedEdges();
    context.jukebox?.setSelectedEdge(null);
    useAppStore.setState({
      analysisLoaded: false,
      vizData: null,
      selectedEdge: null,
      branchStats: null,
      deletedEdgeIds: [],
      trackBpmMultiplier: next.bpmMultiplier,
      trackBpmLocked: Boolean(response?.bpm_locked ?? next.bpmLocked ?? pending.bpmLocked),
    });

    const playbackDeps = getPlaybackDeps() ?? {};

    if (response && isAnalysisComplete(response)) {
      applyAnalysisResult(context, response, playbackDeps.onAnalysisLoaded);
      showToast(i18n.t("reanalyze.completed"), { icon: "speed" });
      return true;
    }

    if (response && isAnalysisInProgress(response)) {
      const progress =
        typeof response.progress === "number" ? response.progress : null;
      setLoadingStep(
        context,
        jobLoadingStep(response.status, progress, response.message),
      );
      updateVizVisibility();
      showToast(i18n.t("reanalyze.started"), { icon: "speed" });
      void pollAnalysis(context, playbackDeps, pending.jobId);
      return true;
    }

    updateVizVisibility();
    showToast(i18n.t("reanalyze.started"), { icon: "speed" });
    void pollAnalysis(context, playbackDeps, pending.jobId);
    return true;
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 403) {
      showToast(i18n.t("reanalyze.lockedError"), { tone: "error" });
    } else if (status === 409) {
      showToast(i18n.t("reanalyze.inProgressError"), { tone: "error" });
    } else {
      showToast(i18n.t("reanalyze.failed"), { tone: "error" });
    }
    return false;
  }
}
