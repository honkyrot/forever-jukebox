import type React from "react";
import { useTranslation } from "react-i18next";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import {
  AUTOCANONIZER_GOLD_COLOR,
  AUTOCANONIZER_MAIN_COLOR,
  AUTOCANONIZER_OTHER_COLOR,
  AUTOCANONIZER_PINK_COLOR,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerViz";
import {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_MIX_TRACK_GAIN_PCT,
  MIN_MIX_TRACK_GAIN_PCT,
} from "./localMix";

function VoiceBalanceControls({
  panId,
  gainId,
  panLabel,
  gainAriaLabel,
  volumeLabel,
  leftLabel,
  rightLabel,
  color,
  pan,
  gainPct,
  showGain,
  onPanChange,
  onGainChange,
}: {
  panId: string;
  gainId: string;
  panLabel: string;
  gainAriaLabel: string;
  volumeLabel: string;
  leftLabel: string;
  rightLabel: string;
  color: string;
  pan: number;
  gainPct: number;
  showGain: boolean;
  onPanChange: (value: number) => void;
  onGainChange?: (value: number) => void;
}) {
  return (
    <>
      <label className="stream-pan-control">
        <div className="label-line">
          <span className="pan-end-label">{leftLabel}</span>
          <span style={{ color }}>{panLabel}</span>
          <span className="pan-end-label">{rightLabel}</span>
        </div>
        <input
          className="pan-slider stream-pan-slider"
          id={panId}
          type="range"
          aria-label={panLabel}
          min={-100}
          max={100}
          step={1}
          list="autocanonizer-pan-ticks"
          value={pan}
          style={{ accentColor: color }}
          onChange={(event) => onPanChange(Number(event.target.value))}
        />
      </label>
      {showGain ? (
        <label className="stream-pan-control">
          <div className="label-line stream-gain-line">
            <span style={{ color }}>{volumeLabel}</span>
            <span className="stream-gain-value">{gainPct}%</span>
          </div>
          <input
            className="pan-slider stream-pan-slider"
            id={gainId}
            type="range"
            aria-label={gainAriaLabel}
            min={MIN_MIX_TRACK_GAIN_PCT}
            max={MAX_MIX_TRACK_GAIN_PCT}
            step={1}
            value={gainPct}
            style={{ accentColor: color }}
            onChange={(event) => onGainChange?.(Number(event.target.value))}
          />
        </label>
      ) : null}
    </>
  );
}

export function PanPopover({
  isOpen,
  panelRef,
  buttonRef,
  mainPan,
  otherPan,
  pinkPan = 0,
  goldPan = 0,
  mainGainPct = DEFAULT_MIX_TRACK_GAIN_PCT,
  otherGainPct = DEFAULT_MIX_TRACK_GAIN_PCT,
  pinkGainPct = DEFAULT_MIX_TRACK_GAIN_PCT,
  goldGainPct = DEFAULT_MIX_TRACK_GAIN_PCT,
  isDualMix = false,
  isQuadMix = false,
  mixTrackTitles = null,
  onPanChange,
  onQuadPanChange,
  onGainChange,
  onQuadGainChange,
  onResetBalance,
  onToggle,
}: {
  isOpen: boolean;
  panelRef: React.RefObject<HTMLDivElement>;
  buttonRef: React.RefObject<HTMLButtonElement>;
  mainPan: number;
  otherPan: number;
  pinkPan?: number;
  goldPan?: number;
  mainGainPct?: number;
  otherGainPct?: number;
  pinkGainPct?: number;
  goldGainPct?: number;
  isDualMix?: boolean;
  isQuadMix?: boolean;
  mixTrackTitles?: [string, string] | null;
  onPanChange: (stream: "main" | "other", value: number) => void;
  onQuadPanChange?: (stream: "pink" | "gold", value: number) => void;
  onGainChange?: (stream: "main" | "other", value: number) => void;
  onQuadGainChange?: (stream: "pink" | "gold", value: number) => void;
  onResetBalance?: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const quadActive = isDualMix && isQuadMix;
  const hasNonDefaultDualBalance =
    mainPan !== 0 ||
    otherPan !== 0 ||
    mainGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
    otherGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
    (quadActive &&
      (pinkPan !== 0 ||
        goldPan !== 0 ||
        pinkGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
        goldGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT));
  const mainSongLabel = mixTrackTitles?.[0] ?? t("mix.songNumber", { index: 1 });
  const otherSongLabel = mixTrackTitles?.[1] ?? t("mix.songNumber", { index: 2 });
  const panelClasses = [
    "pan-control-panel",
    isOpen ? "" : "is-hidden",
    isDualMix ? "is-dual" : "",
    quadActive ? "is-quad" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="pan-control-wrap">
      <div
        className={panelClasses}
        id="autocanonizer-pan-control-panel"
        ref={panelRef}
      >
        <div className={isDualMix ? "stream-balance-group" : undefined}>
          {isDualMix ? (
            <div
              className="stream-balance-song-title"
              style={{ color: AUTOCANONIZER_MAIN_COLOR }}
              title={mainSongLabel}
            >
              {mainSongLabel}
            </div>
          ) : null}
          <VoiceBalanceControls
            panId="autocanonizer-main-pan"
            gainId="autocanonizer-main-gain"
            panLabel={
              quadActive
                ? `${t("listen.blueBalance")} (${t("mix.voiceMain")})`
                : t("listen.blueBalance")
            }
            gainAriaLabel={`${mainSongLabel} ${t("listen.volume")}`}
            volumeLabel={t("listen.volume")}
            leftLabel={t("listen.balanceLeft")}
            rightLabel={t("listen.balanceRight")}
            color={AUTOCANONIZER_MAIN_COLOR}
            pan={mainPan}
            gainPct={mainGainPct}
            showGain={isDualMix}
            onPanChange={(value) => onPanChange("main", value)}
            onGainChange={(value) => onGainChange?.("main", value)}
          />
          {quadActive ? (
            <VoiceBalanceControls
              panId="autocanonizer-other-pan"
              gainId="autocanonizer-other-gain"
              panLabel={`${t("listen.greenBalance")} (${t("mix.voiceBranch")})`}
              gainAriaLabel={`${mainSongLabel} ${t("listen.greenBalance")} ${t("listen.volume")}`}
              volumeLabel={t("listen.volume")}
              leftLabel={t("listen.balanceLeft")}
              rightLabel={t("listen.balanceRight")}
              color={AUTOCANONIZER_OTHER_COLOR}
              pan={otherPan}
              gainPct={otherGainPct}
              showGain
              onPanChange={(value) => onPanChange("other", value)}
              onGainChange={(value) => onGainChange?.("other", value)}
            />
          ) : null}
        </div>
        {quadActive ? (
          <div className="stream-balance-group">
            <div
              className="stream-balance-song-title"
              style={{ color: AUTOCANONIZER_PINK_COLOR }}
              title={otherSongLabel}
            >
              {otherSongLabel}
            </div>
            <VoiceBalanceControls
              panId="autocanonizer-pink-pan"
              gainId="autocanonizer-pink-gain"
              panLabel={t("mix.pinkBalanceSynced")}
              gainAriaLabel={`${otherSongLabel} ${t("mix.pinkBalanceSynced")} ${t("listen.volume")}`}
              volumeLabel={t("listen.volume")}
              leftLabel={t("listen.balanceLeft")}
              rightLabel={t("listen.balanceRight")}
              color={AUTOCANONIZER_PINK_COLOR}
              pan={pinkPan}
              gainPct={pinkGainPct}
              showGain
              onPanChange={(value) => onQuadPanChange?.("pink", value)}
              onGainChange={(value) => onQuadGainChange?.("pink", value)}
            />
            <VoiceBalanceControls
              panId="autocanonizer-gold-pan"
              gainId="autocanonizer-gold-gain"
              panLabel={t("mix.goldBalanceBranch")}
              gainAriaLabel={`${otherSongLabel} ${t("mix.goldBalanceBranch")} ${t("listen.volume")}`}
              volumeLabel={t("listen.volume")}
              leftLabel={t("listen.balanceLeft")}
              rightLabel={t("listen.balanceRight")}
              color={AUTOCANONIZER_GOLD_COLOR}
              pan={goldPan}
              gainPct={goldGainPct}
              showGain
              onPanChange={(value) => onQuadPanChange?.("gold", value)}
              onGainChange={(value) => onQuadGainChange?.("gold", value)}
            />
          </div>
        ) : (
          <div className={isDualMix ? "stream-balance-group" : undefined}>
            {isDualMix ? (
              <div
                className="stream-balance-song-title"
                style={{ color: AUTOCANONIZER_OTHER_COLOR }}
                title={otherSongLabel}
              >
                {otherSongLabel}
              </div>
            ) : null}
            <VoiceBalanceControls
              panId="autocanonizer-other-pan"
              gainId="autocanonizer-other-gain"
              panLabel={t("listen.greenBalance")}
              gainAriaLabel={`${otherSongLabel} ${t("listen.volume")}`}
              volumeLabel={t("listen.volume")}
              leftLabel={t("listen.balanceLeft")}
              rightLabel={t("listen.balanceRight")}
              color={AUTOCANONIZER_OTHER_COLOR}
              pan={otherPan}
              gainPct={otherGainPct}
              showGain={isDualMix}
              onPanChange={(value) => onPanChange("other", value)}
              onGainChange={(value) => onGainChange?.("other", value)}
            />
          </div>
        )}
        {isDualMix && hasNonDefaultDualBalance && onResetBalance ? (
          <button
            type="button"
            id="autocanonizer-balance-reset"
            className="custom-anchor-button stream-balance-reset"
            onClick={onResetBalance}
          >
            {t("common.reset")}
          </button>
        ) : null}
        <datalist id="autocanonizer-pan-ticks">
          <option value={-100} />
          <option value={0} />
          <option value={100} />
        </datalist>
      </div>
      <button
        id="autocanonizer-pan-button"
        className="volume-button pan-button"
        type="button"
        ref={buttonRef}
        onClick={onToggle}
        title={t("listen.audioBalance")}
        aria-label={t("listen.audioBalance")}
      >
        <SymbolIcon className="pan-icon" name="swap_horiz" />
      </button>
    </div>
  );
}
