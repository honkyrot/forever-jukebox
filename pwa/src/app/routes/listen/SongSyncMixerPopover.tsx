import type React from "react";
import { useTranslation } from "react-i18next";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { VoiceBalanceControls } from "./PanPopover";

export type SongSyncPopoverTrack = {
  title: string;
  color: string;
  pan: number;
  gainPct: number;
  muted: boolean;
  beatOffset: number;
};

/**
 * Compact Song Sync track mixer popover for per-track volume, pan, mute,
 * and beat-offset adjustments during playback.
 */
export function SongSyncMixerPopover({
  isOpen,
  panelRef,
  buttonRef,
  tracks,
  onPanChange,
  onGainChange,
  onMutedChange,
  onBeatOffsetChange,
  onToggle,
}: {
  isOpen: boolean;
  panelRef: React.RefObject<HTMLDivElement>;
  buttonRef: React.RefObject<HTMLButtonElement>;
  tracks: readonly SongSyncPopoverTrack[];
  onPanChange: (trackIndex: number, pan: number) => void;
  onGainChange: (trackIndex: number, gainPct: number) => void;
  onMutedChange: (trackIndex: number, muted: boolean) => void;
  onBeatOffsetChange: (trackIndex: number, beatOffset: number) => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (tracks.length === 0) {
    return null;
  }

  return (
    <div className="pan-control-wrap" ref={panelRef}>
      <div
        className={
          isOpen
            ? "pan-control-panel is-dual"
            : "pan-control-panel is-dual is-hidden"
        }
        id="songsync-mixer-panel"
      >
        {tracks.map((track, idx) => (
          <div key={idx} className="stream-balance-group">
            <div
              className="stream-balance-song-title"
              style={{ color: track.color }}
              title={track.title}
            >
              {track.title}
            </div>
            <VoiceBalanceControls
              panId={`songsync-popover-pan-${idx}`}
              gainId={`songsync-popover-gain-${idx}`}
              panLabel={t("tuning.pan")}
              gainAriaLabel={`${track.title} ${t("listen.volume")}`}
              volumeLabel={t("listen.volume")}
              leftLabel={t("listen.balanceLeft")}
              rightLabel={t("listen.balanceRight")}
              color={track.color}
              pan={track.pan}
              gainPct={track.gainPct}
              showGain
              onPanChange={(value) => onPanChange(idx, value)}
              onGainChange={(value) => onGainChange(idx, value)}
            />
            <div className="songsync-popover-actions">
              <button
                type="button"
                className={
                  track.muted
                    ? "custom-anchor-button is-active"
                    : "custom-anchor-button"
                }
                onClick={() => onMutedChange(idx, !track.muted)}
              >
                {t("tuning.mute")}
              </button>
              <button
                type="button"
                className="custom-anchor-button"
                onClick={() => onBeatOffsetChange(idx, track.beatOffset - 1)}
              >
                -1b
              </button>
              <span className="hint">
                {track.beatOffset >= 0 ? `+${track.beatOffset}` : track.beatOffset}
              </span>
              <button
                type="button"
                className="custom-anchor-button"
                onClick={() => onBeatOffsetChange(idx, track.beatOffset + 1)}
              >
                +1b
              </button>
            </div>
          </div>
        ))}
        <datalist id="autocanonizer-pan-ticks">
          <option value={-100} />
          <option value={0} />
          <option value={100} />
        </datalist>
      </div>
      <button
        ref={buttonRef}
        type="button"
        id="songsync-mixer-button"
        className="volume-button pan-button"
        aria-label={t("listen.audioBalance")}
        title={t("listen.audioBalance")}
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <SymbolIcon className="pan-icon" name="tune" />
      </button>
    </div>
  );
}
