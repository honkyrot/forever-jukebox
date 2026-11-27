import type React from "react";
import { useTranslation } from "react-i18next";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";

export function PlayMenu({
  playTitleRef,
  playMode,
  bringItHomeMode,
  hasAnalysis,
  isExporting,
  onOpenTuning,
  onOpenInfo,
  onOpenExport,
}: {
  playTitleRef: React.RefCallback<HTMLDivElement>;
  playMode: PlayMode;
  bringItHomeMode: boolean;
  hasAnalysis: boolean;
  isExporting: boolean;
  onOpenTuning: () => void;
  onOpenInfo: () => void;
  onOpenExport: () => void;
}) {
  const { t } = useTranslation();
  // Tuning is available across Jukebox, Autocanonizer, and Song Sync; Track Info
  // describes the single/merged Jukebox graph only.
  const hideTrackInfo = playMode !== "jukebox";
  const hideTuning = playMode === "wubmachine";
  return (
    <div className="menu-bar">
      <div className="menu-left">
        <div className="play-title" ref={playTitleRef}></div>
        {playMode === "jukebox" && bringItHomeMode ? (
          <span className="bring-home-note">{t("listen.bringingHome")}</span>
        ) : null}
      </div>
      <div className="menu-right">
        <button
          id="tuning"
          className={`tune-toggle ${hideTuning ? "is-hidden" : ""}`}
          type="button"
          onClick={onOpenTuning}
          disabled={!hasAnalysis || hideTuning}
          title={t("listen.tune")}
          aria-label={t("listen.tune")}
        >
          <SymbolIcon className="tune-icon" name="tune" />
        </button>
        <button
          id="track-info"
          className={`info-toggle ${hideTrackInfo ? "is-hidden" : ""}`}
          type="button"
          onClick={onOpenInfo}
          disabled={!hasAnalysis || hideTrackInfo}
          title={t("listen.info")}
          aria-label={t("listen.info")}
        >
          <SymbolIcon className="info-icon" name="info" />
        </button>
        <button
          id="track-audio-export"
          className="copy-toggle"
          type="button"
          onClick={onOpenExport}
          disabled={!hasAnalysis || isExporting || playMode === "songsync"}
          title={t("listen.exportAudio")}
          aria-label={t("listen.exportAudio")}
        >
          <SymbolIcon className="copy-icon" name="download" />
        </button>
      </div>
    </div>
  );
}
