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
  const autocanonizerTrioMode = useAppStore((s) => s.autocanonizerTrioMode);
  const autocanonizerSingleVoiceCount = useAppStore(
    (s) => s.autocanonizerSingleVoiceCount,
  );
  const singleVoiceCount =
    autocanonizerSingleVoiceCount > 2
      ? autocanonizerSingleVoiceCount
      : autocanonizerTrioMode
        ? 3
        : 2;
  const lyricsKaraokeEnabled = useAppStore((s) => s.lyricsKaraokeEnabled);
  const lyricsRomanizationEnabled = useAppStore(
    (s) => s.lyricsRomanizationEnabled,
  );
  const lyricsStatus = useAppStore((s) => s.lyricsStatus);
  const lyricsData = useAppStore((s) => s.lyricsData);
  const lyricsOffsetSec = useAppStore((s) => s.lyricsOffsetSec);

  const sync = useLyricsSync();
  const isCanonizer = sync.mode === "autocanonizer";
  const isMultiCanonizer = isCanonizer && singleVoiceCount >= 3;
  const isQuadCanonizer = isCanonizer && singleVoiceCount === 4;
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

  const row3GoldLine = isMultiCanonizer ? sync.canonizer.gold.activeLine : null;
  const row3GoldIndex = row3GoldLine
    ? sync.canonizer.gold.activeLineIndex
    : -1;

  const row4PinkLine = isQuadCanonizer ? sync.canonizer.pink.activeLine : null;
  const row4PinkIndex = row4PinkLine
    ? sync.canonizer.pink.activeLineIndex
    : -1;

  const [exitingLine, setExitingLine] = useState<ExitingLineState | null>(null);
  const [otherExitingLine, setOtherExitingLine] =
    useState<ExitingLineState | null>(null);
  const [goldExitingLine, setGoldExitingLine] =
    useState<ExitingLineState | null>(null);
  const [pinkExitingLine, setPinkExitingLine] =
    useState<ExitingLineState | null>(null);
  const prevActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const prevOtherActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const prevGoldActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const prevPinkActiveRef = useRef<ActiveLineSnapshot | null>(null);
  const transitionIdRef = useRef(0);
  const exitTimerRef = useRef<number | null>(null);
  const otherExitTimerRef = useRef<number | null>(null);
  const goldExitTimerRef = useRef<number | null>(null);
  const pinkExitTimerRef = useRef<number | null>(null);

  // Clear pending exit tweens immediately when karaoke hides or track/mode changes.
  useEffect(() => {
    prevActiveRef.current = null;
    prevOtherActiveRef.current = null;
    prevGoldActiveRef.current = null;
    prevPinkActiveRef.current = null;
    setExitingLine(null);
    setOtherExitingLine(null);
    setGoldExitingLine(null);
    setPinkExitingLine(null);
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (otherExitTimerRef.current !== null) {
      window.clearTimeout(otherExitTimerRef.current);
      otherExitTimerRef.current = null;
    }
    if (goldExitTimerRef.current !== null) {
      window.clearTimeout(goldExitTimerRef.current);
      goldExitTimerRef.current = null;
    }
    if (pinkExitTimerRef.current !== null) {
      window.clearTimeout(pinkExitTimerRef.current);
      pinkExitTimerRef.current = null;
    }
  }, [visible, lyricsData, sync.mode, isMultiCanonizer, isQuadCanonizer]);

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

  // Capture finished Row 3 Gold lines so they tween smoothly downward out of Row 3.
  useEffect(() => {
    if (!visible || !isMultiCanonizer) {
      return;
    }
    const nextIndex = row3GoldLine ? row3GoldIndex : -1;
    const prev = prevGoldActiveRef.current;

    if (prev && prev.index !== nextIndex) {
      const exitKey = ++transitionIdRef.current;
      setGoldExitingLine({ text: prev.text, key: exitKey });
      if (goldExitTimerRef.current !== null) {
        window.clearTimeout(goldExitTimerRef.current);
      }
      goldExitTimerRef.current = window.setTimeout(() => {
        setGoldExitingLine((current) =>
          current?.key === exitKey ? null : current,
        );
        goldExitTimerRef.current = null;
      }, EXIT_ANIMATION_FALLBACK_MS);
    }

    prevGoldActiveRef.current = row3GoldLine
      ? {
          index: row3GoldIndex,
          text: getDisplayLineText(row3GoldLine, useRomanized),
        }
      : null;
  }, [visible, isMultiCanonizer, row3GoldLine, row3GoldIndex, useRomanized]);

  // Capture finished Row 4 Pink lines so they tween smoothly downward out of Row 4.
  useEffect(() => {
    if (!visible || !isQuadCanonizer) {
      return;
    }
    const nextIndex = row4PinkLine ? row4PinkIndex : -1;
    const prev = prevPinkActiveRef.current;

    if (prev && prev.index !== nextIndex) {
      const exitKey = ++transitionIdRef.current;
      setPinkExitingLine({ text: prev.text, key: exitKey });
      if (pinkExitTimerRef.current !== null) {
        window.clearTimeout(pinkExitTimerRef.current);
      }
      pinkExitTimerRef.current = window.setTimeout(() => {
        setPinkExitingLine((current) =>
          current?.key === exitKey ? null : current,
        );
        pinkExitTimerRef.current = null;
      }, EXIT_ANIMATION_FALLBACK_MS);
    }

    prevPinkActiveRef.current = row4PinkLine
      ? {
          index: row4PinkIndex,
          text: getDisplayLineText(row4PinkLine, useRomanized),
        }
      : null;
  }, [visible, isQuadCanonizer, row4PinkLine, row4PinkIndex, useRomanized]);

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
      if (goldExitTimerRef.current !== null) {
        window.clearTimeout(goldExitTimerRef.current);
        goldExitTimerRef.current = null;
      }
      if (pinkExitTimerRef.current !== null) {
        window.clearTimeout(pinkExitTimerRef.current);
        pinkExitTimerRef.current = null;
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

  const renderTertiaryRow = () => {
    if (!isMultiCanonizer) {
      return null;
    }
    const hasActiveGold = Boolean(row3GoldLine);
    const hasPreviewGold = Boolean(
      !row3GoldLine &&
        sync.canonizer.gold.upcomingLine &&
        sync.canonizer.gold.upcomingLineVisible,
    );

    return (
      <div className="lyrics-karaoke-next is-visible is-canon-gold-lane">
        {goldExitingLine ? (
          <div
            key={`gold-exit-${goldExitingLine.key}`}
            className="lyrics-karaoke-line lyrics-karaoke-exiting is-canonizer-gold-exit"
            aria-hidden="true"
            onAnimationEnd={() => {
              if (goldExitTimerRef.current !== null) {
                window.clearTimeout(goldExitTimerRef.current);
                goldExitTimerRef.current = null;
              }
              setGoldExitingLine((current) =>
                current?.key === goldExitingLine.key ? null : current,
              );
            }}
          >
            {goldExitingLine.text}
          </div>
        ) : null}
        {hasActiveGold && row3GoldLine ? (
          <div
            key={`canon-gold-${row3GoldIndex}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-active lyrics-karaoke-canon-gold lyrics-voice-gold"
          >
            <span className="lyrics-voice-dots" aria-hidden="true">
              <span
                className="lyrics-voice-dot is-gold"
                title={t("lyrics.canonGold")}
              />
            </span>
            <span className="lyrics-karaoke-lane-text">
              {renderSyncedLyricsLine(
                row3GoldLine,
                sync.canonizer.gold.activeSyllableIndex,
                sync.canonizer.gold.activeSyllableProgress,
                useRomanized,
              )}
              {renderBackgroundVocals(
                row3GoldLine,
                sync.canonizer.gold.backgroundStates,
                "canon",
              )}
            </span>
          </div>
        ) : hasPreviewGold && sync.canonizer.gold.upcomingLine ? (
          <div
            key={`canon-gold-${sync.canonizer.gold.upcomingLineIndex}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-preview"
          >
            <span className="lyrics-karaoke-lane-text">
              {getDisplayLineText(
                sync.canonizer.gold.upcomingLine,
                useRomanized,
              )}
            </span>
          </div>
        ) : (
          "\u00A0"
        )}
      </div>
    );
  };

  const renderQuaternaryRow = () => {
    if (!isQuadCanonizer) {
      return null;
    }
    const hasActivePink = Boolean(row4PinkLine);
    const hasPreviewPink = Boolean(
      !row4PinkLine &&
        sync.canonizer.pink.upcomingLine &&
        sync.canonizer.pink.upcomingLineVisible,
    );

    return (
      <div className="lyrics-karaoke-next is-visible is-canon-pink-lane">
        {pinkExitingLine ? (
          <div
            key={`pink-exit-${pinkExitingLine.key}`}
            className="lyrics-karaoke-line lyrics-karaoke-exiting is-canonizer-pink-exit"
            aria-hidden="true"
            onAnimationEnd={() => {
              if (pinkExitTimerRef.current !== null) {
                window.clearTimeout(pinkExitTimerRef.current);
                pinkExitTimerRef.current = null;
              }
              setPinkExitingLine((current) =>
                current?.key === pinkExitingLine.key ? null : current,
              );
            }}
          >
            {pinkExitingLine.text}
          </div>
        ) : null}
        {hasActivePink && row4PinkLine ? (
          <div
            key={`canon-pink-${row4PinkIndex}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-active lyrics-karaoke-canon-pink lyrics-voice-pink"
          >
            <span className="lyrics-voice-dots" aria-hidden="true">
              <span
                className="lyrics-voice-dot is-pink"
                title={t("lyrics.canonPink")}
              />
            </span>
            <span className="lyrics-karaoke-lane-text">
              {renderSyncedLyricsLine(
                row4PinkLine,
                sync.canonizer.pink.activeSyllableIndex,
                sync.canonizer.pink.activeSyllableProgress,
                useRomanized,
              )}
              {renderBackgroundVocals(
                row4PinkLine,
                sync.canonizer.pink.backgroundStates,
                "canon",
              )}
            </span>
          </div>
        ) : hasPreviewPink && sync.canonizer.pink.upcomingLine ? (
          <div
            key={`canon-pink-${sync.canonizer.pink.upcomingLineIndex}`}
            className="lyrics-karaoke-line lyrics-karaoke-lane-line is-lane-preview"
          >
            <span className="lyrics-karaoke-lane-text">
              {getDisplayLineText(
                sync.canonizer.pink.upcomingLine,
                useRomanized,
              )}
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
      className={`lyrics-karaoke-bar${isCanonizer ? " is-canonizer-lyrics" : ""}${singleVoiceCount === 3 && isCanonizer ? " is-trio-lyrics" : ""}${isQuadCanonizer ? " is-quad-lyrics" : ""}`}
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
        {renderTertiaryRow()}
        {renderQuaternaryRow()}
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
