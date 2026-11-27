import { useEffect, useRef, useState } from "react";
import {
  EMPTY_AUTOCANONIZER_LYRICS_STATE,
  resolveAutocanonizerLyricsState,
  resolveKaraokeState,
  type AutocanonizerLyricsState,
  type KaraokeDisplayState,
  type LyricsVoiceCursor,
} from "@forever-jukebox/shared/lyrics";
import { isLyricsSupportedMode, loadLyricsForCurrentTrack } from "../lyrics";
import { getAppContext } from "../runtime";
import { useAppStore } from "../store";

const INITIAL_KARAOKE_STATE: KaraokeDisplayState = {
  activeLine: null,
  activeLineIndex: -1,
  activeSyllableIndex: -1,
  activeSyllableProgress: 0,
  nextLine: null,
  nextLineIndex: -1,
  nextLineVisible: false,
  isBranchPreview: false,
  branchBeatsRemaining: null,
};

export interface LyricsSyncResult {
  mode: "jukebox" | "autocanonizer";
  karaoke: KaraokeDisplayState;
  canonizer: AutocanonizerLyricsState;
}

const INITIAL_SYNC_RESULT: LyricsSyncResult = {
  mode: "jukebox",
  karaoke: INITIAL_KARAOKE_STATE,
  canonizer: EMPTY_AUTOCANONIZER_LYRICS_STATE,
};

function quantizeProgress(value: number): number {
  return Math.round(value * 100) / 100;
}

function karaokeStatesMatch(
  a: KaraokeDisplayState,
  b: KaraokeDisplayState,
): boolean {
  return (
    a.activeLineIndex === b.activeLineIndex &&
    a.activeSyllableIndex === b.activeSyllableIndex &&
    quantizeProgress(a.activeSyllableProgress) ===
      quantizeProgress(b.activeSyllableProgress) &&
    a.nextLineIndex === b.nextLineIndex &&
    a.nextLineVisible === b.nextLineVisible &&
    a.isBranchPreview === b.isBranchPreview &&
    a.branchBeatsRemaining === b.branchBeatsRemaining &&
    a.activeLine === b.activeLine &&
    a.nextLine === b.nextLine
  );
}

function voiceCursorsMatch(a: LyricsVoiceCursor, b: LyricsVoiceCursor): boolean {
  return (
    a.activeLineIndex === b.activeLineIndex &&
    a.activeSyllableIndex === b.activeSyllableIndex &&
    quantizeProgress(a.activeSyllableProgress) ===
      quantizeProgress(b.activeSyllableProgress) &&
    a.activeLine === b.activeLine &&
    a.upcomingLineIndex === b.upcomingLineIndex &&
    a.upcomingLineVisible === b.upcomingLineVisible &&
    a.upcomingLine === b.upcomingLine
  );
}

function canonizerStatesMatch(
  a: AutocanonizerLyricsState,
  b: AutocanonizerLyricsState,
): boolean {
  return (
    voiceCursorsMatch(a.main, b.main) &&
    voiceCursorsMatch(a.other, b.other) &&
    a.inUnison === b.inUnison &&
    a.fallbackNextLineIndex === b.fallbackNextLineIndex &&
    a.fallbackNextLineVisible === b.fallbackNextLineVisible &&
    a.fallbackNextLine === b.fallbackNextLine
  );
}

function resultsMatch(a: LyricsSyncResult, b: LyricsSyncResult): boolean {
  return (
    a.mode === b.mode &&
    karaokeStatesMatch(a.karaoke, b.karaoke) &&
    canonizerStatesMatch(a.canonizer, b.canonizer)
  );
}

/**
 * Tracks live playback time in Jukebox and single-song Autocanonizer modes
 * to compute the synced lyric state at animation-frame cadence.
 */
export function useLyricsSync(): LyricsSyncResult {
  const appConfig = useAppStore((s) => s.appConfig);
  const playMode = useAppStore((s) => s.playMode);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
  const lyricsData = useAppStore((s) => s.lyricsData);
  const lyricsStatus = useAppStore((s) => s.lyricsStatus);
  const lastJobId = useAppStore((s) => s.lastJobId);
  const lyricsOffsetSec = useAppStore((s) => s.lyricsOffsetSec);
  const lyricsKaraokeEnabled = useAppStore((s) => s.lyricsKaraokeEnabled);
  const lyricsPanelOpen = useAppStore((s) => s.lyricsPanelOpen);
  const isRunning = useAppStore((s) => s.isRunning);
  const isPaused = useAppStore((s) => s.isPaused);
  const lastBeatIndex = useAppStore((s) => s.lastBeatIndex);
  const branchLookaheadCount = useAppStore((s) => s.branchLookaheadCount);
  const vizData = useAppStore((s) => s.vizData);
  const beatsPerBar = useAppStore((s) => s.metronomeDetectedBeatsPerBar);
  const autocanonizerMainSeconds = useAppStore(
    (s) => s.autocanonizerMainSeconds,
  );
  const autocanonizerOtherSeconds = useAppStore(
    (s) => s.autocanonizerOtherSeconds,
  );

  const [syncResult, setSyncResult] =
    useState<LyricsSyncResult>(INITIAL_SYNC_RESULT);
  const lastStateRef = useRef<LyricsSyncResult>(INITIAL_SYNC_RESULT);

  const supported = isLyricsSupportedMode({
    playMode,
    multiTrackEnabled,
    autocanonizerMixEnabled,
  });
  const activeUi = Boolean(
    appConfig?.allow_lyrics &&
      supported &&
      (lyricsKaraokeEnabled || lyricsPanelOpen),
  );

  // Trigger a lyrics lookup automatically when switching into a supported mode
  // if a lyrics view is already toggled on and no track fetch has run yet.
  useEffect(() => {
    if (activeUi && lyricsStatus === "idle" && lastJobId) {
      void loadLyricsForCurrentTrack();
    }
  }, [activeUi, lyricsStatus, lastJobId]);

  const syncActive = Boolean(
    activeUi && lyricsData && lyricsData.type !== "static",
  );
  const syncMode: "jukebox" | "autocanonizer" =
    playMode === "autocanonizer" ? "autocanonizer" : "jukebox";

  useEffect(() => {
    if (!syncActive) {
      const idle: LyricsSyncResult = {
        ...INITIAL_SYNC_RESULT,
        mode: syncMode,
      };
      if (!resultsMatch(lastStateRef.current, idle)) {
        lastStateRef.current = idle;
        setSyncResult(idle);
      }
      return;
    }

    const computeNextResult = (): LyricsSyncResult => {
      const ctx = getAppContext();
      if (syncMode === "autocanonizer") {
        const live = ctx.autocanonizer?.getLiveCursorTimes?.();
        const mainTimeSec = live
          ? live.mainSeconds
          : isPaused
            ? autocanonizerMainSeconds
            : null;
        const otherTimeSec = live
          ? live.otherSeconds
          : isPaused
            ? autocanonizerOtherSeconds
            : null;
        const inUnison = live ? live.inUnison : false;

        return {
          mode: "autocanonizer",
          karaoke: INITIAL_KARAOKE_STATE,
          canonizer: resolveAutocanonizerLyricsState({
            lyrics: lyricsData,
            mainTimeSec,
            otherTimeSec,
            offsetSec: lyricsOffsetSec,
            inUnison,
          }),
        };
      }

      const playbackTimeSec = ctx.player?.getCurrentTime?.() ?? 0;
      const engineBeat = ctx.engine?.getCurrentBeatIndex?.();
      const currentBeatIndex =
        typeof engineBeat === "number" && engineBeat >= 0
          ? engineBeat
          : (ctx.engine?.getBeatAtTime?.(playbackTimeSec)?.which ??
            lastBeatIndex ??
            -1);
      const nextJump =
        ctx.engine?.getPredictedJumps?.(Math.max(1, branchLookaheadCount))?.[0] ??
        null;

      return {
        mode: "jukebox",
        karaoke: resolveKaraokeState({
          lyrics: lyricsData,
          playbackTimeSec,
          offsetSec: lyricsOffsetSec,
          beats: vizData?.beats ?? [],
          currentBeatIndex,
          beatsPerBar: beatsPerBar || 4,
          nextJump,
        }),
        canonizer: EMPTY_AUTOCANONIZER_LYRICS_STATE,
      };
    };

    const applySync = () => {
      const next = computeNextResult();
      if (!resultsMatch(lastStateRef.current, next)) {
        lastStateRef.current = next;
        setSyncResult(next);
      }
    };

    applySync();

    if (!isRunning) {
      return;
    }

    let rafId = 0;
    const tick = () => {
      applySync();
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    syncActive,
    syncMode,
    lyricsData,
    lyricsOffsetSec,
    isRunning,
    isPaused,
    lastBeatIndex,
    branchLookaheadCount,
    vizData,
    beatsPerBar,
    autocanonizerMainSeconds,
    autocanonizerOtherSeconds,
  ]);

  return syncResult;
}
