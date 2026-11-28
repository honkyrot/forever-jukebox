import { useEffect, useRef, useState } from "react";
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
  setAutocanonizerQuadSongGainPct,
  setAutocanonizerQuadStreamPans,
  setAutocanonizerSongGainPct,
  setAutocanonizerStreamPans,
  setMasterVolume,
  setSongSyncTrackBeatOffset,
  setSongSyncTrackGainPct,
  setSongSyncTrackMuted,
  setSongSyncTrackPan,
} from "../../playback";
import {
  hasActivePlaylistControls,
  hasPlaylistControls,
} from "../../playlist";
import { getAppContext } from "../../runtime";
import { useAppStore } from "../../store";
import { toggleFullscreen } from "../../fullscreen";
import { storeVolumePct } from "../../volume";
import { storeAudioBalance } from "../../audioBalance";
import { useTranslation } from "react-i18next";

function VoiceBalanceControls({
  panId,
  gainId,
  panLabel,
  gainAriaLabel,
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
  leftLabel: string;
  rightLabel: string;
  color: string;
  pan: number;
  gainPct: number;
  showGain: boolean;
  onPanChange: (value: number) => void;
  onGainChange: (value: number) => void;
}) {
  return (
    <>
      <label className="stream-pan-control">
        <div className="label-line">
          <span className="pan-end-label">{leftLabel}</span>
          <span style={{ color }}>{panLabel}</span>
          <span className="pan-end-label">{rightLabel}</span>
        </div>
        <div className="pan-slider-wrap">
          <input
            className="pan-slider stream-pan-slider"
            id={panId}
            type="range"
            aria-label={panLabel}
            min={-100}
            max={100}
            step={5}
            value={pan}
            style={{ accentColor: color }}
            onChange={(event) => onPanChange(Number(event.target.value))}
          />
          <div className="pan-ticks" aria-hidden="true">
            <span className="pan-tick is-major" style={{ left: "0%" }} />
            <span className="pan-tick is-minor" style={{ left: "25%" }} />
            <span className="pan-tick is-major" style={{ left: "50%" }} />
            <span className="pan-tick is-minor" style={{ left: "75%" }} />
            <span className="pan-tick is-major" style={{ left: "100%" }} />
          </div>
        </div>
      </label>
      {showGain ? (
        <label className="stream-pan-control">
          <div className="label-line stream-gain-line">
            <span style={{ color }}>Volume</span>
            <span className="stream-gain-value">{gainPct}%</span>
          </div>
          <input
            className="pan-slider stream-pan-slider"
            id={gainId}
            type="range"
            aria-label={gainAriaLabel}
            min={MIN_MIX_TRACK_GAIN_PCT}
            max={MAX_MIX_TRACK_GAIN_PCT}
            step={5}
            value={gainPct}
            style={{ accentColor: color }}
            onChange={(event) => onGainChange(Number(event.target.value))}
          />
        </label>
      ) : null}
    </>
  );
}

// The right-hand cluster of the viz bottom bar: playlist-open button,
// volume panel, fullscreen toggle. Rendered into the .viz-bottom-right
// container.
export function VizBottomRight() {
  const { t } = useTranslation();
  const playlist = useAppStore((s) => s.playlist);
  const volumePct = useAppStore((s) => s.volumePct);
  const playMode = useAppStore((s) => s.playMode);
  const mainPan = useAppStore((s) => s.autocanonizerMainPan);
  const otherPan = useAppStore((s) => s.autocanonizerOtherPan);
  const pinkPan = useAppStore((s) => s.autocanonizerPinkPan);
  const goldPan = useAppStore((s) => s.autocanonizerGoldPan);
  const mainGainPct = useAppStore((s) => s.autocanonizerMainGainPct);
  const otherGainPct = useAppStore((s) => s.autocanonizerOtherGainPct);
  const pinkGainPct = useAppStore((s) => s.autocanonizerPinkGainPct);
  const goldGainPct = useAppStore((s) => s.autocanonizerGoldGainPct);
  const autocanonizerMixEnabled = useAppStore(
    (s) => s.autocanonizerMixEnabled,
  );
  const autocanonizerQuadMode = useAppStore((s) => s.autocanonizerQuadMode);
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
  const autocanonizerMixTrackTitles = useAppStore(
    (s) => s.autocanonizerMixTrackTitles,
  );
  const songSyncTracks = useAppStore((s) => s.songSyncTracks);
  const isFullscreen = useAppStore((s) => s.isFullscreen);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [panOpen, setPanOpen] = useState(false);
  const volumeWrapRef = useRef<HTMLDivElement | null>(null);
  const panWrapRef = useRef<HTMLDivElement | null>(null);
  const isCanonizer = playMode === "autocanonizer";
  const isSongSync = playMode === "songsync";

  // Click-away closes the open audio panels.
  useEffect(() => {
    if (!volumeOpen && !panOpen) {
      return;
    }
    const onDocumentClick = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (volumeWrapRef.current?.contains(target) ||
          panWrapRef.current?.contains(target))
      ) {
        return;
      }
      setVolumeOpen(false);
      setPanOpen(false);
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [volumeOpen, panOpen]);

  useEffect(() => {
    if (!isCanonizer && !isSongSync) {
      setPanOpen(false);
    }
  }, [isCanonizer, isSongSync]);

  const hasTracks = hasPlaylistControls(playlist);
  const active = hasActivePlaylistControls(playlist);
  const playlistTitle = active
    ? t("playlist.savedWithPosition", {
        current: playlist.currentIndex + 1,
        total: playlist.tracks.length,
      })
    : t("playlist.saved");
  const fullscreenLabel = isFullscreen
    ? t("playback.exitFullscreen")
    : t("playback.fullscreen");

  const handleVolumeChange = (pct: number) => {
    useAppStore.setState({ volumePct: pct });
    setMasterVolume(getAppContext(), pct);
    storeVolumePct(pct);
  };

  const handleStreamPanChange = (stream: "main" | "other", pan: number) => {
    const nextMain = stream === "main" ? pan : mainPan;
    const nextOther = stream === "other" ? pan : otherPan;
    useAppStore.setState({
      autocanonizerMainPan: nextMain,
      autocanonizerOtherPan: nextOther,
    });
    setAutocanonizerStreamPans(getAppContext(), nextMain, nextOther);
    storeAudioBalance(nextMain, nextOther, pinkPan, goldPan);
  };

  const handleQuadPanChange = (stream: "pink" | "gold", pan: number) => {
    const nextPink = stream === "pink" ? pan : pinkPan;
    const nextGold = stream === "gold" ? pan : goldPan;
    setAutocanonizerQuadStreamPans(getAppContext(), nextPink, nextGold);
    storeAudioBalance(mainPan, otherPan, nextPink, nextGold);
  };

  const handleResetBalance = () => {
    const ctx = getAppContext();
    useAppStore.setState({
      autocanonizerMainPan: 0,
      autocanonizerOtherPan: 0,
    });
    setAutocanonizerStreamPans(ctx, 0, 0);
    storeAudioBalance(0, 0, isQuadMix ? 0 : pinkPan, isQuadMix ? 0 : goldPan);
    setAutocanonizerSongGainPct(ctx, "main", DEFAULT_MIX_TRACK_GAIN_PCT);
    setAutocanonizerSongGainPct(ctx, "other", DEFAULT_MIX_TRACK_GAIN_PCT);
    if (isQuadMix) {
      setAutocanonizerQuadStreamPans(ctx, 0, 0);
      setAutocanonizerQuadSongGainPct(ctx, "pink", DEFAULT_MIX_TRACK_GAIN_PCT);
      setAutocanonizerQuadSongGainPct(ctx, "gold", DEFAULT_MIX_TRACK_GAIN_PCT);
    }
  };

  const isQuadMix = autocanonizerMixEnabled && autocanonizerQuadMode;
  const isSingleMulti = !autocanonizerMixEnabled && singleVoiceCount >= 3;
  const isSingleQuad = !autocanonizerMixEnabled && singleVoiceCount === 4;
  const hasNonDefaultDualBalance =
    mainPan !== 0 ||
    otherPan !== 0 ||
    mainGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
    otherGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
    (isQuadMix &&
      (pinkPan !== 0 ||
        goldPan !== 0 ||
        pinkGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT ||
        goldGainPct !== DEFAULT_MIX_TRACK_GAIN_PCT));
  const mainSongLabel = autocanonizerMixTrackTitles?.[0] ?? "Song 1";
  const otherSongLabel = autocanonizerMixTrackTitles?.[1] ?? "Song 2";
  const panelClasses = [
    "pan-control-panel",
    panOpen ? "" : "is-hidden",
    autocanonizerMixEnabled ? "is-dual" : "",
    isQuadMix ? "is-quad" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        id="playlist-open"
        className={
          hasTracks
            ? "playlist-control playlist-open-control"
            : "playlist-control playlist-open-control is-hidden"
        }
        type="button"
        aria-label={playlistTitle}
        title={playlistTitle}
        onClick={() => useAppStore.setState({ playlistModalOpen: true })}
      >
        <span
          className="material-symbols-outlined playlist-control-icon"
          aria-hidden="true"
        >
          queue_music
        </span>
      </button>
      {isCanonizer ? (
        <div className="pan-control-wrap" ref={panWrapRef}>
          <div className={panelClasses} id="autocanonizer-pan-control-panel">
            <div className={autocanonizerMixEnabled ? "stream-balance-group" : undefined}>
              {autocanonizerMixEnabled ? (
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
                  isQuadMix
                    ? `${t("playback.blueBalance")} (Main)`
                    : t("playback.blueBalance")
                }
                gainAriaLabel={`${mainSongLabel} Blue volume`}
                leftLabel={t("playback.balanceLeft")}
                rightLabel={t("playback.balanceRight")}
                color={AUTOCANONIZER_MAIN_COLOR}
                pan={mainPan}
                gainPct={mainGainPct}
                showGain={autocanonizerMixEnabled}
                onPanChange={(value) => handleStreamPanChange("main", value)}
                onGainChange={(value) =>
                  setAutocanonizerSongGainPct(getAppContext(), "main", value)
                }
              />
              {isQuadMix ? (
                <VoiceBalanceControls
                  panId="autocanonizer-other-pan"
                  gainId="autocanonizer-other-gain"
                  panLabel={`${t("playback.greenBalance")} (Branch)`}
                  gainAriaLabel={`${mainSongLabel} Green volume`}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={AUTOCANONIZER_OTHER_COLOR}
                  pan={otherPan}
                  gainPct={otherGainPct}
                  showGain
                  onPanChange={(value) => handleStreamPanChange("other", value)}
                  onGainChange={(value) =>
                    setAutocanonizerSongGainPct(getAppContext(), "other", value)
                  }
                />
              ) : null}
            </div>
            {isQuadMix ? (
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
                  panLabel="Pink balance (Synced)"
                  gainAriaLabel={`${otherSongLabel} Pink volume`}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={AUTOCANONIZER_PINK_COLOR}
                  pan={pinkPan}
                  gainPct={pinkGainPct}
                  showGain
                  onPanChange={(value) => handleQuadPanChange("pink", value)}
                  onGainChange={(value) =>
                    setAutocanonizerQuadSongGainPct(
                      getAppContext(),
                      "pink",
                      value,
                    )
                  }
                />
                <VoiceBalanceControls
                  panId="autocanonizer-gold-pan"
                  gainId="autocanonizer-gold-gain"
                  panLabel="Gold balance (Branch)"
                  gainAriaLabel={`${otherSongLabel} Gold volume`}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={AUTOCANONIZER_GOLD_COLOR}
                  pan={goldPan}
                  gainPct={goldGainPct}
                  showGain
                  onPanChange={(value) => handleQuadPanChange("gold", value)}
                  onGainChange={(value) =>
                    setAutocanonizerQuadSongGainPct(
                      getAppContext(),
                      "gold",
                      value,
                    )
                  }
                />
              </div>
            ) : (
              <div className={autocanonizerMixEnabled ? "stream-balance-group" : undefined}>
                {autocanonizerMixEnabled ? (
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
                  panLabel={t("playback.greenBalance")}
                  gainAriaLabel={`${otherSongLabel} volume`}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={AUTOCANONIZER_OTHER_COLOR}
                  pan={otherPan}
                  gainPct={otherGainPct}
                  showGain={autocanonizerMixEnabled}
                  onPanChange={(value) => handleStreamPanChange("other", value)}
                  onGainChange={(value) =>
                    setAutocanonizerSongGainPct(getAppContext(), "other", value)
                  }
                />
              </div>
            )}
            {isSingleMulti ? (
              <div>
                <VoiceBalanceControls
                  panId="autocanonizer-gold-pan"
                  gainId="autocanonizer-gold-gain"
                  panLabel={t("playback.goldBalance")}
                  gainAriaLabel={t("playback.goldBalance")}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={AUTOCANONIZER_GOLD_COLOR}
                  pan={goldPan}
                  gainPct={goldGainPct}
                  showGain={false}
                  onPanChange={(value) => handleQuadPanChange("gold", value)}
                  onGainChange={(value) =>
                    setAutocanonizerQuadSongGainPct(
                      getAppContext(),
                      "gold",
                      value,
                    )
                  }
                />
                {isSingleQuad ? (
                  <VoiceBalanceControls
                    panId="autocanonizer-pink-pan"
                    gainId="autocanonizer-pink-gain"
                    panLabel={t("playback.pinkBalance")}
                    gainAriaLabel={t("playback.pinkBalance")}
                    leftLabel={t("playback.balanceLeft")}
                    rightLabel={t("playback.balanceRight")}
                    color={AUTOCANONIZER_PINK_COLOR}
                    pan={pinkPan}
                    gainPct={pinkGainPct}
                    showGain={false}
                    onPanChange={(value) => handleQuadPanChange("pink", value)}
                    onGainChange={(value) =>
                      setAutocanonizerQuadSongGainPct(
                        getAppContext(),
                        "pink",
                        value,
                      )
                    }
                  />
                ) : null}
              </div>
            ) : null}
            {autocanonizerMixEnabled && hasNonDefaultDualBalance ? (
              <button
                type="button"
                id="autocanonizer-balance-reset"
                className="custom-anchor-button stream-balance-reset"
                onClick={handleResetBalance}
              >
                {t("common.reset")}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            id="autocanonizer-pan-button"
            className="volume-button pan-button"
            aria-label={t("playback.audioBalance")}
            title={t("playback.audioBalance")}
            onClick={() => {
              setVolumeOpen(false);
              setPanOpen((prev) => !prev);
            }}
          >
            <span
              className="material-symbols-outlined pan-icon"
              aria-hidden="true"
            >
              swap_horiz
            </span>
          </button>
        </div>
      ) : null}
      {isSongSync && songSyncTracks.length > 0 ? (
        <div className="pan-control-wrap" ref={panWrapRef}>
          <div
            className={
              panOpen
                ? "pan-control-panel is-dual"
                : "pan-control-panel is-dual is-hidden"
            }
            id="songsync-mixer-panel"
          >
            {songSyncTracks.map((track, idx) => (
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
                  gainAriaLabel={`${track.title} volume`}
                  leftLabel={t("playback.balanceLeft")}
                  rightLabel={t("playback.balanceRight")}
                  color={track.color}
                  pan={track.pan}
                  gainPct={track.gainPct}
                  showGain
                  onPanChange={(value) =>
                    setSongSyncTrackPan(getAppContext(), idx, value)
                  }
                  onGainChange={(value) =>
                    setSongSyncTrackGainPct(getAppContext(), idx, value)
                  }
                />
                <div className="songsync-popover-actions">
                  <button
                    type="button"
                    className={
                      track.muted
                        ? "custom-anchor-button is-active"
                        : "custom-anchor-button"
                    }
                    onClick={() =>
                      setSongSyncTrackMuted(getAppContext(), idx, !track.muted)
                    }
                  >
                    {t("tuning.mute")}
                  </button>
                  <button
                    type="button"
                    className="custom-anchor-button"
                    onClick={() =>
                      setSongSyncTrackBeatOffset(
                        getAppContext(),
                        idx,
                        track.beatOffset - 1,
                      )
                    }
                  >
                    -1b
                  </button>
                  <span className="hint">{track.beatOffset >= 0 ? `+${track.beatOffset}` : track.beatOffset}</span>
                  <button
                    type="button"
                    className="custom-anchor-button"
                    onClick={() =>
                      setSongSyncTrackBeatOffset(
                        getAppContext(),
                        idx,
                        track.beatOffset + 1,
                      )
                    }
                  >
                    +1b
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            id="songsync-mixer-button"
            className="volume-button pan-button"
            aria-label={t("playback.audioBalance")}
            title={t("playback.audioBalance")}
            onClick={() => {
              setVolumeOpen(false);
              setPanOpen((prev) => !prev);
            }}
          >
            <span
              className="material-symbols-outlined pan-icon"
              aria-hidden="true"
            >
              tune
            </span>
          </button>
        </div>
      ) : null}
      <div className="volume-control-wrap" ref={volumeWrapRef}>
        <div
          className={
            volumeOpen ? "volume-control-panel" : "volume-control-panel is-hidden"
          }
          id="volume-control-panel"
        >
          <label>
            <input
              className="volume-slider"
              id="volume"
              type="range"
              aria-label={t("playback.volume")}
              min={0}
              max={100}
              step={1}
              value={volumePct}
              onChange={(event) =>
                handleVolumeChange(Number(event.target.value))
              }
            />
            <div className="label-line">
              <span id="volume-val">{volumePct}</span>
            </div>
          </label>
        </div>
        <button
          type="button"
          id="volume-button"
          className="volume-button"
          aria-label={t("playback.volume")}
          title={t("playback.volume")}
          onClick={() => {
            setPanOpen(false);
            setVolumeOpen((prev) => !prev);
          }}
        >
          <span
            className="material-symbols-outlined volume-icon"
            aria-hidden="true"
          >
            {volumePct === 0 ? "volume_off" : "volume_up"}
          </span>
        </button>
      </div>
      <button
        type="button"
        id="fullscreen"
        className="fullscreen-toggle"
        aria-label={fullscreenLabel}
        title={fullscreenLabel}
        onClick={() => toggleFullscreen()}
      >
        <span
          className="material-symbols-outlined fullscreen-icon"
          aria-hidden="true"
        >
          {isFullscreen ? "fullscreen_exit" : "fullscreen"}
        </span>
      </button>
    </>
  );
}
