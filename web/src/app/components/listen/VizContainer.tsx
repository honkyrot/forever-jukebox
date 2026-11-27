import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import {
  isSmoothBpmBarStyle,
  resolveBpmBarActiveSegment,
  resolveBpmBarSmoothAnimation,
} from "../../bpmBarTimeSignature";
import { attachViz, getAppContext } from "../../runtime";
import { useAppStore } from "../../store";
import { ModifierBadges } from "../ModifierBadges";
import { BranchStatsPopup } from "./BranchStatsPopup";
import { CustomAnchorInfo } from "./CustomAnchorEditor";
import { LyricsKaraokeBar } from "./LyricsKaraokeBar";
import { isLyricsSupportedMode } from "../../lyrics";
import { PlayControls } from "./PlayControls";
import { VizBottomRight } from "./VizBottomRight";
import { VizInfo } from "./VizInfo";
import { VizTop } from "./VizTop";

const VIZ_CLASS_NAMES: Record<PlayMode, string> = {
  jukebox: "viz",
  autocanonizer: "viz is-canonizer",
  songsync: "viz is-songsync",
  wubmachine: "viz is-wubmachine",
};

// Hosts the viz canvases. The #viz-layer/#canonizer-layer divs are bare,
// stable JSX nodes — React renders them once and NEVER remounts them (no
// keys, no conditional unmount; visibility is class-only), because the
// controllers hold canvas/WebGL state inside. The panel-level ref callback
// hands the nodes to init's attachViz, which constructs the
// controllers exactly once (StrictMode re-attaches are ignored there).
export function VizContainer() {
  const audioLoaded = useAppStore((s) => s.audioLoaded);
  const analysisLoaded = useAppStore((s) => s.analysisLoaded);
  const audioModePreparing = useAppStore((s) => s.audioModePreparing);
  const loadingShown = useAppStore((s) => s.loadingShown);
  const playMode = useAppStore((s) => s.playMode);
  const vizStatsPulseId = useAppStore((s) => s.vizStatsPulseId);
  const vizStatsPulseBeatIndex = useAppStore((s) => s.vizStatsPulseBeatIndex);
  const vizStatsPulseBeat = useAppStore((s) => s.vizStatsPulseBeat);
  const bpmBarEnabled = useAppStore((s) => s.bpmBarEnabled);
  const bpmBarStyle = useAppStore((s) => s.bpmBarStyle);
  const isPaused = useAppStore((s) => s.isPaused);
  const bpmBarTimeSignatureMode = useAppStore((s) => s.bpmBarTimeSignatureMode);
  const bpmBarNumerator = useAppStore((s) => s.bpmBarNumerator);
  const bpmBarDenominator = useAppStore((s) => s.bpmBarDenominator);
  const bpmBarBeatOffset = useAppStore((s) => s.bpmBarBeatOffset);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
  const coverSyncEnabled = useAppStore((s) => s.coverSyncEnabled);
  const timeSignatureBranchingEnabled = useAppStore(
    (s) => s.timeSignatureBranchingEnabled,
  );
  const timeSignatureBranchMode = useAppStore((s) => s.timeSignatureBranchMode);
  const timeSignatureNumerator = useAppStore((s) => s.timeSignatureNumerator);
  const timeSignatureDenominator = useAppStore(
    (s) => s.timeSignatureDenominator,
  );
  const timeSignatureTrackOffsets = useAppStore(
    (s) => s.timeSignatureTrackOffsets,
  );
  const timeSignatureSimilarityRestrictEnabled = useAppStore(
    (s) => s.timeSignatureSimilarityRestrictEnabled,
  );
  const timeSignatureSimilarityNumerator = useAppStore(
    (s) => s.timeSignatureSimilarityNumerator,
  );
  const timeSignatureSimilarityDenominator = useAppStore(
    (s) => s.timeSignatureSimilarityDenominator,
  );
  const metronomeEnabled = useAppStore((s) => s.metronomeEnabled);
  const metronomeDetectedBeatsPerBar = useAppStore(
    (s) => s.metronomeDetectedBeatsPerBar,
  );
  const appConfig = useAppStore((s) => s.appConfig);
  const lyricsKaraokeEnabled = useAppStore((s) => s.lyricsKaraokeEnabled);
  const vizBeats = useAppStore((s) => s.vizData?.beats);
  const vizStatsRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const smoothFillRef = useRef<HTMLSpanElement | null>(null);
  const vizPanelRef = useRef<HTMLDivElement | null>(null);
  const vizLayerRef = useRef<HTMLDivElement | null>(null);
  const canonizerLayerRef = useRef<HTMLDivElement | null>(null);
  const songSyncLayerRef = useRef<HTMLDivElement | null>(null);
  const wubMachineLayerRef = useRef<HTMLDivElement | null>(null);

  const { segmentCount, activeSegmentIndex } = resolveBpmBarActiveSegment(
    {
      bpmBarTimeSignatureMode,
      bpmBarNumerator,
      bpmBarDenominator,
      bpmBarBeatOffset,
      multiTrackEnabled,
      coverSyncEnabled,
      timeSignatureBranchingEnabled,
      timeSignatureBranchMode,
      timeSignatureNumerator,
      timeSignatureDenominator,
      timeSignatureTrackOffsets,
      timeSignatureSimilarityRestrictEnabled,
      timeSignatureSimilarityNumerator,
      timeSignatureSimilarityDenominator,
      metronomeEnabled,
      metronomeDetectedBeatsPerBar,
    },
    vizStatsPulseBeatIndex,
    vizStatsPulseBeat,
    vizBeats,
  );

  const isSmoothStyle = isSmoothBpmBarStyle(bpmBarStyle);
  const showSegmentOverlay =
    bpmBarStyle === "smooth-pulse" && segmentCount !== null;
  const visible = audioLoaded && analysisLoaded && !audioModePreparing && !loadingShown;
  const showKaraokeLyrics = Boolean(
    isLyricsSupportedMode({
      playMode,
      multiTrackEnabled,
      autocanonizerMixEnabled,
    }) &&
      appConfig?.allow_lyrics &&
      lyricsKaraokeEnabled,
  );

  // Child refs attach before this parent ref, so the layer nodes are ready.
  const handlePanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      vizPanelRef.current = node;
      if (
        node &&
        vizLayerRef.current &&
        canonizerLayerRef.current &&
        wubMachineLayerRef.current
      ) {
        attachViz({
          vizPanel: node,
          vizLayer: vizLayerRef.current,
          canonizerLayer: canonizerLayerRef.current,
          ...(songSyncLayerRef.current
            ? { songSyncLayer: songSyncLayerRef.current }
            : {}),
          wubMachineLayer: wubMachineLayerRef.current,
        });
      }
    },
    [],
  );

  // Observe the panel and the viz layer (the viz-top row can change its height)
  // and resize the controllers, with a window-resize fallback for older browsers.
  useEffect(() => {
    const panel = vizPanelRef.current;
    if (!panel) {
      return;
    }
    const handleResize = () => {
      const ctx = getAppContext();
      ctx.jukebox?.resizeNow();
      ctx.autocanonizer?.resizeNow();
      ctx.songsync?.resizeNow();
      ctx.wubmachine?.resizeNow();
    };
    if (
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver !== undefined
    ) {
      const observer = new ResizeObserver(() => {
        handleResize();
      });
      observer.observe(panel);
      if (vizLayerRef.current) {
        observer.observe(vizLayerRef.current);
      }
      return () => observer.disconnect();
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Trigger the beat-pulse or smooth progress CSS animation without remounting #viz-stats.
  useLayoutEffect(() => {
    const el = vizStatsRef.current;
    if (!el) {
      return;
    }
    el.classList.remove("pulse");
    const fillEl = smoothFillRef.current;
    if (!bpmBarEnabled || vizStatsPulseId <= 0) {
      for (const segEl of segmentRefs.current) {
        segEl?.classList.remove("is-pulsing");
      }
      if (fillEl) {
        fillEl.classList.remove("is-animating", "is-downbeat");
        fillEl.style.removeProperty("--bpm-bar-from");
        fillEl.style.removeProperty("--bpm-bar-to");
        fillEl.style.removeProperty("--bpm-bar-duration");
      }
      return;
    }
    if (isSmoothStyle) {
      if (!fillEl) {
        return;
      }
      const ctx = getAppContext();
      const playbackRate =
        playMode === "jukebox" ? (ctx.player?.getPlaybackRate?.() ?? 1) : 1;
      const currentTimeSec =
        playMode === "jukebox" && ctx.player?.isPlaying?.()
          ? ctx.player.getCurrentTime()
          : null;
      const anim = resolveBpmBarSmoothAnimation({
        segmentCount,
        activeSegmentIndex,
        beatIndex: vizStatsPulseBeatIndex,
        beat: vizStatsPulseBeat,
        playbackRate,
        currentTimeSec,
      });
      fillEl.classList.remove("is-animating", "is-downbeat");
      if (!anim) {
        for (const segEl of segmentRefs.current) {
          segEl?.classList.remove("is-pulsing");
        }
        return;
      }
      fillEl.style.setProperty("--bpm-bar-from", String(anim.fromFraction));
      fillEl.style.setProperty("--bpm-bar-to", String(anim.toFraction));
      fillEl.style.setProperty("--bpm-bar-duration", `${anim.durationMs}ms`);
      // Force reflow so the CSS animation restarts cleanly on the next beat.
      void fillEl.offsetWidth;
      if (anim.isDownbeat) {
        fillEl.classList.add("is-downbeat");
      }
      fillEl.classList.add("is-animating");
      if (bpmBarStyle === "smooth-pulse") {
        if (segmentCount !== null && activeSegmentIndex !== null) {
          const segEl = segmentRefs.current[activeSegmentIndex];
          if (segEl) {
            segEl.classList.remove("is-pulsing");
            void segEl.offsetWidth;
            segEl.classList.add("is-pulsing");
          }
        } else if (segmentCount === null) {
          void el.offsetWidth;
          el.classList.add("pulse");
        }
      }
      return;
    }
    if (segmentCount !== null) {
      if (activeSegmentIndex !== null) {
        const segEl = segmentRefs.current[activeSegmentIndex];
        if (segEl) {
          segEl.classList.remove("is-pulsing");
          void segEl.offsetWidth;
          segEl.classList.add("is-pulsing");
        }
      }
      return;
    }
    void el.offsetWidth;
    el.classList.add("pulse");
  }, [
    vizStatsPulseId,
    bpmBarEnabled,
    bpmBarStyle,
    isSmoothStyle,
    segmentCount,
    activeSegmentIndex,
    playMode,
    vizStatsPulseBeatIndex,
    vizStatsPulseBeat,
  ]);

  // Resize the active controller when the viz becomes visible.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const ctx = getAppContext();
    if (playMode === "autocanonizer") {
      ctx.autocanonizer?.resizeNow();
    } else if (playMode === "songsync") {
      ctx.songsync?.resizeNow();
    } else if (playMode === "wubmachine") {
      ctx.wubmachine?.resizeNow();
    } else {
      ctx.jukebox?.resizeActive();
    }
  }, [visible, playMode]);

  /**
   * Renders the BPM bar beat segments either standalone or overlaid on the smooth bar.
   */
  const renderBpmBarSegments = (overlay: boolean) => {
    if (segmentCount === null) {
      return null;
    }
    const baseClass =
      segmentCount > 8 ? "bpm-bar-segments is-dense" : "bpm-bar-segments";
    return (
      <div
        id="bpm-bar-segments"
        className={overlay ? `${baseClass} is-overlay` : baseClass}
        aria-hidden="true"
      >
        {Array.from({ length: segmentCount }, (_, idx) => (
          <span
            key={idx}
            ref={(node) => {
              segmentRefs.current[idx] = node;
            }}
            data-bpm-segment={idx + 1}
            className={
              idx === 0 ? "bpm-bar-segment is-downbeat" : "bpm-bar-segment"
            }
          />
        ))}
      </div>
    );
  };

  return (
    <div
      id="viz-panel"
      className={visible ? undefined : "hidden"}
      ref={handlePanelRef}
    >
      <div
        id="jukebox-viz"
        className={
          showKaraokeLyrics
            ? `${VIZ_CLASS_NAMES[playMode]} has-karaoke-lyrics`
            : VIZ_CLASS_NAMES[playMode]
        }
      >
        <BranchStatsPopup />
        <CustomAnchorInfo />
        <ModifierBadges />
        <div className="viz-top">
          <VizTop />
        </div>
        <div id="viz-layer" className="viz-layer" ref={vizLayerRef}></div>
        <div
          id="canonizer-layer"
          className="canonizer-layer"
          ref={canonizerLayerRef}
        ></div>
        <div
          id="songsync-layer"
          className="songsync-layer"
          ref={songSyncLayerRef}
        ></div>
        <div
          id="wubmachine-layer"
          className="wubmachine-layer"
          ref={wubMachineLayerRef}
        ></div>
        <LyricsKaraokeBar />
        <div
          className="viz-bottom"
          id="viz-stats"
          ref={vizStatsRef}
        >
          {bpmBarEnabled && isSmoothStyle ? (
            <div
              id="bpm-bar-smooth"
              className={
                isPaused ? "bpm-bar-smooth is-paused" : "bpm-bar-smooth"
              }
              aria-hidden="true"
            >
              <span
                id="bpm-bar-smooth-fill"
                ref={smoothFillRef}
                className="bpm-bar-smooth-fill"
              />
              {showSegmentOverlay ? renderBpmBarSegments(true) : null}
              {segmentCount !== null && segmentCount >= 2 ? (
                <div id="bpm-bar-smooth-ticks" className="bpm-bar-smooth-ticks">
                  {Array.from({ length: segmentCount - 1 }, (_, idx) => (
                    <span
                      key={idx}
                      data-bpm-tick={idx + 1}
                      className="bpm-bar-smooth-tick"
                      style={{
                        left: `${((idx + 1) / segmentCount) * 100}%`,
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : bpmBarEnabled && segmentCount !== null ? (
            renderBpmBarSegments(false)
          ) : null}
          <div className="viz-bottom-left">
            <div className="viz-play-controls">
              <PlayControls />
            </div>
            <div className="viz-info">
              <VizInfo />
            </div>
          </div>
          <div className="viz-bottom-right">
            <VizBottomRight />
          </div>
        </div>
      </div>
    </div>
  );
}
