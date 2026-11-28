import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LyricsBackgroundSyncState,
  LyricsLine,
} from "@forever-jukebox/shared/lyrics";
import { useLyricsSync } from "../../hooks/useLyricsSync";
import {
  adjustLyricsOffset,
  isLyricsSupportedMode,
  resetLyricsOffset,
} from "../../lyrics";
import { useAppStore } from "../../store";
import { getDisplayLineText, renderSyncedLyricsLine } from "./LyricsSyllables";

const EXIT_ANIMATION_FALLBACK_MS = 360;

type ExitingLineState = {
  text: string;
  key: number;
};

type ActiveLineSnapshot = {
  index: number;
  text: string;
};

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
 * Two-line karaoke bar mounted below the visualizer canvas.
 * In Jukebox mode, Row 1 displays the active lyric and Row 2 previews the
 * upcoming or branch-predicted line. In single-song Autocanonizer mode,
 * Row 1 (Blue) and Row 2 (Green) act as independent voice lanes that preview
 * their own upcoming lines in-place before scaling up to full size when hit.
 */
export function LyricsKaraokeBar() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const playMode = useAppStore((s) => s.playMode);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
  const lyricsKaraokeEnabled = useAppStore((s) => s.lyricsKaraokeEnabled);
  const lyricsRomanizationEnabled = useAppStore(
    (s) => s.lyricsRomanizationEnabled,
  );
  const lyricsStatus = useAppStore((s) => s.lyricsStatus);
  const lyricsData = useAppStore((s) => s.lyricsData);
  const lyricsOffsetSec = useAppStore((s) => s.lyricsOffsetSec);

  const sync = useLyricsSync();
  const isCanonizer = sync.mode === "autocanonizer";
  const useRomanized = Boolean(
    lyricsRomanizationEnabled && lyricsData?.hasTransliterations,
  );

  const visible = Boolean(
    appConfig?.allow_lyrics &&
      isLyricsSupportedMode({
        playMode,
        multiTrackEnabled,
        autocanonizerMixEnabled,
      }) &&
      lyricsKaraokeEnabled,
  );

  const row1Line = isCanonizer
    ? sync.canonizer.main.activeLine
    : sync.karaoke.activeLine;
  const row1Index = isCanonizer
    ? sync.canonizer.main.activeLineIndex
    : sync.karaoke.activeLineIndex;
  const row1SylIndex = isCanonizer
    ? sync.canonizer.main.activeSyllableIndex
    : sync.karaoke.activeSyllableIndex;
  const row1SylProgress = isCanonizer
    ? sync.canonizer.main.activeSyllableProgress
    : sync.karaoke.activeSyllableProgress;

  const row2CanonLine =
    isCanonizer && !sync.canonizer.inUnison
      ? sync.canonizer.other.activeLine
      : null;
  const row2CanonIndex = row2CanonLine
    ? sync.canonizer.other.activeLineIndex
    : -1;

  const [exitingLine, setExitingLine] = useState<ExitingLineState | null>(null);
  const [otherExitingLine, setOtherExitingLine] =
    useState<ExitingLineState | null>(null);
  const prevActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const prevOtherActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const transitionIdRef = useRef(0);
  const exitTimerRef = useRef<number | null>(null);
  const otherExitTimerRef = useRef<number | null>(null);

  // Clear pending exit tweens immediately when karaoke hides or track/mode changes.
  useEffect(() => {
    prevActiveRef.current = null;
    prevOtherActiveRef.current = null;
    setExitingLine(null);
    setOtherExitingLine(null);
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (otherExitTimerRef.current !== null) {
      window.clearTimeout(otherExitTimerRef.current);
      otherExitTimerRef.current = null;
    }
  }, [visible, lyricsData, sync.mode]);

  // Capture finished Row 1 lines so they tween smoothly upward out past the top border.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const nextIndex = row1Line ? row1Index : -1;
    const prev = prevActiveRef.current;

    if (prev && prev.index !== nextIndex) {
      const exitKey = ++transitionIdRef.current;
      setExitingLine({ text: prev.text, key: exitKey });
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
      exitTimerRef.current = window.setTimeout(() => {
        setExitingLine((current) => (current?.key === exitKey ? null : current));
        exitTimerRef.current = null;
      }, EXIT_ANIMATION_FALLBACK_MS);
    }

    prevActiveRef.current = row1Line
      ? {
          index: row1Index,
          text: getDisplayLineText(row1Line, useRomanized),
        }
      : null;
  }, [visible, row1Line, row1Index, useRomanized]);

  // Capture finished Row 2 Canon lines so they tween smoothly downward out of Row 2.
  useEffect(() => {
    if (!visible || !isCanonizer) {
      return;
    }
    const nextIndex = row2CanonLine ? row2CanonIndex : -1;
    const prev = prevOtherActiveRef.current;

    if (prev && prev.index !== nextIndex) {
      const exitKey = ++transitionIdRef.current;
      setOtherExitingLine({ text: prev.text, key: exitKey });
      if (otherExitTimerRef.current !== null) {
        window.clearTimeout(otherExitTimerRef.current);
      }
      otherExitTimerRef.current = window.setTimeout(() => {
        setOtherExitingLine((current) =>
          current?.key === exitKey ? null : current,
        );
        otherExitTimerRef.current = null;
      }, EXIT_ANIMATION_FALLBACK_MS);
    }

    prevOtherActiveRef.current = row2CanonLine
      ? {
          index: row2CanonIndex,
          text: getDisplayLineText(row2CanonLine, useRomanized),
        }
      : null;
  }, [visible, isCanonizer, row2CanonLine, row2CanonIndex, useRomanized]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (otherExitTimerRef.current !== null) {
        window.clearTimeout(otherExitTimerRef.current);
        otherExitTimerRef.current = null;
      }
    };
  }, []);

  if (!visible) {
    return null;
  }

  const renderBackgroundVocals = (
    line: LyricsLine,
    bgStates: readonly LyricsBackgroundSyncState[],
    variant: "jukebox" | "canon",
  ) => {
    const bgList = line.backgroundVocals;
    if (!bgList || bgList.length === 0) {
      return null;
    }
    if (variant === "canon") {
      return (
        <span className="lyrics-karaoke-lane-bg">
          {"("}
          {bgList.map((bg, idx) => {
            const bgState = bgStates[idx];
            return (
              <span
                key={idx}
                className={`lyrics-karaoke-bg-phrase${bgState?.isActive ? " is-bg-active" : ""}`}
              >
                {idx > 0 ? " " : null}
                {renderSyncedLyricsLine(
                  bg,
                  bgState?.activeSyllableIndex ?? -1,
                  bgState?.activeSyllableProgress ?? 0,
                  useRomanized,
                )}
              </span>
            );
          })}
          {")"}
        </span>
      );
    }
    return (
      <div className="lyrics-karaoke-bg">
        {bgList.map((bg, idx) => {
          const bgState = bgStates[idx];
          return (
            <span
              key={idx}
              className={`lyrics-karaoke-bg-phrase${bgState?.isActive ? " is-bg-active" : ""}`}
            >
              {renderSyncedLyricsLine(
                bg,
                bgState?.activeSyllableIndex ?? -1,
                bgState?.activeSyllableProgress ?? 0,
                useRomanized,
              )}
            </span>
          );
        })}
      </div>
    );
  };

  const renderPrimaryLine = () => {
    if (lyricsStatus === "loading") {
      return <span className="lyrics-karaoke-status">{t("lyrics.loading")}</span>;
    }
    if (lyricsStatus === "not_found") {
      return <span className="lyrics-karaoke-status">{t("lyrics.notFound")}</span>;
    }
    if (lyricsStatus === "error") {
      return <span className="lyrics-karaoke-status">{t("lyrics.error")}</span>;
    }
    if (lyricsData?.type === "static") {
      return (
        <span className="lyrics-karaoke-status">{t("lyrics.unsyncedHint")}</span>
      );
    }

    if (isCanonizer) {
      if (row1Line) {
        return (
          <div
            key={`canon-main-${row1Index}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-active lyrics-voice-main"
          >
            <span className="lyrics-voice-dots" aria-hidden="true">
              <span
                className="lyrics-voice-dot is-main"
                title={t("lyrics.canonMain")}
              />
              {sync.canonizer.inUnison ? (
                <span
                  className="lyrics-voice-dot is-other"
                  title={t("lyrics.canonOther")}
                />
              ) : null}
            </span>
            <span className="lyrics-karaoke-lane-text">
              {renderSyncedLyricsLine(
                row1Line,
                row1SylIndex,
                row1SylProgress,
                useRomanized,
              )}
              {renderBackgroundVocals(
                row1Line,
                sync.canonizer.main.backgroundStates,
                "canon",
              )}
            </span>
          </div>
        );
      }
      if (
        sync.canonizer.main.upcomingLine &&
        sync.canonizer.main.upcomingLineVisible
      ) {
        return (
          <div
            key={`canon-main-${sync.canonizer.main.upcomingLineIndex}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-preview"
          >
            <span className="lyrics-karaoke-lane-text">
              {getDisplayLineText(
                sync.canonizer.main.upcomingLine,
                useRomanized,
              )}
            </span>
          </div>
        );
      }
      return <div className="lyrics-karaoke-line lyrics-karaoke-idle">&nbsp;</div>;
    }

    if (row1Line) {
      return (
        <div key={`jukebox-${row1Index}`} className="lyrics-karaoke-active-group">
          <div className="lyrics-karaoke-line lyrics-karaoke-active">
            {renderSyncedLyricsLine(
              row1Line,
              row1SylIndex,
              row1SylProgress,
              useRomanized,
            )}
          </div>
          {renderBackgroundVocals(
            row1Line,
            sync.karaoke.backgroundStates,
            "jukebox",
          )}
        </div>
      );
    }
    return <div className="lyrics-karaoke-line lyrics-karaoke-idle">&nbsp;</div>;
  };

  const renderSecondaryRow = () => {
    if (isCanonizer) {
      const hasActiveOther = Boolean(row2CanonLine);
      const hasPreviewOther = Boolean(
        !sync.canonizer.inUnison &&
          !row2CanonLine &&
          sync.canonizer.other.upcomingLine &&
          sync.canonizer.other.upcomingLineVisible,
      );

      return (
        <div className="lyrics-karaoke-next is-visible is-canon-other-lane">
          {otherExitingLine ? (
            <div
              key={`other-exit-${otherExitingLine.key}`}
              className="lyrics-karaoke-line lyrics-karaoke-exiting is-canonizer-other-exit"
              aria-hidden="true"
              onAnimationEnd={() => {
                if (otherExitTimerRef.current !== null) {
                  window.clearTimeout(otherExitTimerRef.current);
                  otherExitTimerRef.current = null;
                }
                setOtherExitingLine((current) =>
                  current?.key === otherExitingLine.key ? null : current,
                );
              }}
            >
              {otherExitingLine.text}
            </div>
          ) : null}
          {hasActiveOther && row2CanonLine ? (
            <div
              key={`canon-other-${row2CanonIndex}`}
              className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-active lyrics-karaoke-canon-other lyrics-voice-other"
            >
              <span className="lyrics-voice-dots" aria-hidden="true">
                <span
                  className="lyrics-voice-dot is-other"
                  title={t("lyrics.canonOther")}
                />
              </span>
              <span className="lyrics-karaoke-lane-text">
                {renderSyncedLyricsLine(
                  row2CanonLine,
                  sync.canonizer.other.activeSyllableIndex,
                  sync.canonizer.other.activeSyllableProgress,
                  useRomanized,
                )}
                {renderBackgroundVocals(
                  row2CanonLine,
                  sync.canonizer.other.backgroundStates,
                  "canon",
                )}
              </span>
            </div>
          ) : hasPreviewOther && sync.canonizer.other.upcomingLine ? (
            <div
              key={`canon-other-${sync.canonizer.other.upcomingLineIndex}`}
              className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-preview"
            >
              <span className="lyrics-karaoke-lane-text">
                {getDisplayLineText(
                  sync.canonizer.other.upcomingLine,
                  useRomanized,
                )}
              </span>
            </div>
          ) : (
            "\u00A0"
          )}
        </div>
      );
    }

    const showNextLine = Boolean(
      sync.karaoke.nextLine && sync.karaoke.nextLineVisible,
    );
    const nextLineKey = `${sync.karaoke.nextLineIndex}-${sync.karaoke.isBranchPreview ? "branch" : "linear"}`;
    return (
      <div
        className={`lyrics-karaoke-next${showNextLine ? " is-visible" : ""}${sync.karaoke.isBranchPreview ? " is-branch-preview" : ""}`}
      >
        {showNextLine && sync.karaoke.nextLine ? (
          <div key={nextLineKey} className="lyrics-karaoke-next-line">
            {sync.karaoke.isBranchPreview ? (
              <span
                className="lyrics-branch-badge"
                title={t("lyrics.branchNext")}
                aria-label={t("lyrics.branchNext")}
              >
                ↳
              </span>
            ) : null}
            <span>
              {getDisplayLineText(sync.karaoke.nextLine, useRomanized)}
            </span>
          </div>
        ) : (
          "\u00A0"
        )}
      </div>
    );
  };

  return (
    <div
      id="lyrics-karaoke-bar"
      className={`lyrics-karaoke-bar${isCanonizer ? " is-canonizer-lyrics" : ""}`}
      aria-live="polite"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="lyrics-karaoke-lines">
        <div className="lyrics-karaoke-current">
          {exitingLine ? (
            <div
              key={`exit-${exitingLine.key}`}
              className={`lyrics-karaoke-line lyrics-karaoke-exiting${isCanonizer ? " is-canonizer-exit" : ""}`}
              aria-hidden="true"
              onAnimationEnd={() => {
                if (exitTimerRef.current !== null) {
                  window.clearTimeout(exitTimerRef.current);
                  exitTimerRef.current = null;
                }
                setExitingLine((current) =>
                  current?.key === exitingLine.key ? null : current,
                );
              }}
            >
              {exitingLine.text}
            </div>
          ) : null}
          {renderPrimaryLine()}
        </div>
        {renderSecondaryRow()}
      </div>
      {lyricsData && lyricsData.type !== "static" ? (
        <div
          className="lyrics-karaoke-offset"
          role="group"
          aria-label={t("lyrics.offset")}
        >
          <button
            type="button"
            className="lyrics-offset-btn"
            aria-label={t("lyrics.offsetDecrease")}
            title={t("lyrics.offsetDecrease")}
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
            title={t("lyrics.offsetIncrease")}
            onClick={() => adjustLyricsOffset(0.1)}
          >
            +0.1s
          </button>
        </div>
      ) : null}
    </div>
  );
}
