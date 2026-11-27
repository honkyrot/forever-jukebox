import { findBackwardTwin, isCustomAnchorEdge } from "@forever-jukebox/shared";
import {
  exitCustomAnchorEdit,
  nudgeCustomAnchor,
} from "./playback/custom-anchor";
import type { Edge } from "@forever-jukebox/shared/types";
import {
  CANONIZER_FINISH_KEY,
  VIZ_STORAGE_KEY,
  WUB_MACHINE_LOOP_KEY,
  visualizationSeparatesPairedEdges,
} from "./constants";
import { trackEvent, trackModeEnabled } from "./analytics";
import { formatErrorForDisplay } from "./errorDisplay";
import { formatDuration } from "@forever-jukebox/shared/ui/format";
import type { AppContext } from "./context";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import {
  applyExtrasChanges,
  buildBpmBarTimeSignatureInputFromStore,
  cancelWubMachineRender,
  disableAutocanonizerMix,
  disableMultiTrackMix,
  disableSongSyncMix,
  loadSongSyncMix,
  maybePrepareWubMachine,
  openExtras,
  startAutocanonizerPlayback,
  startJukeboxFromBeat,
  startSongSyncPlayback,
  startWubMachinePlayback,
  stopPlayback,
  syncDeletedEdgeState,
  syncPredictedJumps,
  togglePlayback,
  updateTrackInfo,
  updateVizVisibility,
  type ExtrasApplyResult,
  type ExtrasFormValues,
} from "./playback";
import { isBpmBarDownbeat } from "./bpmBarTimeSignature";
import {
  pulseVizStats,
  resetLiveBpm,
  updateLiveBpmForBeat,
} from "./playback/status-ui";
import {
  advancePlaylistOnAutocanonizerEnded,
  getAttachedAppContext,
} from "./runtime";
import { getCurrentTrackId, useAppStore } from "./store";
import {
  getTuningParamsFromEngine,
  serializeParams,
  writeTuningParamsToUrl,
} from "./tuning";
import { setAnalysisStatus, showToast } from "./ui";
import { isEditableTarget } from "@forever-jukebox/shared/ui/editableTarget";
import i18n from "./i18n";

let lastCowbellBeatsPlayed = 0;

export function resetPlaybackUiForTest(): void {
  lastCowbellBeatsPlayed = 0;
  resetLiveBpm(null);
}

function formatSignedDuration(seconds: number) {
  return `${seconds >= 0 ? "+" : "-"}${formatDuration(Math.abs(seconds))}`;
}

function formatSignedBeats(beats: number) {
  return `${beats >= 0 ? "+" : "-"}${Math.abs(beats)}`;
}

function formatPlayVelocity(velocity: number) {
  return velocity > 0 ? `+${velocity}` : `${velocity}`;
}

function toSimilarityPercent(distance: number, maxDistance: number) {
  if (!Number.isFinite(distance) || maxDistance <= 0) {
    return 0;
  }
  const normalized = 1 - distance / maxDistance;
  return Math.round(Math.max(0, Math.min(1, normalized)) * 100);
}

function branchDirection(edge: Edge) {
  if (edge.dest.which < edge.src.which) {
    return i18n.t("playback.backward");
  }
  if (edge.dest.which > edge.src.which) {
    return i18n.t("playback.forward");
  }
  return i18n.t("playback.sameBeat");
}

/**
 * Resolves the current cursor second and total duration for display.
 * In multi-track mode, translates concatenated buffer time into the active
 * track slice's local time and duration.
 */
function resolvePlaybackCursorTiming(
  rawSeconds: number,
  currentBeatIndex: number,
): { currentSeconds: number; durationSec: number | null } {
  const { vizData, trackDurationSec } = useAppStore.getState();
  const tracks = vizData?.tracks;
  if (!tracks || tracks.length < 2) {
    return {
      currentSeconds: Math.floor(Math.max(0, rawSeconds)),
      durationSec: trackDurationSec,
    };
  }
  const beatTrackIndex =
    currentBeatIndex >= 0 ? vizData.beats[currentBeatIndex]?.trackIndex : undefined;
  let slice =
    beatTrackIndex !== undefined ? tracks[beatTrackIndex] : undefined;
  if (!slice) {
    // Fall back to the latest track slice whose offset precedes rawSeconds.
    slice = tracks[0];
    for (const candidate of tracks) {
      if (candidate.startTimeOffset <= rawSeconds) {
        slice = candidate;
      }
    }
  }
  const localSeconds = Math.max(
    0,
    Math.min(slice.duration, rawSeconds - slice.startTimeOffset),
  );
  return {
    currentSeconds: Math.floor(localSeconds),
    durationSec: slice.duration,
  };
}

function syncExtrasPopup(edge: Edge | null) {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { engine } = context;
    if (
      !useAppStore.getState().branchStatsEnabled ||
      useAppStore.getState().playMode !== "jukebox" ||
      !edge
    ) {
      useAppStore.setState({ branchStats: null });
      return;
    }
    // Subtract each endpoint track's timeline offset in multi-track mixes so
    // Branch Stats displays local song timestamps rather than buffer offsets.
    const tracks = useAppStore.getState().vizData?.tracks;
    const srcOffset =
      edge.src.trackIndex !== undefined
        ? (tracks?.[edge.src.trackIndex]?.startTimeOffset ?? 0)
        : 0;
    const destOffset =
      edge.dest.trackIndex !== undefined
        ? (tracks?.[edge.dest.trackIndex]?.startTimeOffset ?? 0)
        : 0;
    const startSeconds = Math.max(0, edge.src.start - srcOffset);
    const endSeconds = Math.max(0, edge.dest.start - destOffset);
    const startDisplaySeconds = Math.floor(startSeconds);
    const endDisplaySeconds = Math.floor(endSeconds);
    const maxDistance = Math.max(1, engine.getConfig().maxBranchThreshold);
    useAppStore.setState({
      branchStats: {
        title: () =>
          isCustomAnchorEdge(edge)
            ? i18n.t("playback.customAnchorStatsTitle")
            : i18n.t("playback.branchStatsTitle", { id: edge.id }),
        startText: formatDuration(startDisplaySeconds),
        endText: formatDuration(endDisplaySeconds),
        deltaText: formatSignedDuration(endDisplaySeconds - startDisplaySeconds),
        startBeatText: String(edge.src.which),
        endBeatText: String(edge.dest.which),
        beatDeltaText: formatSignedBeats(edge.dest.which - edge.src.which),
        direction: () => branchDirection(edge),
        similarityText: `${toSimilarityPercent(edge.distance, maxDistance)}%`,
        deleteDisabled: edge.deleted,
      },
    });
  }

// applyExtrasChanges owns the disable half of the branch-stats invariant
// (it nulls branchStats itself); this wrapper completes the enable half so
// no caller can leave the popup stale for the already-selected branch.
function clearSelectedEdge(jukebox: NonNullable<AppContext["jukebox"]>) {
  useAppStore.setState({ selectedEdge: null });
  jukebox.setSelectedEdge(null);
  syncExtrasPopup(null);
}

export function applyExtrasAndSync(
  context: AppContext,
  values: ExtrasFormValues,
): ExtrasApplyResult {
  const result = applyExtrasChanges(context, values);
  if (result.branchStatsChanged) {
    syncExtrasPopup(useAppStore.getState().selectedEdge);
  }
  return result;
}

export function deleteSelectedBranch(): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { engine, jukebox } = context;
    const { selectedEdge } = useAppStore.getState();
    if (!selectedEdge || selectedEdge.deleted) {
      return;
    }
    // Deleting the custom anchor's edge resets the anchor; the toast says which.
    const resetsAnchor = isCustomAnchorEdge(selectedEdge);
    engine.deleteEdge(selectedEdge);
    engine.rebuildGraph();
    useAppStore.setState({ vizData: engine.getVisualizationData() });
    const data = useAppStore.getState().vizData;
    if (data) {
      jukebox.setData(data);
    }
    jukebox.refresh();
    jukebox.resizeActive();
    syncDeletedEdgeState(context);
    updateTrackInfo(context);
    writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
    clearSelectedEdge(jukebox);
    syncPredictedJumps(context);
    showToast(
      resetsAnchor ? i18n.t("playback.anchorReset") : i18n.t("playback.branchDeleted"),
    );
  }

export function initializePlayback(): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { autocanonizer, engine, jukebox, player, wubmachine } = context;
    setPlayMode("jukebox");
    setBringItHomeMode(useAppStore.getState().bringItHomeMode);
    syncExtrasPopup(null);

    const storedViz = localStorage.getItem(VIZ_STORAGE_KEY);
    if (storedViz) {
      const parsed = Number.parseInt(storedViz, 10);
      if (Number.isFinite(parsed)) {
        setActiveVisualization(parsed);
      }
    }
    const storedCanonizerFinish = localStorage.getItem(CANONIZER_FINISH_KEY);
    const finishOutSong = storedCanonizerFinish === "true";
    autocanonizer.setFinishOutSong(finishOutSong);

    player.setOnEnded(() => {
      if (!useAppStore.getState().isRunning) {
        return;
      }
      if (useAppStore.getState().playMode === "jukebox" && !useAppStore.getState().bringItHomeMode) {
        // Recover if audio hits buffer end before scheduled wrap executes.
        startJukeboxFromBeat(context, 0);
        if (!player.isPlaying()) {
          engine.play();
        }
        return;
      }
      stopPlayback(context);
    });

    autocanonizer.setOnBeat((index, beat, cursorTimes) => {
      useAppStore.setState({
        beatsPlayedText: `${index + 1}`,
        lastBeatIndex: index,
        autocanonizerMainSeconds: cursorTimes.mainSeconds,
        autocanonizerOtherSeconds: cursorTimes.otherSeconds,
        autocanonizerPinkSeconds: cursorTimes.pinkSeconds ?? 0,
        autocanonizerGoldSeconds: cursorTimes.goldSeconds ?? 0,
      });
      pulseVizStats(index, beat);
      context.metronomeOverlay.handleBeatEnter(
        index,
        beat ?? undefined,
        isBpmBarDownbeat(
          buildBpmBarTimeSignatureInputFromStore(),
          index,
          beat ?? null,
          null,
        ),
      );
      updateLiveBpmForBeat(beat, { beatIndex: index, playbackRate: 1 });
    });

    context.songsync?.setOnBeat((snapshot) => {
      const idx = snapshot.masterBeatIndex;
      useAppStore.setState({
        beatsPlayedText: `${idx + 1}`,
        lastBeatIndex: idx,
        songSyncTrackSeconds: snapshot.trackSeconds,
      });
      pulseVizStats(idx, snapshot.masterBeat);
      context.metronomeOverlay.handleBeatEnter(
        idx,
        snapshot.masterBeat ?? undefined,
        isBpmBarDownbeat(
          buildBpmBarTimeSignatureInputFromStore(),
          idx,
          snapshot.masterBeat ?? null,
          null,
        ),
      );
      updateLiveBpmForBeat(snapshot.masterBeat, {
        beatIndex: idx,
        playbackRate: 1,
      });
    });
    context.songsync?.setOnEnded(() => {
      if (!useAppStore.getState().isRunning) {
        return;
      }
      stopPlayback(context);
    });
    context.songsync?.setOnSelect((masterBeatIndex) => {
      if (useAppStore.getState().playMode !== "songsync") {
        return;
      }
      startSongSyncPlayback(context, masterBeatIndex, { resetSession: false });
    });
    // A track that plays to its end hands over to the next playlist track.
    const handleLinearTrackEnded = () => {
      if (!useAppStore.getState().isRunning) {
        return;
      }
      if (useAppStore.getState().autocanonizerMixEnabled) {
        stopPlayback(context);
        return;
      }
      advancePlaylistOnAutocanonizerEnded()
        .then((advanced) => {
          if (!advanced && useAppStore.getState().isRunning) {
            stopPlayback(context);
          }
        })
        .catch((err) => {
          console.warn(`Playlist advance failed: ${String(err)}`);
          if (useAppStore.getState().isRunning) {
            stopPlayback(context);
          }
        });
    };
    autocanonizer.setOnEnded(handleLinearTrackEnded);
    autocanonizer.setOnSelect((index) => {
      if (useAppStore.getState().playMode !== "autocanonizer") {
        return;
      }
      startAutocanonizerPlayback(context, index, { resetSession: false });
    });

    wubmachine.setLoop(localStorage.getItem(WUB_MACHINE_LOOP_KEY) === "true");
    wubmachine.setOnTick((seconds) => {
      // Fires every frame; the display only changes once a second.
      const wubMachineSeconds = Math.floor(seconds);
      if (useAppStore.getState().wubMachineSeconds !== wubMachineSeconds) {
        useAppStore.setState({ wubMachineSeconds });
      }
    });
    wubmachine.setOnEnded(handleLinearTrackEnded);
    wubmachine.setOnSelect((seconds) => {
      if (useAppStore.getState().playMode !== "wubmachine") {
        return;
      }
      startWubMachinePlayback(context, seconds, { resetSession: false });
    });

    engine.onUpdate((engineState) => {
      // onUpdate fires every engine tick (~20Hz); only write when the counter
      // actually advances so we don't churn the store and wake subscribers on
      // every tick.
      const beatsPlayedText = `${engineState.beatsPlayed}`;
      const branchChanceText = `${Math.round(engineState.curRandomBranchChance * 100)}%`;
      const { currentSeconds: jukeboxCurrentSeconds, durationSec } =
        resolvePlaybackCursorTiming(
          context.player.getCurrentTime() || 0,
          engineState.currentBeatIndex,
        );
      const prev = useAppStore.getState();
      if (
        prev.beatsPlayedText !== beatsPlayedText ||
        prev.branchChanceText !== branchChanceText ||
        prev.jukeboxCurrentSeconds !== jukeboxCurrentSeconds ||
        prev.trackDurationSec !== durationSec
      ) {
        useAppStore.setState({
          beatsPlayedText,
          branchChanceText,
          jukeboxCurrentSeconds,
          trackDurationSec: durationSec,
        });
      }
      if (engineState.currentBeatIndex >= 0) {
        if (engineState.beatsPlayed !== lastCowbellBeatsPlayed) {
          lastCowbellBeatsPlayed = engineState.beatsPlayed;
          const vizBeats = useAppStore.getState().vizData?.beats;
          const beat = vizBeats?.[engineState.currentBeatIndex];
          pulseVizStats(engineState.currentBeatIndex, beat);
          updateLiveBpmForBeat(beat, {
            beats: vizBeats,
            beatIndex: engineState.currentBeatIndex,
            playbackRate: context.player.getPlaybackRate?.(),
          });
          if (beat) {
            context.cowbellOverlay.handleBeatEnter(
              engineState.currentBeatIndex,
              beat,
              vizBeats?.[engineState.currentBeatIndex + 1],
            );
            context.metronomeOverlay.handleBeatEnter(
              engineState.currentBeatIndex,
              beat,
              isBpmBarDownbeat(
                buildBpmBarTimeSignatureInputFromStore(),
                engineState.currentBeatIndex,
                beat,
                vizBeats,
              ),
            );
          }
        }
        const lastBeatIndex = useAppStore.getState().lastBeatIndex;
        const highlightJump =
          engineState.lastJumped && engine.getLastJumpWasBranch();
        const jumpFrom =
          highlightJump && engineState.lastJumpFromIndex !== null
            ? engineState.lastJumpFromIndex
            : lastBeatIndex;
        const jumpTo =
          highlightJump && typeof engineState.lastJumpToIndex === "number"
            ? engineState.lastJumpToIndex
            : engineState.currentBeatIndex;
        jukebox.update(jumpTo, highlightJump, jumpFrom);
        if (jumpTo !== engineState.currentBeatIndex) {
          jukebox.update(engineState.currentBeatIndex, false, jumpTo);
        }
        if (lastBeatIndex !== engineState.currentBeatIndex) {
          useAppStore.setState({ lastBeatIndex: engineState.currentBeatIndex });
        }
      }
      syncPredictedJumps(context);
    });
  }

  function setBringItHomeMode(enabled: boolean) {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { engine } = context;
    useAppStore.setState({ bringItHomeMode: enabled });
    engine.setBringItHomeMode(enabled);
    if (enabled && useAppStore.getState().shiftBranching) {
      useAppStore.setState({ shiftBranching: false });
      engine.setForceBranch(false);
    }
    syncPredictedJumps(context);
  }

export function setCanonizerFinish(checked: boolean): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { autocanonizer } = context;
    localStorage.setItem(CANONIZER_FINISH_KEY, String(checked));
    autocanonizer.setFinishOutSong(checked);
  }

export function setWubMachineLoop(checked: boolean): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    localStorage.setItem(WUB_MACHINE_LOOP_KEY, String(checked));
    context.wubmachine.setLoop(checked);
  }

  function selectAdjacentBranch(direction: -1 | 1) {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { jukebox } = context;
    if (!useAppStore.getState().selectedEdge) {
      return;
    }
    const edges = (useAppStore.getState().vizData?.edges ?? []).filter((edge) => !edge.deleted);
    if (edges.length === 0) {
      return;
    }
    const currentIndex = edges.findIndex(
      (edge) => edge.id === useAppStore.getState().selectedEdge?.id,
    );
    let nextIndex: number;
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + direction + edges.length) % edges.length;
    } else {
      nextIndex = direction > 0 ? 0 : edges.length - 1;
    }
    const nextEdge = edges[nextIndex];
    useAppStore.setState({ selectedEdge: nextEdge });
    jukebox.setSelectedEdgeActive(nextEdge);
    syncExtrasPopup(nextEdge);
  }

  function toggleSelectedAnchorBranch() {
    const context = getAttachedAppContext();
    if (!context) {
      return false;
    }
    const { engine, jukebox } = context;
    let edge = useAppStore.getState().selectedEdge;
    if (!edge || edge.deleted) {
      return false;
    }
    if (edge.dest.which >= edge.src.which) {
      // In layouts that draw a twin pair as one arc, a click may have
      // grabbed the forward one; in layouts that draw the two directions
      // apart, a forward selection is deliberate and gets no redirect.
      const { activeVizIndex, vizData } = useAppStore.getState();
      const twin = visualizationSeparatesPairedEdges(activeVizIndex)
        ? null
        : findBackwardTwin(vizData?.edges ?? [], edge);
      if (!twin) {
        showToast(i18n.t("playback.anchorRequiresBackward"));
        return false;
      }
      edge = twin;
      useAppStore.setState({ selectedEdge: twin });
      syncExtrasPopup(twin);
    }
    const nextAnchor = engine.getUserAnchorEdgeId() === edge.id ? null : edge;
    engine.setUserAnchorEdge(nextAnchor);
    useAppStore.setState({ vizData: engine.getVisualizationData() });
    const data = useAppStore.getState().vizData;
    if (data) {
      jukebox.setData(data);
    }
    // Unpinning a branch the tuning filters out removes it from the viz, so the selection is cleared.
    if (data && !data.edges.includes(edge)) {
      clearSelectedEdge(jukebox);
    } else {
      jukebox.setSelectedEdgeActive(edge);
    }
    const tuningParams = getTuningParamsFromEngine(context);
    const result = serializeParams(tuningParams);
    useAppStore.setState({ tuningParams: result.length > 0 ? result : null });
    writeTuningParamsToUrl(useAppStore.getState().tuningParams, true);
    syncPredictedJumps(context);
    showToast(
      nextAnchor ? i18n.t("playback.anchorSet") : i18n.t("playback.anchorReset"),
    );
    return true;
  }

// Arrows nudge the selected end (Shift moves a bar); Escape or Enter closes the editor.
function handleCustomAnchorKeydown(context: AppContext, event: KeyboardEvent): boolean {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    nudgeCustomAnchor(context, event.key === "ArrowRight" ? 1 : -1, event.shiftKey);
    return true;
  }
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault();
    exitCustomAnchorEdit(context);
    return true;
  }
  // Shift is the bar modifier here, so it must not start force-branching.
  return event.key === "Shift";
}

export function handleKeydown(event: KeyboardEvent): void {
    if (useAppStore.getState().activeTabId !== "play") {
      return;
    }
    if (
      useAppStore.getState().deleteConfirmOpen ||
      useAppStore.getState().renameModalOpen
    ) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { engine } = context;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback(context);
      return;
    }
    if (
      useAppStore.getState().playMode === "jukebox" &&
      (event.key === "e" || event.key === "E") &&
      !event.repeat
    ) {
      event.preventDefault();
      openExtras(context);
      return;
    }
    if (useAppStore.getState().playMode !== "jukebox") {
      return;
    }
    if (
      useAppStore.getState().customAnchorEdit &&
      handleCustomAnchorKeydown(context, event)
    ) {
      return;
    }
    if ((event.key === "h" || event.key === "H") && !event.repeat) {
      event.preventDefault();
      const enabled = !useAppStore.getState().bringItHomeMode;
      setBringItHomeMode(enabled);
      trackModeEnabled("bring_it_home_mode", !enabled, enabled, { ui_source: "hotkey" });
      showToast(
        enabled
          ? i18n.t("playback.bringHomeEnabled")
          : i18n.t("playback.bringHomeDisabled"),
      );
      return;
    }
    if ((event.key === "a" || event.key === "A") && !event.repeat) {
      if (toggleSelectedAnchorBranch()) {
        event.preventDefault();
      }
      return;
    }
    // Match brackets by typed character first, then by physical key
    // position so layouts without direct bracket keys still work.
    let bracketDirection = 0;
    if (event.key === "[") {
      bracketDirection = -1;
    } else if (event.key === "]") {
      bracketDirection = 1;
    } else if (event.code === "BracketLeft") {
      bracketDirection = -1;
    } else if (event.code === "BracketRight") {
      bracketDirection = 1;
    }
    if (bracketDirection !== 0) {
      event.preventDefault();
      const direction = bracketDirection;
      const velocity = engine.getPlayVelocity() + direction;
      engine.setPlayVelocity(velocity);
      syncPredictedJumps(context);
      showToast(
        i18n.t("playback.playVelocity", {
          value: formatPlayVelocity(engine.getPlayVelocity()),
        }),
        { key: "play-velocity" },
      );
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      engine.setPlayVelocity(0);
      syncPredictedJumps(context);
      showToast(i18n.t("playback.playVelocity", { value: "0" }), {
        key: "play-velocity",
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      engine.setPlayVelocity(1);
      syncPredictedJumps(context);
      showToast(i18n.t("playback.playVelocity", { value: "+1" }), {
        key: "play-velocity",
      });
      return;
    }
    if (event.key === "Control") {
      event.preventDefault();
      engine.setFreezeCurrentBeat(true);
      useAppStore.setState({ freezeBeat: true });
      syncPredictedJumps(context);
      return;
    }
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      useAppStore.getState().selectedEdge
    ) {
      event.preventDefault();
      selectAdjacentBranch(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    const { selectedEdge } = useAppStore.getState();
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selectedEdge &&
      !selectedEdge.deleted
    ) {
      event.preventDefault();
      deleteSelectedBranch();
      return;
    }
    if (
      event.key === "Shift" &&
      useAppStore.getState().isRunning &&
      !useAppStore.getState().shiftBranching &&
      !useAppStore.getState().bringItHomeMode
    ) {
      useAppStore.setState({ shiftBranching: true });
      engine.setForceBranch(true);
      syncPredictedJumps(context);
    }
  }

export function handleKeyup(event: KeyboardEvent): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { engine } = context;
    if (event.key === "Control") {
      engine.setFreezeCurrentBeat(false);
      useAppStore.setState({ freezeBeat: false });
      syncPredictedJumps(context);
    }
    if (useAppStore.getState().playMode !== "jukebox") {
      return;
    }
    if (event.key === "Shift" && useAppStore.getState().shiftBranching) {
      useAppStore.setState({ shiftBranching: false });
      engine.setForceBranch(false);
      syncPredictedJumps(context);
    }
  }

export function handleWindowBlur(): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    context.engine.setFreezeCurrentBeat(false);
    useAppStore.setState({ freezeBeat: false });
    if (useAppStore.getState().shiftBranching) {
      useAppStore.setState({ shiftBranching: false });
      context.engine.setForceBranch(false);
    }
    syncPredictedJumps(context);
  }

export function handleBeatSelect(index: number): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { jukebox } = context;
    if (useAppStore.getState().playMode !== "jukebox") {
      return;
    }
    const { vizData } = useAppStore.getState();
    if (!vizData) {
      return;
    }
    const beat = vizData.beats[index];
    if (!beat) {
      return;
    }
    startJukeboxFromBeat(context, index);
    const { currentSeconds: jukeboxCurrentSeconds, durationSec } =
      resolvePlaybackCursorTiming(beat.start, index);
    useAppStore.setState({
      jukeboxCurrentSeconds,
      trackDurationSec: durationSec,
    });
    jukebox.update(index, true, null);
  }

export function handleEdgeSelect(edge: Edge | null): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { jukebox } = context;
    if (useAppStore.getState().playMode !== "jukebox") {
      return;
    }
    useAppStore.setState({ selectedEdge: edge });
    jukebox.setSelectedEdgeActive(edge);
    syncExtrasPopup(edge);
  }

export function copyShortUrl(): void {
    void copyShortUrlInternal();
  }

  async function copyShortUrlInternal() {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const trackId = useAppStore.getState().lastTrackId ?? useAppStore.getState().lastJobId;
    if (!trackId) {
      setAnalysisStatus(
        context,
        () => i18n.t("playback.selectTrackForUrl"),
      );
      return;
    }
    const url = new URL(
      `${window.location.origin}/listen/${encodeURIComponent(trackId)}`,
    );
    if (useAppStore.getState().playMode === "jukebox") {
      const tuningParams = getTuningParamsFromEngine(context);
      tuningParams.forEach((value, key) => {
        url.searchParams.set(key, value);
      });
    }
    const { playMode } = useAppStore.getState();
    if (playMode !== "jukebox") {
      url.searchParams.set("mode", playMode);
    }
    const shortUrl = url.toString();
    try {
      await navigator.clipboard.writeText(shortUrl);
      trackEvent("share", { track_id: trackId });
      showToast(i18n.t("status.linkCopied"));
    } catch (err) {
      setAnalysisStatus(
        context,
        () => i18n.t("status.copyFailed", { error: formatErrorForDisplay(err) }),
      );
    }
  }

export function setActiveVisualization(index: number): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { jukebox } = context;
    const count = jukebox.getCount();
    if (index < 0 || index >= count) {
      return;
    }
    if (index === useAppStore.getState().activeVizIndex) {
      return;
    }
    useAppStore.setState({ activeVizIndex: index });
    jukebox.setActiveIndex(index);
    localStorage.setItem(VIZ_STORAGE_KEY, String(useAppStore.getState().activeVizIndex));
  }

  function getPlayModeFromUrl(): PlayMode {
    const mode = new URLSearchParams(window.location.search).get("mode");
    return mode === "autocanonizer" || mode === "songsync" || mode === "wubmachine"
      ? mode
      : "jukebox";
  }

export function applyModeFromUrl(): void {
    setPlayMode(getPlayModeFromUrl());
  }

export function setPlayMode(mode: PlayMode): void {
    const context = getAttachedAppContext();
    if (!context) {
      return;
    }
    const { autocanonizer, jukebox, wubmachine } = context;
    const prevMode = useAppStore.getState().playMode;
    if (prevMode === mode) {
      return;
    }
    if (useAppStore.getState().isRunning || useAppStore.getState().isPaused) {
      stopPlayback(context);
    }
    context.cowbellOverlay.cancelScheduledHits();
    context.metronomeOverlay.cancelScheduledHits();
    cancelWubMachineRender();
    useAppStore.setState({
      playMode: mode,
      autocanonizerMainSeconds: 0,
      autocanonizerOtherSeconds: 0,
      autocanonizerPinkSeconds: 0,
      autocanonizerGoldSeconds: 0,
    });
    resetLiveBpm();
    if (prevMode === "autocanonizer" && useAppStore.getState().autocanonizerMixEnabled) {
      void disableAutocanonizerMix(context);
    } else if (prevMode === "jukebox" && useAppStore.getState().multiTrackEnabled) {
      void disableMultiTrackMix(context);
    } else if (prevMode === "songsync" && useAppStore.getState().songSyncEnabled) {
      void disableSongSyncMix(context);
    }
    if (mode !== "jukebox") {
      // The extras tab disappears outside jukebox mode, so force the stored
      // tab back to "tuning".
      useAppStore.setState({ tuningModalTab: "tuning" });
      exitCustomAnchorEdit(context);
    }
    autocanonizer.setVisible(mode === "autocanonizer");
    context.songsync?.setVisible(mode === "songsync");
    wubmachine.setVisible(mode === "wubmachine");
    jukebox.setVisible(mode === "jukebox");
    if (mode === "songsync") {
      const playlistCount = useAppStore.getState().playlist.tracks.length;
      if (playlistCount >= 2) {
        void loadSongSyncMix(context);
      } else {
        useAppStore.setState({ playlistAddSticky: true });
        showToast(i18n.t("playback.songSyncNeedPlaylist"));
      }
    }
    syncPredictedJumps(context);
    maybePrepareWubMachine(context);
    syncExtrasPopup(useAppStore.getState().selectedEdge);
    if (useAppStore.getState().activeTabId === "play") {
      const currentId = getCurrentTrackId();
      if (currentId) {
        useAppStore
          .getState()
          .navigateToTrackWithState(currentId, { replace: true });
      } else {
        useAppStore.getState().navigateToTabWithState("play", {
          replace: true,
        });
      }
    }
    updateVizVisibility();
  }
