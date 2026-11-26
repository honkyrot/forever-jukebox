import { useLayoutEffect, useRef } from "react";
import {
  AUTOCANONIZER_GOLD_COLOR,
  AUTOCANONIZER_MAIN_COLOR,
  AUTOCANONIZER_OTHER_COLOR,
  AUTOCANONIZER_PINK_COLOR,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerViz";
import { formatCursorTime, formatPlaybackTitle } from "../../format";
import { useMarquee } from "../../hooks/useMarquee";
import type { BpmTrend } from "../../liveBpm";
import { useAppStore } from "../../store";
import { useTranslation } from "react-i18next";

/**
 * Synchronizes the BPM readout value, directional arrow, and highlight class
 * directly onto DOM nodes without triggering a React render.
 */
function syncBpmDom(
  groupEl: HTMLSpanElement | null,
  valueEl: HTMLSpanElement | null,
  arrowEl: HTMLSpanElement | null,
  bpmText: string,
  bpmTrend: BpmTrend,
) {
  if (valueEl) {
    valueEl.textContent = bpmText;
  }
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

// Viz-bottom track info: marquee title, listen time and beat counters.
// Rendered into the .viz-info container.
export function VizInfo() {
  const { t } = useTranslation();
  const trackTitle = useAppStore((s) => s.trackTitle);
  const trackArtist = useAppStore((s) => s.trackArtist);
  const playMode = useAppStore((s) => s.playMode);
  const audioMode = useAppStore((s) => s.jukeboxAudioMode);
  const bringItHomeMode = useAppStore((s) => s.bringItHomeMode);
  const shiftBranching = useAppStore((s) => s.shiftBranching);
  const trackDurationSec = useAppStore((s) => s.trackDurationSec);
  const autocanonizerMixEnabled = useAppStore(
    (s) => s.autocanonizerMixEnabled,
  );
  const autocanonizerQuadMode = useAppStore((s) => s.autocanonizerQuadMode);
  const autocanonizerOtherDurationSec = useAppStore(
    (s) => s.autocanonizerOtherDurationSec,
  );
  const isQuadMix = autocanonizerMixEnabled && autocanonizerQuadMode;
  const wubMachineDurationSec = useAppStore((s) => s.wubMachineDurationSec);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const listenTimeRef = useRef<HTMLSpanElement | null>(null);
  const beatsPlayedRef = useRef<HTMLSpanElement | null>(null);
  const branchChanceRef = useRef<HTMLSpanElement | null>(null);
  const bpmGroupRef = useRef<HTMLSpanElement | null>(null);
  const bpmValueRef = useRef<HTMLSpanElement | null>(null);
  const bpmArrowRef = useRef<HTMLSpanElement | null>(null);
  const jukeboxCursorTimeRef = useRef<HTMLSpanElement | null>(null);
  const mainCursorTimeRef = useRef<HTMLSpanElement | null>(null);
  const otherCursorTimeRef = useRef<HTMLSpanElement | null>(null);
  const pinkCursorTimeRef = useRef<HTMLSpanElement | null>(null);
  const goldCursorTimeRef = useRef<HTMLSpanElement | null>(null);
  const wubCursorTimeRef = useRef<HTMLSpanElement | null>(null);

  const isJukebox = playMode === "jukebox";
  const isCanonizer = playMode === "autocanonizer";
  const isWubMachine = playMode === "wubmachine";
  const hideBeats = playMode !== "jukebox";
  const hideBpm = playMode === "wubmachine";
  const bringHomeVisible = playMode === "jukebox" && bringItHomeMode;

  // listenTimeText (~5Hz) and beatsPlayedText (engine-rate) change far too
  // often to drive React renders — each would re-run the title/marquee work
  // several times a second during playback. Write them straight to their DOM
  // nodes through a transient store subscription instead, so VizInfo only
  // re-renders when the track metadata around them actually changes.
  useLayoutEffect(() => {
    const seed = useAppStore.getState();
    if (listenTimeRef.current) {
      listenTimeRef.current.textContent = seed.listenTimeText;
    }
    if (beatsPlayedRef.current) {
      beatsPlayedRef.current.textContent = seed.beatsPlayedText;
    }
    if (branchChanceRef.current) {
      branchChanceRef.current.textContent = seed.shiftBranching
        ? "100%"
        : seed.branchChanceText;
    }
    syncBpmDom(
      bpmGroupRef.current,
      bpmValueRef.current,
      bpmArrowRef.current,
      seed.bpmText,
      seed.bpmTrend,
    );
    if (jukeboxCursorTimeRef.current) {
      jukeboxCursorTimeRef.current.textContent = formatCursorTime(
        seed.jukeboxCurrentSeconds,
      );
    }
    if (mainCursorTimeRef.current) {
      mainCursorTimeRef.current.textContent = formatCursorTime(
        seed.autocanonizerMainSeconds,
      );
    }
    if (otherCursorTimeRef.current) {
      otherCursorTimeRef.current.textContent = formatCursorTime(
        seed.autocanonizerOtherSeconds,
      );
    }
    if (pinkCursorTimeRef.current) {
      pinkCursorTimeRef.current.textContent = formatCursorTime(
        seed.autocanonizerPinkSeconds,
      );
    }
    if (goldCursorTimeRef.current) {
      goldCursorTimeRef.current.textContent = formatCursorTime(
        seed.autocanonizerGoldSeconds,
      );
    }
    if (wubCursorTimeRef.current) {
      wubCursorTimeRef.current.textContent = formatCursorTime(
        seed.wubMachineSeconds,
      );
    }
    return useAppStore.subscribe((state, prev) => {
      if (
        state.listenTimeText !== prev.listenTimeText &&
        listenTimeRef.current
      ) {
        listenTimeRef.current.textContent = state.listenTimeText;
      }
      if (
        state.beatsPlayedText !== prev.beatsPlayedText &&
        beatsPlayedRef.current
      ) {
        beatsPlayedRef.current.textContent = state.beatsPlayedText;
      }
      if (
        (state.branchChanceText !== prev.branchChanceText ||
          state.shiftBranching !== prev.shiftBranching) &&
        branchChanceRef.current
      ) {
        branchChanceRef.current.textContent = state.shiftBranching
          ? "100%"
          : state.branchChanceText;
      }
      if (state.bpmText !== prev.bpmText || state.bpmTrend !== prev.bpmTrend) {
        syncBpmDom(
          bpmGroupRef.current,
          bpmValueRef.current,
          bpmArrowRef.current,
          state.bpmText,
          state.bpmTrend,
        );
      }
      if (
        state.jukeboxCurrentSeconds !== prev.jukeboxCurrentSeconds &&
        jukeboxCursorTimeRef.current
      ) {
        jukeboxCursorTimeRef.current.textContent = formatCursorTime(
          state.jukeboxCurrentSeconds,
        );
      }
      if (
        state.autocanonizerMainSeconds !== prev.autocanonizerMainSeconds &&
        mainCursorTimeRef.current
      ) {
        mainCursorTimeRef.current.textContent = formatCursorTime(
          state.autocanonizerMainSeconds,
        );
      }
      if (
        state.autocanonizerOtherSeconds !== prev.autocanonizerOtherSeconds &&
        otherCursorTimeRef.current
      ) {
        otherCursorTimeRef.current.textContent = formatCursorTime(
          state.autocanonizerOtherSeconds,
        );
      }
      if (
        state.autocanonizerPinkSeconds !== prev.autocanonizerPinkSeconds &&
        pinkCursorTimeRef.current
      ) {
        pinkCursorTimeRef.current.textContent = formatCursorTime(
          state.autocanonizerPinkSeconds,
        );
      }
      if (
        state.autocanonizerGoldSeconds !== prev.autocanonizerGoldSeconds &&
        goldCursorTimeRef.current
      ) {
        goldCursorTimeRef.current.textContent = formatCursorTime(
          state.autocanonizerGoldSeconds,
        );
      }
      if (
        state.wubMachineSeconds !== prev.wubMachineSeconds &&
        wubCursorTimeRef.current
      ) {
        wubCursorTimeRef.current.textContent = formatCursorTime(
          state.wubMachineSeconds,
        );
      }
    });
  }, [isQuadMix, hideBpm]);

  const displayTitle =
    trackTitle || trackArtist
      ? (() => {
          const withSuffix = formatPlaybackTitle(
            trackTitle ?? t("common.unknown"),
            playMode,
            audioMode,
          );
          return trackArtist ? `${withSuffix} — ${trackArtist}` : withSuffix;
        })()
      : t("common.appName");
  useMarquee(titleRef, displayTitle);

  const beatsLabel =
    audioMode === "cowbell"
      ? t("playback.totalCowbells")
      : t("playback.totalBeats");

  return (
    <>
      <div className="viz-title" id="viz-now-playing" ref={titleRef}></div>
      <div className="viz-meta">
        <span
          id="jukebox-times"
          className={
            isJukebox ? "autocanonizer-times" : "autocanonizer-times is-hidden"
          }
        >
          <span id="jukebox-current-time" ref={jukeboxCursorTimeRef}></span>
          <span aria-hidden="true">/</span>
          <span id="jukebox-total-time">
            {formatCursorTime(trackDurationSec ?? 0)}
          </span>
        </span>
        <span
          id="autocanonizer-times"
          className={
            isCanonizer ? "autocanonizer-times" : "autocanonizer-times is-hidden"
          }
        >
          <span
            id="autocanonizer-main-time"
            ref={mainCursorTimeRef}
            style={{ color: AUTOCANONIZER_MAIN_COLOR }}
          ></span>
          <span aria-hidden="true">–</span>
          <span
            id="autocanonizer-other-time"
            ref={otherCursorTimeRef}
            style={{ color: AUTOCANONIZER_OTHER_COLOR }}
          ></span>
          <span aria-hidden="true">/</span>
          <span id="autocanonizer-total-time">
            {formatCursorTime(trackDurationSec ?? 0)}
          </span>
          {isQuadMix ? (
            <>
              <span className="viz-divider" aria-hidden="true">
                ·
              </span>
              <span
                id="autocanonizer-pink-time"
                ref={pinkCursorTimeRef}
                style={{ color: AUTOCANONIZER_PINK_COLOR }}
              ></span>
              <span aria-hidden="true">–</span>
              <span
                id="autocanonizer-gold-time"
                ref={goldCursorTimeRef}
                style={{ color: AUTOCANONIZER_GOLD_COLOR }}
              ></span>
              <span aria-hidden="true">/</span>
              <span id="autocanonizer-other-total-time">
                {formatCursorTime(
                  autocanonizerOtherDurationSec ?? trackDurationSec ?? 0,
                )}
              </span>
            </>
          ) : null}
        </span>
        <span
          id="wubmachine-times"
          className={
            isWubMachine
              ? "autocanonizer-times"
              : "autocanonizer-times is-hidden"
          }
        >
          <span id="wubmachine-time" ref={wubCursorTimeRef}></span>
          <span aria-hidden="true">/</span>
          <span id="wubmachine-total-time">
            {formatCursorTime(wubMachineDurationSec)}
          </span>
        </span>
        <span className="viz-meta-stats">
          <span>{t("playback.listenTime")}</span>
          <span id="listen-time" ref={listenTimeRef}></span>
          <span
            id="viz-beats-divider"
            className={hideBeats ? "viz-divider is-hidden" : "viz-divider"}
          >
            ·
          </span>
          <span
            id="viz-beats-label"
            className={hideBeats ? "is-hidden" : undefined}
          >
            {beatsLabel}
          </span>
          <span
            id="beats-played"
            className={hideBeats ? "is-hidden" : undefined}
            ref={beatsPlayedRef}
          ></span>
          <span
            id="viz-branch-chance-divider"
            className={hideBeats ? "viz-divider is-hidden" : "viz-divider"}
          >
            ·
          </span>
          <span
            id="viz-branch-chance-label"
            className={hideBeats ? "is-hidden" : undefined}
          >
            Branch Chance:
          </span>
          <span
            id="branch-chance"
            className={
              hideBeats
                ? "is-hidden"
                : bringItHomeMode && !shiftBranching
                  ? "is-crossed"
                  : undefined
            }
            ref={branchChanceRef}
          ></span>
          <span
            id="viz-bpm-divider"
            className={hideBpm ? "viz-divider is-hidden" : "viz-divider"}
          >
            ·
          </span>
          <span
            id="viz-bpm"
            className={hideBpm ? "viz-bpm is-hidden" : "viz-bpm"}
            ref={bpmGroupRef}
          >
            <span id="viz-bpm-label">{t("playback.bpm")}</span>
            <span id="viz-bpm-value" ref={bpmValueRef}></span>
            <span
              id="viz-bpm-arrow"
              className="viz-bpm-arrow is-hidden"
              ref={bpmArrowRef}
              aria-hidden="true"
            ></span>
          </span>
        </span>
        <span
          id="bring-home-fullscreen-label"
          className={
            bringHomeVisible
              ? "bring-home-fullscreen-note"
              : "bring-home-fullscreen-note is-hidden"
          }
        >
          · {t("playback.bringingHome")}
        </span>
      </div>
    </>
  );
}
