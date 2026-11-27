import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LyricsLine } from "@forever-jukebox/shared/lyrics";
import { useLyricsSync } from "../../hooks/useLyricsSync";
import {
  adjustLyricsOffset,
  isLyricsSupportedMode,
  loadLyricsForCurrentTrack,
  resetLyricsOffset,
  setLyricsPanelOpen,
  setLyricsRomanizationEnabled,
} from "../../lyrics";
import { startAutocanonizerPlayback, syncPredictedJumps } from "../../playback";
import { getAppContext } from "../../runtime";
import { useAppStore } from "../../store";
import { getDisplayLineText, renderSyncedLyricsLine } from "./LyricsSyllables";

const MANUAL_SCROLL_PAUSE_MS = 4000;

function formatSignedOffset(offsetSec: number): string {
  const formatted = Math.abs(offsetSec).toFixed(1);
  if (offsetSec > 0) {
    return `+${formatted}s`;
  }
  if (offsetSec < 0) {
    return `-${formatted}s`;
  }
  return "0.0s";
}

/**
 * Collapsible left-side scrollable lyrics panel for Jukebox and single-song
 * Autocanonizer modes. Supports color-coded dual-voice highlighting, click-to-seek,
 * and per-track offset nudging.
 */
export function LyricsPanel() {
  const { t } = useTranslation();
  const activeTabId = useAppStore((s) => s.activeTabId);
  const appConfig = useAppStore((s) => s.appConfig);
  const playMode = useAppStore((s) => s.playMode);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
  const audioLoaded = useAppStore((s) => s.audioLoaded);
  const analysisLoaded = useAppStore((s) => s.analysisLoaded);
  const lyricsPanelOpen = useAppStore((s) => s.lyricsPanelOpen);
  const lyricsRomanizationEnabled = useAppStore(
    (s) => s.lyricsRomanizationEnabled,
  );
  const lyricsStatus = useAppStore((s) => s.lyricsStatus);
  const lyricsData = useAppStore((s) => s.lyricsData);
  const lyricsOffsetSec = useAppStore((s) => s.lyricsOffsetSec);
  const trackTitle = useAppStore((s) => s.trackTitle);
  const trackArtist = useAppStore((s) => s.trackArtist);

  const sync = useLyricsSync();
  const isCanonizer = sync.mode === "autocanonizer";
  const [collapsed, setCollapsed] = useState(false);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);
  const manualScrollUntilRef = useRef<number>(0);

  const mounted = Boolean(
    activeTabId === "play" &&
      appConfig?.allow_lyrics &&
      isLyricsSupportedMode({
        playMode,
        multiTrackEnabled,
        autocanonizerMixEnabled,
      }) &&
      audioLoaded &&
      analysisLoaded &&
      lyricsPanelOpen,
  );

  // Re-opening the panel from the toolbar always reveals its contents.
  useEffect(() => {
    if (lyricsPanelOpen) {
      setCollapsed(false);
    }
  }, [lyricsPanelOpen]);

  const scrollTargetIndex = isCanonizer
    ? sync.canonizer.main.activeLineIndex >= 0
      ? sync.canonizer.main.activeLineIndex
      : sync.canonizer.other.activeLineIndex
    : sync.karaoke.activeLineIndex;

  // Auto-scroll active lyric line into view unless the user scrolled recently.
  useEffect(() => {
    if (!mounted || collapsed || scrollTargetIndex < 0) {
      return;
    }
    if (Date.now() < manualScrollUntilRef.current) {
      return;
    }
    activeLineRef.current?.scrollIntoView?.({
      block: "center",
      behavior: "smooth",
    });
  }, [mounted, collapsed, scrollTargetIndex]);

  if (!mounted) {
    return null;
  }

  const pauseAutoScroll = () => {
    manualScrollUntilRef.current = Date.now() + MANUAL_SCROLL_PAUSE_MS;
  };

  const handleSeekLine = (line: LyricsLine) => {
    if (line.startTime === null) {
      return;
    }
    const targetSec = Math.max(0, line.startTime - lyricsOffsetSec);
    const ctx = getAppContext();
    if (isCanonizer) {
      const beatIdx = ctx.autocanonizer?.findBeatIndexByTime?.(targetSec) ?? -1;
      if (beatIdx >= 0) {
        startAutocanonizerPlayback(ctx, beatIdx, { resetSession: false });
      }
      return;
    }
    if (!ctx.player || !ctx.engine) {
      return;
    }
    ctx.player.seek(targetSec);
    ctx.engine.syncToPlaybackPosition();
    const beat = ctx.engine.getBeatAtTime(targetSec);
    if (beat) {
      ctx.jukebox?.update(beat.which, true, null);
      useAppStore.setState({ lastBeatIndex: beat.which });
    }
    useAppStore.setState({
      jukeboxCurrentSeconds: Math.floor(targetSec),
    });
    syncPredictedJumps(ctx);
  };

  const hasTransliterations = Boolean(lyricsData?.hasTransliterations);
  const useRomanized = Boolean(
    lyricsRomanizationEnabled && hasTransliterations,
  );

  const syncBadgeLabel =
    lyricsData?.type === "syllable"
      ? t("lyrics.syllableBadge")
      : lyricsData?.type === "line"
        ? t("lyrics.lineBadge")
        : lyricsData?.type === "static"
          ? t("lyrics.unsyncedBadge")
          : null;

  return (
    <aside
      id="lyrics-side-panel"
      className={`lyrics-side-panel${collapsed ? " is-collapsed" : ""}`}
      aria-label={t("lyrics.title")}
    >
      <button
        type="button"
        id="lyrics-panel-collapse-tab"
        className="lyrics-side-panel-tab"
        aria-label={collapsed ? t("lyrics.expand") : t("lyrics.collapse")}
        title={collapsed ? t("lyrics.expand") : t("lyrics.collapse")}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {collapsed ? "chevron_right" : "chevron_left"}
        </span>
      </button>

      <div className="lyrics-panel-header">
        <div className="lyrics-panel-heading">
          <span className="material-symbols-outlined lyrics-panel-icon" aria-hidden="true">
            lyrics
          </span>
          <div className="lyrics-panel-title-wrap">
            <h2 className="lyrics-panel-title">{t("lyrics.title")}</h2>
            {trackTitle ? (
              <div
                className="lyrics-panel-subtitle"
                title={`${trackTitle}${trackArtist ? ` — ${trackArtist}` : ""}`}
              >
                {trackTitle}
                {trackArtist ? ` — ${trackArtist}` : ""}
              </div>
            ) : null}
          </div>
        </div>
        <div className="lyrics-panel-header-actions">
          {syncBadgeLabel ? (
            <span className="lyrics-sync-badge">{syncBadgeLabel}</span>
          ) : null}
          <button
            type="button"
            id="lyrics-panel-refresh"
            className="lyrics-panel-icon-btn"
            aria-label={t("lyrics.refresh")}
            title={t("lyrics.refresh")}
            onClick={() => void loadLyricsForCurrentTrack({ refresh: true })}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              refresh
            </span>
          </button>
          <button
            type="button"
            id="lyrics-panel-close"
            className="lyrics-panel-icon-btn"
            aria-label={t("lyrics.close")}
            title={t("lyrics.close")}
            onClick={() => setLyricsPanelOpen(false)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      </div>

      {lyricsData && lyricsData.type !== "static" ? (
        <div className="lyrics-panel-offset-bar" role="group" aria-label={t("lyrics.offset")}>
          <span className="lyrics-panel-offset-label">{t("lyrics.offset")}</span>
          <div className="lyrics-panel-offset-controls">
            <button
              type="button"
              className="lyrics-offset-btn"
              aria-label={t("lyrics.offsetDecrease")}
              onClick={() => adjustLyricsOffset(-0.5)}
            >
              -0.5s
            </button>
            <button
              type="button"
              className="lyrics-offset-btn"
              aria-label={t("lyrics.offsetDecrease")}
              onClick={() => adjustLyricsOffset(-0.1)}
            >
              -0.1s
            </button>
            <button
              type="button"
              className="lyrics-offset-value"
              aria-label={t("lyrics.offsetReset")}
              title={t("lyrics.offsetReset")}
              onClick={() => resetLyricsOffset()}
            >
              {formatSignedOffset(lyricsOffsetSec)}
            </button>
            <button
              type="button"
              className="lyrics-offset-btn"
              aria-label={t("lyrics.offsetIncrease")}
              onClick={() => adjustLyricsOffset(0.1)}
            >
              +0.1s
            </button>
            <button
              type="button"
              className="lyrics-offset-btn"
              aria-label={t("lyrics.offsetIncrease")}
              onClick={() => adjustLyricsOffset(0.5)}
            >
              +0.5s
            </button>
          </div>
        </div>
      ) : null}

      {lyricsData && lyricsData.lines.length > 0 ? (
        <div className="lyrics-panel-options-bar">
          <button
            type="button"
            id="lyrics-romanization-toggle"
            className={`lyrics-romanize-toggle${useRomanized ? " is-active" : ""}`}
            aria-pressed={useRomanized}
            disabled={!hasTransliterations}
            title={
              hasTransliterations
                ? t("lyrics.romanizeToggle")
                : t("lyrics.romanizeUnavailable")
            }
            onClick={() =>
              setLyricsRomanizationEnabled(!lyricsRomanizationEnabled)
            }
          >
            <span className="lyrics-romanize-label">{t("lyrics.romanize")}</span>
            <span className="lyrics-romanize-switch" aria-hidden="true">
              <span className="lyrics-romanize-thumb" />
            </span>
          </button>
        </div>
      ) : null}

      {isCanonizer && lyricsData && lyricsData.type !== "static" ? (
        <div className="lyrics-panel-legend">
          <span className="lyrics-legend-item">
            <span className="lyrics-voice-dot is-main" aria-hidden="true" />
            <span>{t("lyrics.canonMain")}</span>
          </span>
          <span className="lyrics-legend-item">
            <span className="lyrics-voice-dot is-other" aria-hidden="true" />
            <span>{t("lyrics.canonOther")}</span>
          </span>
        </div>
      ) : null}

      <div
        className="lyrics-panel-body"
        onWheel={pauseAutoScroll}
        onTouchMove={pauseAutoScroll}
        onPointerDown={pauseAutoScroll}
      >
        {lyricsStatus === "loading" ? (
          <div className="lyrics-panel-empty">{t("lyrics.loading")}</div>
        ) : lyricsStatus === "not_found" ? (
          <div className="lyrics-panel-empty">{t("lyrics.notFound")}</div>
        ) : lyricsStatus === "error" ? (
          <div className="lyrics-panel-empty">{t("lyrics.error")}</div>
        ) : !lyricsData || lyricsData.lines.length === 0 ? (
          <div className="lyrics-panel-empty">{t("lyrics.noTrack")}</div>
        ) : (
          <div className="lyrics-panel-lines">
            {lyricsData.lines.map((line) => {
              const isTimed = line.startTime !== null;
              const isMain =
                isTimed &&
                isCanonizer &&
                sync.canonizer.main.activeLineIndex === line.index;
              const isOther =
                isTimed &&
                isCanonizer &&
                sync.canonizer.other.activeLineIndex === line.index;
              const isBoth = isMain && isOther;
              const isActive = isCanonizer
                ? isMain || isOther
                : isTimed && sync.karaoke.activeLineIndex === line.index;
              const isPast =
                isTimed &&
                !isActive &&
                scrollTargetIndex >= 0 &&
                line.index < scrollTargetIndex;
              const isBranchTarget =
                isTimed &&
                !isCanonizer &&
                sync.karaoke.isBranchPreview &&
                sync.karaoke.nextLineIndex === line.index;

              const voiceClass = isBoth
                ? "is-canon-both lyrics-voice-main"
                : isMain
                  ? "is-canon-main lyrics-voice-main"
                  : isOther
                    ? "is-canon-other lyrics-voice-other"
                    : "";

              const className = [
                "lyrics-panel-line",
                isTimed ? "is-timed" : "is-static",
                isActive ? "is-active" : "",
                voiceClass,
                isPast ? "is-past" : "",
                isBranchTarget ? "is-branch-target" : "",
                line.oppositeAligned ? "is-opposite" : "",
              ]
                .filter(Boolean)
                .join(" ");

              if (!isTimed) {
                return (
                  <div key={line.index} className={className}>
                    {getDisplayLineText(line, useRomanized)}
                  </div>
                );
              }

              const activeSylIndex = isCanonizer
                ? isMain
                  ? sync.canonizer.main.activeSyllableIndex
                  : sync.canonizer.other.activeSyllableIndex
                : sync.karaoke.activeSyllableIndex;
              const activeSylProgress = isCanonizer
                ? isMain
                  ? sync.canonizer.main.activeSyllableProgress
                  : sync.canonizer.other.activeSyllableProgress
                : sync.karaoke.activeSyllableProgress;

              return (
                <button
                  key={line.index}
                  ref={scrollTargetIndex === line.index ? activeLineRef : undefined}
                  type="button"
                  className={className}
                  title={t("lyrics.seekToLine")}
                  onClick={() => handleSeekLine(line)}
                >
                  {isBranchTarget ? (
                    <span
                      className="lyrics-branch-badge"
                      title={t("lyrics.branchNext")}
                      aria-label={t("lyrics.branchNext")}
                    >
                      ↳
                    </span>
                  ) : null}
                  {isMain || isOther ? (
                    <span className="lyrics-voice-dots" aria-hidden="true">
                      {isMain ? <span className="lyrics-voice-dot is-main" /> : null}
                      {isOther ? <span className="lyrics-voice-dot is-other" /> : null}
                    </span>
                  ) : null}
                  <span>
                    {isActive
                      ? renderSyncedLyricsLine(
                          line,
                          activeSylIndex,
                          activeSylProgress,
                          useRomanized,
                        )
                      : getDisplayLineText(line, useRomanized)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {lyricsData?.songWriters && lyricsData.songWriters.length > 0 ? (
        <div className="lyrics-panel-footer">
          {t("lyrics.attribution", {
            writers: lyricsData.songWriters.join(", "),
          })}
        </div>
      ) : null}
    </aside>
  );
}
