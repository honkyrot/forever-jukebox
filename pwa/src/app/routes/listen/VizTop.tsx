import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { getVisualizationLabel } from "./labels";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import type {
  AutocanonizerMixAlignmentMode,
  AutocanonizerQuadBranchMode,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerController";

export function VizTop({
  playMode,
  onPlayModeChange,
  activeVizIndex,
  vizCount,
  onActiveVizChange,
  finishOutSong,
  onFinishOutSongChange,
  loopTrack,
  onLoopTrackChange,
  canMix = false,
  activeMixEnabled = false,
  autocanonizerMixEnabled = false,
  autocanonizerMixAlignment = "cover-sync",
  autocanonizerQuadMode = false,
  autocanonizerQuadBranchMode = "synced",
  onToggleMix,
  onSwapAutocanonizerMix,
  onToggleAutocanonizerQuad,
  onAutocanonizerQuadBranchModeChange,
  onAutocanonizerMixAlignmentChange,
  action,
}: {
  playMode: PlayMode;
  onPlayModeChange: (mode: PlayMode) => void;
  activeVizIndex: number;
  vizCount: number;
  onActiveVizChange: (index: number) => void;
  finishOutSong: boolean;
  onFinishOutSongChange: (checked: boolean) => void;
  loopTrack: boolean;
  onLoopTrackChange: (checked: boolean) => void;
  canMix?: boolean;
  activeMixEnabled?: boolean;
  autocanonizerMixEnabled?: boolean;
  autocanonizerMixAlignment?: AutocanonizerMixAlignmentMode;
  autocanonizerQuadMode?: boolean;
  autocanonizerQuadBranchMode?: AutocanonizerQuadBranchMode;
  onToggleMix?: () => void;
  onSwapAutocanonizerMix?: () => void;
  onToggleAutocanonizerQuad?: () => void;
  onAutocanonizerQuadBranchModeChange?: (
    mode: AutocanonizerQuadBranchMode,
  ) => void;
  onAutocanonizerMixAlignmentChange?: (
    mode: AutocanonizerMixAlignmentMode,
  ) => void;
  // Shown after the play-mode select, such as the custom anchor button.
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const isCanonizer = playMode === "autocanonizer";
  const entries = Array.from({ length: vizCount }, (_, index) => ({
    index,
    label: getVisualizationLabel(index, t),
  })).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );

  return (
    <div className="viz-top">
      <div className="viz-actions">
        <label className="viz-select-group" htmlFor="play-mode-select">
          <span className="viz-select-wrap">
            <select
              id="play-mode-select"
              className="viz-select"
              aria-label={t("listen.mode")}
              value={playMode}
              onChange={(event) =>
                onPlayModeChange(event.target.value as PlayMode)
              }
            >
              <option value="autocanonizer">{t("listen.autocanonizer")}</option>
              <option value="jukebox">{t("listen.jukebox")}</option>
              <option value="songsync">{t("listen.songSync")}</option>
              <option value="wubmachine">{t("listen.wubMachine")}</option>
            </select>
            <SymbolIcon className="viz-select-arrow" name="arrow_drop_down" />
          </span>
        </label>
        {action}
        {(playMode === "jukebox" || isCanonizer) &&
        (canMix || activeMixEnabled) &&
        onToggleMix ? (
          <button
            type="button"
            id="multi-track-mix-toggle"
            className={
              activeMixEnabled
                ? "custom-anchor-button is-active"
                : "custom-anchor-button"
            }
            title={
              isCanonizer
                ? autocanonizerMixEnabled
                  ? t("mix.exitCanonizerTitle")
                  : t("mix.enterCanonizerTitle")
                : undefined
            }
            onClick={onToggleMix}
          >
            {activeMixEnabled
              ? t("mix.unmixSongs")
              : isCanonizer
                ? t("mix.mix2Songs")
                : t("mix.mixSongs")}
          </button>
        ) : null}
        {isCanonizer && autocanonizerMixEnabled ? (
          <>
            <button
              type="button"
              id="canonizer-mix-swap"
              className="custom-anchor-button"
              title={t("mix.flipSongsTitle")}
              onClick={onSwapAutocanonizerMix}
            >
              {t("mix.flipSongs")}
            </button>
            <span className="viz-actions-divider" aria-hidden="true" />
            <button
              type="button"
              id="canonizer-quad-toggle"
              className={
                autocanonizerQuadMode
                  ? "custom-anchor-button is-active"
                  : "custom-anchor-button"
              }
              aria-pressed={autocanonizerQuadMode}
              title={t("mix.quadModeTitle")}
              onClick={onToggleAutocanonizerQuad}
            >
              {t("mix.quadMode")}
            </button>
            <span className="viz-actions-divider" aria-hidden="true" />
            {autocanonizerQuadMode ? (
              <div
                id="canonizer-quad-branch-group"
                className="canonizer-alignment-toggle"
                role="group"
                aria-label={t("mix.quadBranchMode")}
              >
                <button
                  type="button"
                  id="canonizer-quad-branch-synced"
                  className={
                    autocanonizerQuadBranchMode === "synced"
                      ? "custom-anchor-button is-active"
                      : "custom-anchor-button"
                  }
                  aria-pressed={autocanonizerQuadBranchMode === "synced"}
                  title={t("mix.quadSyncedTitle")}
                  onClick={() =>
                    onAutocanonizerQuadBranchModeChange?.("synced")
                  }
                >
                  {t("mix.quadSynced")}
                </button>
                <button
                  type="button"
                  id="canonizer-quad-branch-independent"
                  className={
                    autocanonizerQuadBranchMode === "independent"
                      ? "custom-anchor-button is-active"
                      : "custom-anchor-button"
                  }
                  aria-pressed={autocanonizerQuadBranchMode === "independent"}
                  title={t("mix.quadIndependentTitle")}
                  onClick={() =>
                    onAutocanonizerQuadBranchModeChange?.("independent")
                  }
                >
                  {t("mix.quadIndependent")}
                </button>
              </div>
            ) : (
              <div
                id="canonizer-mix-alignment-group"
                className="canonizer-alignment-toggle"
                role="group"
                aria-label={t("mix.alignmentMode")}
              >
                <button
                  type="button"
                  id="canonizer-alignment-cover-sync"
                  className={
                    autocanonizerMixAlignment === "cover-sync"
                      ? "custom-anchor-button is-active"
                      : "custom-anchor-button"
                  }
                  aria-pressed={autocanonizerMixAlignment === "cover-sync"}
                  title={t("mix.coverSyncTitle")}
                  onClick={() =>
                    onAutocanonizerMixAlignmentChange?.("cover-sync")
                  }
                >
                  {t("mix.coverSync")}
                </button>
                <button
                  type="button"
                  id="canonizer-alignment-section-fold"
                  className={
                    autocanonizerMixAlignment === "section-fold"
                      ? "custom-anchor-button is-active"
                      : "custom-anchor-button"
                  }
                  aria-pressed={autocanonizerMixAlignment === "section-fold"}
                  title={t("mix.sectionFoldTitle")}
                  onClick={() =>
                    onAutocanonizerMixAlignmentChange?.("section-fold")
                  }
                >
                  {t("mix.sectionFold")}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
      <div className="viz-controls">
        <label className="viz-select-group" htmlFor="viz-select">
          <span className="viz-select-wrap">
            <select
              id="viz-select"
              className="viz-select"
              aria-label={t("listen.visualization")}
              value={String(activeVizIndex)}
              onChange={(event) => onActiveVizChange(Number(event.target.value))}
              disabled={playMode !== "jukebox"}
            >
              {entries.map((entry) => (
                <option key={entry.index} value={entry.index}>
                  {entry.label}
                </option>
              ))}
            </select>
            <SymbolIcon className="viz-select-arrow" name="arrow_drop_down" />
          </span>
        </label>
      </div>
      <label className="canonizer-finish">
        <input
          id="canonizer-finish"
          type="checkbox"
          checked={finishOutSong}
          onChange={(event) => onFinishOutSongChange(event.target.checked)}
        />
        <span>{t("listen.finishTrack")}</span>
      </label>
      <label className="songsync-loop">
        <input
          id="songsync-loop"
          type="checkbox"
          checked={loopTrack}
          onChange={(event) => onLoopTrackChange(event.target.checked)}
        />
        <span>{t("listen.loopTrack")}</span>
      </label>
      <label className="wubmachine-loop">
        <input
          id="wubmachine-loop"
          type="checkbox"
          checked={loopTrack}
          onChange={(event) => onLoopTrackChange(event.target.checked)}
        />
        <span>{t("listen.loopTrack")}</span>
      </label>
    </div>
  );
}
