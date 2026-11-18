import { useState } from "react";
import {
  CANONIZER_FINISH_KEY,
  VISUALIZATION_LABELS,
  WUB_MACHINE_LOOP_KEY,
} from "../../constants";
import { trackEvent } from "../../analytics";
import { getAppContext } from "../../runtime";
import {
  disableMultiTrackMix,
  loadMultiTrackMix,
} from "../../playback";
import { showToast } from "../../ui";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import { useAppStore } from "../../store";
import {
  setActiveVisualization,
  setCanonizerFinish,
  setPlayMode,
  setWubMachineLoop,
} from "../../playback-ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CustomAnchorButton, CustomAnchorToolbar } from "./CustomAnchorEditor";

function getVisualizationLabel(index: number, t: TFunction) {
  return VISUALIZATION_LABELS[index] ??
    t("playback.visualizationNumber", { number: index + 1 });
}

function getVisualizationSelectEntries(count: number, t: TFunction) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: getVisualizationLabel(index, t),
  })).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

// The viz-top controls: play-mode select, visualization select, the
// autocanonizer finish-out checkbox and the Wub Machine loop checkbox. Rendered into the .viz-top container.
// The custom anchor toolbar replaces them while it is open.
export function VizTop() {
  const { t } = useTranslation();
  const playMode = useAppStore((s) => s.playMode);
  const activeVizIndex = useAppStore((s) => s.activeVizIndex);
  const audioLoaded = useAppStore((s) => s.audioLoaded);
  const analysisLoaded = useAppStore((s) => s.analysisLoaded);
  const audioModePreparing = useAppStore((s) => s.audioModePreparing);
  const anchorEditing = useAppStore((s) => s.customAnchorEdit !== null);
  const playlistCount = useAppStore((s) => s.playlist.tracks.length);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const [finishOutSong, setFinishOutSong] = useState(
    () => localStorage.getItem(CANONIZER_FINISH_KEY) === "true",
  );
  const [loopTrack, setLoopTrack] = useState(
    () => localStorage.getItem(WUB_MACHINE_LOOP_KEY) === "true",
  );

  const vizSelectDisabled =
    !(audioLoaded && analysisLoaded) ||
    audioModePreparing ||
    playMode !== "jukebox";
  // On the very first render the controllers are not constructed yet (the
  // ref handoff happens at commit); fall back to the static label count.
  const entries = getVisualizationSelectEntries(
    getAppContext().jukebox?.getCount() ?? VISUALIZATION_LABELS.length,
    t,
  );

  if (anchorEditing) {
    return <CustomAnchorToolbar />;
  }

  return (
    <>
      <div className="viz-actions">
        <label className="viz-select-group" htmlFor="play-mode-select">
          <span className="viz-select-wrap">
            <select
              id="play-mode-select"
              className="viz-select"
              aria-label={t("playback.mode")}
              value={playMode}
              onChange={(event) => setPlayMode(event.target.value as PlayMode)}
            >
              <option value="autocanonizer">{t("playback.autocanonizer")}</option>
              <option value="jukebox">{t("playback.jukebox")}</option>
              <option value="wubmachine">{t("playback.wubMachine")}</option>
            </select>
            <span
              className="material-symbols-outlined viz-select-arrow"
              aria-hidden="true"
            >
              arrow_drop_down
            </span>
          </span>
        </label>
        <CustomAnchorButton />
        {playMode === "jukebox" &&
        ((audioLoaded && analysisLoaded) || multiTrackEnabled) ? (
          <button
            type="button"
            id="multi-track-mix-toggle"
            className={
              multiTrackEnabled
                ? "custom-anchor-button is-active"
                : "custom-anchor-button"
            }
            onClick={() => {
              const ctx = getAppContext();
              if (multiTrackEnabled) {
                void disableMultiTrackMix(ctx);
                return;
              }
              if (playlistCount >= 2) {
                useAppStore.setState({ playlistAddSticky: false });
                void loadMultiTrackMix(ctx);
                return;
              }
              useAppStore.setState({ playlistAddSticky: true });
              useAppStore.getState().selectTab("top");
              showToast("Click + on a song to add it to your mix");
            }}
          >
            {multiTrackEnabled ? "Unmix Songs" : "Mix Songs"}
          </button>
        ) : null}
      </div>
      <div className="viz-controls">
        <label className="viz-select-group" htmlFor="viz-select">
          <span className="viz-select-wrap">
            <select
              id="viz-select"
              className="viz-select"
              aria-label={t("playback.visualization")}
              disabled={vizSelectDisabled}
              value={String(activeVizIndex)}
              onChange={(event) => {
                const idx = Number(event.target.value);
                if (Number.isFinite(idx)) {
                  // Report the label, not the index: reordering the label list
                  // would otherwise silently remap historical data.
                  trackEvent("select_viz", {
                    viz: VISUALIZATION_LABELS[idx] ?? String(idx),
                  });
                  setActiveVisualization(idx);
                }
              }}
            >
              {entries.map((entry) => (
                <option key={entry.index} value={String(entry.index)}>
                  {entry.label}
                </option>
              ))}
            </select>
            <span
              className="material-symbols-outlined viz-select-arrow"
              aria-hidden="true"
            >
              arrow_drop_down
            </span>
          </span>
        </label>
      </div>
      <label className="canonizer-finish">
        <input
          type="checkbox"
          id="canonizer-finish"
          checked={finishOutSong}
          onChange={(event) => {
            setFinishOutSong(event.target.checked);
            setCanonizerFinish(event.target.checked);
          }}
        />
        <span>{t("playback.finishTrack")}</span>
      </label>
      <label className="wubmachine-loop">
        <input
          type="checkbox"
          id="wubmachine-loop"
          checked={loopTrack}
          onChange={(event) => {
            setLoopTrack(event.target.checked);
            setWubMachineLoop(event.target.checked);
          }}
        />
        <span>{t("playback.loopTrack")}</span>
      </label>
    </>
  );
}
