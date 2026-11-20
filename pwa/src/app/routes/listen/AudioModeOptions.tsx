import { useTranslation } from "react-i18next";
import type { JukeboxAudioMode } from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import {
  MAX_AUDIO_MODE_INTENSITY,
  MIN_AUDIO_MODE_INTENSITY,
  audioModeSupportsIntensity,
} from "@forever-jukebox/shared/audio/audioModes";
import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_METRONOME_BEAT_OFFSET,
  DEFAULT_METRONOME_VOLUME_PCT,
  MAX_METRONOME_VOLUME_PCT,
  METRONOME_TIME_SIGNATURE_OPTIONS,
  MIN_METRONOME_VOLUME_PCT,
  clampMetronomeBeatOffset,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import {
  AUDIO_MODE_SECTIONS,
  audioModeLabel,
  getAudioModeInputId,
  isAudioModeOffered,
  type AudioModeSection,
} from "./audioMode";

function AudioModeRadio({
  option,
  checked,
  disabled,
  onChange,
  className = "",
}: {
  option: JukeboxAudioMode;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <label className={`audio-mode-option ${className}`.trim()}>
      <input
        id={getAudioModeInputId(option)}
        type="radio"
        name="audio-mode"
        value={option}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span>{audioModeLabel(option, t)}</span>
    </label>
  );
}

function AudioModeSectionGroup({
  section,
  selectedAudioMode,
  disabled,
  onChange,
  intensityPct,
  onIntensityChange,
  metronomeVolumePct,
  onMetronomeVolumeChange,
  metronomeBeatsPerBar,
  detectedBeatsPerBar,
  onMetronomeBeatsPerBarChange,
  metronomeBeatOffset,
  onMetronomeBeatOffsetChange,
}: {
  section: AudioModeSection;
  selectedAudioMode: JukeboxAudioMode;
  disabled: boolean;
  onChange: (mode: JukeboxAudioMode) => void;
  intensityPct: number;
  onIntensityChange: (intensityPct: number) => void;
  metronomeVolumePct: number;
  onMetronomeVolumeChange: (volumePct: number) => void;
  metronomeBeatsPerBar: number | null;
  detectedBeatsPerBar: number;
  onMetronomeBeatsPerBarChange: (beatsPerBar: number | null) => void;
  metronomeBeatOffset: number;
  onMetronomeBeatOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const showIntensity =
    section.options.includes(selectedAudioMode) &&
    audioModeSupportsIntensity(selectedAudioMode);
  const showMetronomeControls =
    section.options.includes("metronome") && selectedAudioMode === "metronome";
  const effectiveBeats = metronomeBeatsPerBar ?? detectedBeatsPerBar;
  const clampedOffset = clampMetronomeBeatOffset(
    metronomeBeatOffset,
    effectiveBeats,
  );
  const timeSignatureIndex = Math.max(
    0,
    METRONOME_TIME_SIGNATURE_OPTIONS.indexOf(metronomeBeatsPerBar),
  );
  const timeSignatureText =
    metronomeBeatsPerBar === null
      ? t("audioModes.metronomeTimeSignatureAuto", {
          beats: detectedBeatsPerBar,
        })
      : `${metronomeBeatsPerBar}/4`;
  return (
    <div className="audio-mode-section">
      <div className="audio-mode-section-title">{t(section.titleKey)}</div>
      <div className="audio-mode-section-options">
        {section.options.filter(isAudioModeOffered).map((option) => (
          <AudioModeRadio
            key={option}
            option={option}
            checked={selectedAudioMode === option}
            disabled={disabled}
            onChange={() => onChange(option)}
          />
        ))}
      </div>
      {showIntensity ? (
        <label>
          <div className="label-line">
            <span>{t("audioModes.intensity")}</span>
            <span>{intensityPct}%</span>
          </div>
          <input
            id="audio-intensity"
            type="range"
            aria-label={t("audioModes.intensity")}
            min={MIN_AUDIO_MODE_INTENSITY}
            max={MAX_AUDIO_MODE_INTENSITY}
            step={5}
            value={intensityPct}
            disabled={disabled}
            onChange={(event) => onIntensityChange(Number(event.target.value))}
          />
        </label>
      ) : null}
      {showMetronomeControls ? (
        <>
          <label>
            <div className="label-line">
              <span>{t("audioModes.metronomeVolume")}</span>
              <span id="metronome-volume-val">{metronomeVolumePct}%</span>
            </div>
            <input
              id="metronome-volume"
              type="range"
              aria-label={t("audioModes.metronomeVolume")}
              min={MIN_METRONOME_VOLUME_PCT}
              max={MAX_METRONOME_VOLUME_PCT}
              step={5}
              value={metronomeVolumePct}
              disabled={disabled}
              onChange={(event) =>
                onMetronomeVolumeChange(Number(event.target.value))
              }
            />
          </label>
          <label>
            <div className="label-line">
              <span>{t("audioModes.metronomeTimeSignature")}</span>
              <span id="metronome-time-signature-val">{timeSignatureText}</span>
            </div>
            <input
              id="metronome-time-signature"
              type="range"
              aria-label={t("audioModes.metronomeTimeSignature")}
              min={0}
              max={METRONOME_TIME_SIGNATURE_OPTIONS.length - 1}
              step={1}
              value={timeSignatureIndex}
              disabled={disabled}
              onChange={(event) =>
                onMetronomeBeatsPerBarChange(
                  METRONOME_TIME_SIGNATURE_OPTIONS[
                    Number(event.target.value)
                  ] ?? null,
                )
              }
            />
          </label>
          <label>
            <div className="label-line">
              <span>{t("audioModes.metronomeBeatOffset")}</span>
              <span id="metronome-beat-offset-val">
                {t("audioModes.metronomeBeatOffsetValue", {
                  offset: clampedOffset,
                  beat: clampedOffset + 1,
                })}
              </span>
            </div>
            <input
              id="metronome-beat-offset"
              type="range"
              aria-label={t("audioModes.metronomeBeatOffset")}
              min={0}
              max={Math.max(0, effectiveBeats - 1)}
              step={1}
              value={clampedOffset}
              disabled={disabled}
              onChange={(event) =>
                onMetronomeBeatOffsetChange(Number(event.target.value))
              }
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

const NOOP = () => {};

/**
 * Renders the audio mode radio sections along with intensity and metronome controls.
 */
export function AudioModeOptions({
  selectedAudioMode,
  disabled,
  onChange,
  intensityPct,
  onIntensityChange,
  metronomeVolumePct = DEFAULT_METRONOME_VOLUME_PCT,
  onMetronomeVolumeChange = NOOP,
  metronomeBeatsPerBar = null,
  detectedBeatsPerBar = DEFAULT_BEATS_PER_BAR,
  onMetronomeBeatsPerBarChange = NOOP,
  metronomeBeatOffset = DEFAULT_METRONOME_BEAT_OFFSET,
  onMetronomeBeatOffsetChange = NOOP,
}: {
  selectedAudioMode: JukeboxAudioMode;
  disabled: boolean;
  onChange: (mode: JukeboxAudioMode) => void;
  intensityPct: number;
  onIntensityChange: (intensityPct: number) => void;
  metronomeVolumePct?: number;
  onMetronomeVolumeChange?: (volumePct: number) => void;
  metronomeBeatsPerBar?: number | null;
  detectedBeatsPerBar?: number;
  onMetronomeBeatsPerBarChange?: (beatsPerBar: number | null) => void;
  metronomeBeatOffset?: number;
  onMetronomeBeatOffsetChange?: (offset: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="audio-mode-options"
      role="radiogroup"
      aria-label={t("tuning.audioMode")}
    >
      <AudioModeRadio
        option="off"
        className="audio-mode-default-option"
        checked={selectedAudioMode === "off"}
        disabled={disabled}
        onChange={() => onChange("off")}
      />
      {AUDIO_MODE_SECTIONS.map((section) => (
        <AudioModeSectionGroup
          key={section.titleKey}
          section={section}
          selectedAudioMode={selectedAudioMode}
          disabled={disabled}
          onChange={onChange}
          intensityPct={intensityPct}
          onIntensityChange={onIntensityChange}
          metronomeVolumePct={metronomeVolumePct}
          onMetronomeVolumeChange={onMetronomeVolumeChange}
          metronomeBeatsPerBar={metronomeBeatsPerBar}
          detectedBeatsPerBar={detectedBeatsPerBar}
          onMetronomeBeatsPerBarChange={onMetronomeBeatsPerBarChange}
          metronomeBeatOffset={metronomeBeatOffset}
          onMetronomeBeatOffsetChange={onMetronomeBeatOffsetChange}
        />
      ))}
    </div>
  );
}
