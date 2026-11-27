import React from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@forever-jukebox/shared/ui/format";
import { formatTime } from "@/shared/utils/format";
import {
  AUTOCANONIZER_GOLD_COLOR,
  AUTOCANONIZER_MAIN_COLOR,
  AUTOCANONIZER_OTHER_COLOR,
  AUTOCANONIZER_PINK_COLOR,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerViz";
import type { PlaybackCounters, PlaybackCounterValues } from "./playbackCounters";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import type { BpmTrend } from "./liveBpm";

function setText(node: HTMLSpanElement | null, text: string) {
  if (node && node.textContent !== text) {
    node.textContent = text;
  }
}

function syncBpmDom(
  groupEl: HTMLSpanElement | null,
  valueEl: HTMLSpanElement | null,
  arrowEl: HTMLSpanElement | null,
  bpmText: string,
  bpmTrend: BpmTrend,
) {
  setText(valueEl, bpmText);
  const hasChange = bpmTrend !== null;
  if (groupEl) {
    groupEl.classList.toggle("is-bpm-changed", hasChange);
  }
  if (arrowEl) {
    arrowEl.textContent =
      bpmTrend === "up" ? "↑" : bpmTrend === "down" ? "↓" : "";
    arrowEl.classList.toggle("is-hidden", !hasChange);
  }
}

export function VizInfo({
  vizTitleRef,
  playMode,
  counters,
  wubMachineDurationSeconds,
  trackDurationSeconds,
  beatsLabel,
  bringItHomeMode,
  forceBranchActive = false,
  isQuadMix = false,
  autocanonizerOtherDurationSeconds = null,
  songSyncTrackTimes = [],
}: {
  vizTitleRef: React.RefCallback<HTMLDivElement>;
  playMode: PlayMode;
  counters: PlaybackCounters;
  wubMachineDurationSeconds: number;
  trackDurationSeconds: number;
  beatsLabel: string;
  bringItHomeMode: boolean;
  forceBranchActive?: boolean;
  isQuadMix?: boolean;
  autocanonizerOtherDurationSeconds?: number | null;
  songSyncTrackTimes?: readonly { title: string; color: string; durationSec: number }[];
}) {
  const { t } = useTranslation();
  const jukeboxTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const mainTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const otherTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const pinkTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const goldTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const songSyncTimeRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const wubTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const listenTimeRef = React.useRef<HTMLSpanElement | null>(null);
  const beatsPlayedRef = React.useRef<HTMLSpanElement | null>(null);
  const branchChanceRef = React.useRef<HTMLSpanElement | null>(null);
  const bpmGroupRef = React.useRef<HTMLSpanElement | null>(null);
  const bpmValueRef = React.useRef<HTMLSpanElement | null>(null);
  const bpmArrowRef = React.useRef<HTMLSpanElement | null>(null);

  // Counters change several times a second; they reach the DOM directly,
  // so playback causes no React commit.
  React.useLayoutEffect(() => {
    const write = (values: PlaybackCounterValues) => {
      setText(jukeboxTimeRef.current, formatTime(values.jukeboxCurrentSeconds));
      setText(mainTimeRef.current, formatTime(values.autocanonizerMainSeconds));
      setText(otherTimeRef.current, formatTime(values.autocanonizerOtherSeconds));
      setText(pinkTimeRef.current, formatTime(values.autocanonizerPinkSeconds));
      setText(goldTimeRef.current, formatTime(values.autocanonizerGoldSeconds));
      values.songSyncTrackSeconds.forEach((sec, idx) => {
        setText(songSyncTimeRefs.current[idx] ?? null, formatTime(sec));
      });
      setText(wubTimeRef.current, formatTime(values.wubMachineSeconds));
      setText(listenTimeRef.current, formatDuration(values.listenSeconds));
      setText(beatsPlayedRef.current, String(values.beatsPlayed));
      setText(
        branchChanceRef.current,
        forceBranchActive ? "100%" : values.branchChanceText,
      );
      syncBpmDom(
        bpmGroupRef.current,
        bpmValueRef.current,
        bpmArrowRef.current,
        values.bpmText,
        values.bpmTrend,
      );
    };
    write(counters.get());
    return counters.subscribe(write);
  }, [counters, forceBranchActive, isQuadMix, songSyncTrackTimes.length]);

  const isJukebox = playMode === "jukebox";
  const isCanonizer = playMode === "autocanonizer";
  const isSongSync = playMode === "songsync";
  const isWubMachine = playMode === "wubmachine";
  const hideBeats = playMode !== "jukebox";
  const hideBpm = playMode === "wubmachine";

  return (
    <div className="viz-info">
      <div className="viz-title" id="viz-now-playing" ref={vizTitleRef}></div>
      <div className="viz-meta">
        <span
          id="jukebox-times"
          className={`autocanonizer-times ${isJukebox ? "" : "is-hidden"}`}
        >
          <span id="jukebox-current-time" ref={jukeboxTimeRef}></span>
          <span aria-hidden="true">/</span>
          <span id="jukebox-total-time">{formatTime(trackDurationSeconds)}</span>
        </span>
        <span
          id="autocanonizer-times"
          className={`autocanonizer-times ${isCanonizer ? "" : "is-hidden"}`}
        >
          <span
            id="autocanonizer-main-time"
            ref={mainTimeRef}
            style={{ color: AUTOCANONIZER_MAIN_COLOR }}
          ></span>
          <span aria-hidden="true">–</span>
          <span
            id="autocanonizer-other-time"
            ref={otherTimeRef}
            style={{ color: AUTOCANONIZER_OTHER_COLOR }}
          ></span>
          <span aria-hidden="true">/</span>
          <span id="autocanonizer-total-time">
            {formatTime(trackDurationSeconds)}
          </span>
          {isQuadMix ? (
            <>
              <span className="viz-divider" aria-hidden="true">
                ·
              </span>
              <span
                id="autocanonizer-pink-time"
                ref={pinkTimeRef}
                style={{ color: AUTOCANONIZER_PINK_COLOR }}
              ></span>
              <span aria-hidden="true">–</span>
              <span
                id="autocanonizer-gold-time"
                ref={goldTimeRef}
                style={{ color: AUTOCANONIZER_GOLD_COLOR }}
              ></span>
              <span aria-hidden="true">/</span>
              <span id="autocanonizer-other-total-time">
                {formatTime(
                  autocanonizerOtherDurationSeconds ?? trackDurationSeconds,
                )}
              </span>
            </>
          ) : null}
        </span>
        <span
          id="wubmachine-times"
          className={`autocanonizer-times ${isWubMachine ? "" : "is-hidden"}`}
        >
          <span id="wubmachine-time" ref={wubTimeRef}></span>
          <span aria-hidden="true">/</span>
          <span id="wubmachine-total-time">
            {formatTime(wubMachineDurationSeconds)}
          </span>
        </span>
        <span
          id="songsync-times"
          className={`autocanonizer-times ${isSongSync ? "" : "is-hidden"}`}
        >
          {songSyncTrackTimes.map((track, idx) => (
            <React.Fragment key={idx}>
              {idx > 0 ? (
                <span className="viz-divider" aria-hidden="true">
                  ·
                </span>
              ) : null}
              <span className="songsync-track-time">
                <span
                  ref={(el) => {
                    songSyncTimeRefs.current[idx] = el;
                  }}
                  style={{ color: track.color }}
                >
                  0:00
                </span>
                <span aria-hidden="true">/</span>
                <span>{formatTime(track.durationSec)}</span>
              </span>
            </React.Fragment>
          ))}
        </span>
        <span className="viz-meta-stats">
          <span>{t("listen.listenTime")}</span>
          <span ref={listenTimeRef}></span>
          <span className={`viz-divider ${hideBeats ? "is-hidden" : ""}`}>·</span>
          <span className={hideBeats ? "is-hidden" : ""}>{beatsLabel}</span>
          <span className={hideBeats ? "is-hidden" : ""} ref={beatsPlayedRef}></span>
          <span
            id="viz-branch-chance-divider"
            className={`viz-divider ${hideBeats ? "is-hidden" : ""}`}
          >
            ·
          </span>
          <span
            id="viz-branch-chance-label"
            className={hideBeats ? "is-hidden" : undefined}
          >
            {t("listen.branchChance")}
          </span>
          <span
            id="branch-chance"
            className={
              hideBeats
                ? "is-hidden"
                : bringItHomeMode && !forceBranchActive
                  ? "is-crossed"
                  : undefined
            }
            ref={branchChanceRef}
          ></span>
          <span
            id="viz-bpm-divider"
            className={`viz-divider ${hideBpm ? "is-hidden" : ""}`}
          >
            ·
          </span>
          <span
            id="viz-bpm"
            className={hideBpm ? "viz-bpm is-hidden" : "viz-bpm"}
            ref={bpmGroupRef}
          >
            <span id="viz-bpm-label">{t("listen.bpm")}</span>
            <span id="viz-bpm-value" ref={bpmValueRef}></span>
            <span
              id="viz-bpm-arrow"
              className="viz-bpm-arrow is-hidden"
              ref={bpmArrowRef}
              aria-hidden="true"
            ></span>
          </span>
        </span>
        {playMode === "jukebox" && bringItHomeMode ? (
          <span className="bring-home-fullscreen-note">
            · {t("listen.bringingHome")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
