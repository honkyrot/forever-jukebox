import { useLayoutEffect, useState } from "react";
import {
  hasNonDefaultExtras,
  MAX_MAX_BRANCHES,
  MIN_MAX_BRANCHES,
} from "@forever-jukebox/shared";
import type { JukeboxAudioMode } from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import type {
  VisualEffectMode,
  VisualPreferences,
} from "@forever-jukebox/shared/viz/JukeboxViz";
import {
  DEFAULT_AUDIO_MODE_INTENSITY,
  MAX_AUDIO_MODE_INTENSITY,
  MIN_AUDIO_MODE_INTENSITY,
  audioModeSupportsIntensity,
} from "@forever-jukebox/shared/audio/audioModes";
import {
  applyTuningChanges,
  changedTuningControls,
  getExtrasFormValues,
  getTuningFormValues,
  hasNonDefaultTuning,
  resetExtrasDefaults,
  resetTuningDefaults,
  setCoverSyncEnabled,
  setCrossTrackOnly,
  setMixTrackGainPct,
  setNormalizeVolumeEnabled,
  setPostMixNormalizeVolumeEnabled,
  setTempoSyncEnabled,
  type ExtrasFormValues,
  type TuningFormValues,
} from "../../playback";
import { applyExtrasAndSync } from "../../playback-ui";
import { isInstrumentalModeAvailable } from "@forever-jukebox/shared/audio/instrumentalRenderer";
import { getAppContext } from "../../runtime";
import { useAppStore } from "../../store";
import { Modal } from "../Modal";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const AUDIO_MODE_OPTIONS: Array<{
  id: string;
  value: JukeboxAudioMode;
  labelKey:
    | "common.off"
    | "audioModes.nightcore"
    | "audioModes.daycore"
    | "audioModes.vaporwave"
    | "audioModes.eightD"
    | "audioModes.lofi"
    | "audioModes.eightBit"
    | "audioModes.underwater"
    | "audioModes.cathedral"
    | "audioModes.cowbell"
    | "audioModes.swing"
    | "audioModes.instrumental";
  section: "default" | "styles" | "toys";
}> = [
  { id: "audio-mode-off", value: "off", labelKey: "common.off", section: "default" },
  { id: "audio-mode-nightcore", value: "nightcore", labelKey: "audioModes.nightcore", section: "styles" },
  { id: "audio-mode-daycore", value: "daycore", labelKey: "audioModes.daycore", section: "styles" },
  { id: "audio-mode-vaporwave", value: "vaporwave", labelKey: "audioModes.vaporwave", section: "styles" },
  { id: "audio-mode-eight-d", value: "eight_d", labelKey: "audioModes.eightD", section: "styles" },
  { id: "audio-mode-lofi", value: "lofi", labelKey: "audioModes.lofi", section: "styles" },
  { id: "audio-mode-eight-bit", value: "eight_bit", labelKey: "audioModes.eightBit", section: "styles" },
  { id: "audio-mode-underwater", value: "underwater", labelKey: "audioModes.underwater", section: "styles" },
  { id: "audio-mode-cathedral", value: "cathedral", labelKey: "audioModes.cathedral", section: "styles" },
  { id: "audio-mode-cowbell", value: "cowbell", labelKey: "audioModes.cowbell", section: "toys" },
  {
    id: "audio-mode-swing",
    value: "swing",
    labelKey: "audioModes.swing",
    section: "toys",
  },
  {
    id: "audio-mode-instrumental",
    value: "instrumental",
    labelKey: "audioModes.instrumental",
    section: "toys",
  },
];

const VISUAL_COLORING_OPTIONS: Array<{
  id: string;
  value: VisualEffectMode;
  label: string;
}> = [
  { id: "visual-effect-default", value: "0", label: "Default" },
  { id: "use-rgb-gradient", value: "1", label: "Rainbow Gradient" },
  { id: "use-similarity-colors", value: "2", label: "Similarity Based" },
  { id: "use-engine-colors", value: "3", label: "Engine Based" },
];

const MIN_JUMP_DISTANCE_OPTIONS = [0, 5, 10, 20, 30] as const;

function formatMinJumpDistance(percent: number, t: TFunction) {
  return percent === 0
    ? t("tuning.anyDistance")
    : t("tuning.percentOfTrack", { percent });
}

function formatMaxJumpDistance(percent: number, t: TFunction) {
  return percent <= 0 || percent >= 100
    ? t("tuning.anyDistance")
    : `<${percent}% of track`;
}

function RangeRow({
  id,
  label,
  valueText,
  min,
  max,
  step,
  value,
  onChange,
  hint,
  disabled = false,
}: {
  id: string;
  label: string;
  valueText: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "is-disabled" : undefined}>
      <div className="label-line">
        {label} <span id={`${id}-val`}>{valueText}</span>
      </div>
      {hint}
      <input
        id={id}
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function TuningModal() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.tuningModalOpen);
  const playMode = useAppStore((s) => s.playMode);
  const bpmBarEnabled = useAppStore((s) => s.bpmBarEnabled);
  const visualPreferences = useAppStore((s) => s.visualPreferences);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const crossTrackOnly = useAppStore((s) => s.crossTrackOnly);
  const coverSyncEnabled = useAppStore((s) => s.coverSyncEnabled);
  const tempoSyncEnabled = useAppStore((s) => s.tempoSyncEnabled);
  const normalizeVolumeEnabled = useAppStore((s) => s.normalizeVolumeEnabled);
  const postMixNormalizeVolumeEnabled = useAppStore(
    (s) => s.postMixNormalizeVolumeEnabled,
  );
  const mixTrackGainsPct = useAppStore((s) => s.mixTrackGainsPct);
  const playlistTracks = useAppStore((s) => s.playlist.tracks);
  const vizTracks = useAppStore((s) => s.vizData?.tracks);
  const mixTracks =
    multiTrackEnabled && vizTracks && vizTracks.length > 0
      ? vizTracks.map((t, index) => ({
          title: t.title || `Track ${index + 1}`,
        }))
      : playlistTracks.slice(0, 128).map((t, index) => ({
          title: t.title || `Track ${index + 1}`,
        }));
  const hasExtrasTab = playMode === "jukebox";
  const [form, setForm] = useState<TuningFormValues | null>(null);
  const [extras, setExtras] = useState<ExtrasFormValues | null>(null);
  const [extrasSnapshot, setExtrasSnapshot] = useState<ExtrasFormValues | null>(
    null,
  );
  const [tuningSnapshot, setTuningSnapshot] = useState<TuningFormValues | null>(
    null,
  );
  const [tuningNonDefault, setTuningNonDefault] = useState(false);

  // Snapshot engine config + extras state when the panel opens or mix mode changes.
  useLayoutEffect(() => {
    if (open) {
      const context = getAppContext();
      const tuningValues = getTuningFormValues(context);
      setForm(tuningValues);
      setTuningSnapshot(tuningValues);
      setTuningNonDefault(hasNonDefaultTuning(context));
      const extrasValues = getExtrasFormValues();
      setExtras(extrasValues);
      setExtrasSnapshot(extrasValues);
    }
  }, [open, multiTrackEnabled]);

  // Refreshes tuning state after multi-track mix actions rebuild the graph so
  // computed threshold defaults update immediately while preserving pinned edits.
  const refreshTuningForm = () => {
    const context = getAppContext();
    const tuningValues = getTuningFormValues(context);
    setForm(tuningValues);
    setTuningSnapshot((prev) =>
      prev
        ? {
            ...prev,
            threshold:
              prev.threshold === prev.computedThreshold
                ? tuningValues.threshold
                : prev.threshold,
            computedThreshold: tuningValues.computedThreshold,
            crossThreshold:
              prev.crossThreshold === prev.computedCrossThreshold
                ? tuningValues.crossThreshold
                : prev.crossThreshold,
            computedCrossThreshold: tuningValues.computedCrossThreshold,
          }
        : tuningValues,
    );
    setTuningNonDefault(hasNonDefaultTuning(context));
  };

  const close = () => useAppStore.setState({ tuningModalOpen: false });

  const handleReset = () => {
    const context = getAppContext();
    resetTuningDefaults(context);
    if (hasExtrasTab) {
      resetExtrasDefaults(context);
    }
    const tuningValues = getTuningFormValues(context);
    setForm(tuningValues);
    setTuningSnapshot(tuningValues);
    setTuningNonDefault(hasNonDefaultTuning(context));
    const extrasValues = getExtrasFormValues();
    setExtras(extrasValues);
    setExtrasSnapshot(extrasValues);
  };

  // Anchor highlight is a sticky preference, so it never counts as a change to reset.
  const showReset =
    tuningNonDefault ||
    (tuningSnapshot !== null &&
      form !== null &&
      changedTuningControls(tuningSnapshot, form).some(
        (control) => control !== "anchor_highlight",
      )) ||
    (hasExtrasTab &&
      ((extrasSnapshot !== null && hasNonDefaultExtras(extrasSnapshot)) ||
        (extras !== null && hasNonDefaultExtras(extras))));

  const setFormField = <K extends keyof TuningFormValues>(
    key: K,
    value: TuningFormValues[K],
  ) => {
    setForm((prev) => {
      if (!prev) {
        return prev;
      }
      const next = { ...prev, [key]: value };
      const context = getAppContext();
      const applied = applyTuningChanges(context, next);
      setTuningNonDefault(hasNonDefaultTuning(context));
      return applied;
    });
  };
  const setExtrasField = <K extends keyof ExtrasFormValues>(
    key: K,
    value: ExtrasFormValues[K],
  ) => {
    setExtras((prev) => {
      if (!prev) {
        return prev;
      }
      const next = { ...prev, [key]: value };
      applyExtrasAndSync(getAppContext(), next);
      return next;
    });
  };

  // Picking a mode resets intensity to its canonical preset; reselecting the
  // mode that was active when the panel opened restores its saved intensity.
  const selectAudioMode = (mode: JukeboxAudioMode) => {
    setExtras((prev) => {
      if (!prev) {
        return prev;
      }
      const next: ExtrasFormValues = {
        ...prev,
        audioMode: mode,
        audioIntensity:
          extrasSnapshot && mode === extrasSnapshot.audioMode
            ? extrasSnapshot.audioIntensity
            : DEFAULT_AUDIO_MODE_INTENSITY,
      };
      applyExtrasAndSync(getAppContext(), next);
      return next;
    });
  };

  const updateVisualPreferences = (patch: Partial<VisualPreferences>) => {
    const next: VisualPreferences = {
      ...visualPreferences,
      ...patch,
    };
    if (patch.visualEffectMode !== undefined) {
      localStorage.setItem("visualEffectMode", patch.visualEffectMode);
    }
    if (patch.useSquareBeats !== undefined) {
      localStorage.setItem("useSquareBeats", String(patch.useSquareBeats));
    }
    if (patch.useAltSeekShape !== undefined) {
      localStorage.setItem("useAltSeekShape", String(patch.useAltSeekShape));
    }
    useAppStore.setState({ visualPreferences: next });
    getAppContext().jukebox?.setVisualPreferences(next);
  };

  const toggleBpmBar = (enabled: boolean) => {
    localStorage.setItem("bpmBarEnabled", String(enabled));
    useAppStore.setState({ bpmBarEnabled: enabled });
  };

  const audioModeOption = (option: (typeof AUDIO_MODE_OPTIONS)[number]) => (
    <label
      key={option.id}
      className={
        option.section === "default"
          ? "audio-mode-option audio-mode-default-option"
          : "audio-mode-option"
      }
    >
      <input
        id={option.id}
        type="radio"
        name="audio-mode"
        value={option.value}
        checked={extras?.audioMode === option.value}
        disabled={!hasExtrasTab}
        onChange={() => selectAudioMode(option.value)}
      />
      {t(option.labelKey)}
    </label>
  );

  return (
    <Modal id="tuning-modal" open={open} onClose={close} inline>
      <div className="modal-header">
        <div className="modal-header-main">
          <h2 id="tuning-title">
            <span id="tuning-title-text">{t("tuning.title")}</span>
          </h2>
        </div>
        <div className="modal-header-actions">
          <button
            type="button"
            id="tuning-close"
            className="modal-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={close}
          >
            <span
              className="material-symbols-outlined modal-close-icon"
              aria-hidden="true"
            >
              close
            </span>
          </button>
        </div>
      </div>
      <div className="modal-body tuning-body">
        <div id="tuning-panel-tuning" className="tuning-section-grid">
          <div className="tuning-sliders-col">
            <RangeRow
              id="threshold"
              label={t("tuning.similarityThreshold")}
              valueText={`${form?.threshold ?? 2}`}
              min={2}
              max={100}
              step={1}
              value={form?.threshold ?? 2}
              disabled={multiTrackEnabled && crossTrackOnly}
              onChange={(value) => setFormField("threshold", value)}
              hint={
                <div className="hint">
                  {t("tuning.computedThreshold")}{" "}
                  <span id="computed-threshold">
                    {form?.computedThreshold === null ||
                    form?.computedThreshold === undefined
                      ? "-"
                      : `${form.computedThreshold}`}
                  </span>
                  {multiTrackEnabled && crossTrackOnly ? (
                    <div>{t("tuning.sameSongThresholdDisabledHint")}</div>
                  ) : null}
                </div>
              }
            />
            <RangeRow
              id="min-jump-distance"
              label={t("tuning.minJumpDistance")}
              valueText={formatMinJumpDistance(
                form?.minLongBranchPercent ?? 0,
                t,
              )}
              min={0}
              max={MIN_JUMP_DISTANCE_OPTIONS.length - 1}
              step={1}
              value={Math.max(
                0,
                MIN_JUMP_DISTANCE_OPTIONS.indexOf(
                  (form?.minLongBranchPercent ??
                    0) as (typeof MIN_JUMP_DISTANCE_OPTIONS)[number],
                ),
              )}
              onChange={(index) =>
                setFormField(
                  "minLongBranchPercent",
                  MIN_JUMP_DISTANCE_OPTIONS[index] ?? 0,
                )
              }
              hint={
                <div className="hint">
                  {t("tuning.minJumpDistanceHint")}
                </div>
              }
            />
            <RangeRow
              id="max-jump-distance"
              label="Maximum Jump Distance:"
              valueText={formatMaxJumpDistance(
                form?.maxLongBranchPercent ?? 100,
                t,
              )}
              min={1}
              max={100}
              step={1}
              value={
                form?.maxLongBranchPercent && form.maxLongBranchPercent > 0
                  ? form.maxLongBranchPercent
                  : 100
              }
              onChange={(value) => setFormField("maxLongBranchPercent", value)}
              hint={
                <div className="hint">
                  Caps how far a branch can jump across the track.
                </div>
              }
            />
            <RangeRow
              id="min-prob"
              label={t("tuning.probabilityMin")}
              valueText={`${form?.minProbPct ?? 18}%`}
              min={0}
              max={100}
              step={2}
              value={form?.minProbPct ?? 18}
              onChange={(value) => setFormField("minProbPct", value)}
            />
            <RangeRow
              id="max-prob"
              label={t("tuning.probabilityMax")}
              valueText={`${form?.maxProbPct ?? 50}%`}
              min={0}
              max={100}
              step={2}
              value={form?.maxProbPct ?? 50}
              onChange={(value) => setFormField("maxProbPct", value)}
            />
            <RangeRow
              id="ramp"
              label={t("tuning.rampSpeed")}
              valueText={`${form?.rampPct ?? 10}%`}
              min={0}
              max={100}
              step={2}
              value={form?.rampPct ?? 10}
              onChange={(value) => setFormField("rampPct", value)}
            />
            {showReset ? (
              <div className="tuning-reset-row">
                <button type="button" id="tuning-reset" onClick={handleReset}>
                  {t("common.reset")}
                </button>
              </div>
            ) : null}
          </div>
          <div className="tuning-right-col">
            <div className="checkbox-row tuning-checkboxes-col">
              <label>
                <input
                  id="just-backwards"
                  type="checkbox"
                  checked={form?.justBackwards ?? false}
                  onChange={(event) =>
                    setFormField("justBackwards", event.target.checked)
                  }
                />{" "}
                {t("tuning.onlyReverse")}
              </label>
              <label>
                <input
                  id="remove-seq"
                  type="checkbox"
                  checked={form?.removeSequentialBranches ?? false}
                  onChange={(event) =>
                    setFormField("removeSequentialBranches", event.target.checked)
                  }
                />{" "}
                {t("tuning.removeSequential")}
              </label>
              <label>
                <input
                  id="highlight-anchor-branch"
                  type="checkbox"
                  checked={form?.highlightAnchorBranch ?? false}
                  onChange={(event) =>
                    setFormField("highlightAnchorBranch", event.target.checked)
                  }
                />{" "}
                {t("tuning.highlightAnchor")}
              </label>
            </div>
            {multiTrackEnabled ? (
              <div id="tuning-panel-multi" className="tuning-multi-section">
                <h3>{t("tuning.multiTuning")}</h3>
                <div className="checkbox-row multi-checkbox-row">
                  <label>
                    <input
                      id="cross-track-only"
                      type="checkbox"
                      checked={crossTrackOnly}
                      onChange={(event) => {
                        setCrossTrackOnly(getAppContext(), event.target.checked);
                        refreshTuningForm();
                      }}
                    />{" "}
                    Cross-song branches only
                  </label>
                  <label>
                    <input
                      id="cover-sync-enabled"
                      type="checkbox"
                      checked={coverSyncEnabled}
                      onChange={(event) => {
                        setCoverSyncEnabled(
                          getAppContext(),
                          event.target.checked,
                        );
                        refreshTuningForm();
                      }}
                    />{" "}
                    {t("tuning.coverSync")}
                  </label>
                  <label>
                    <input
                      id="tempo-sync-enabled"
                      type="checkbox"
                      checked={tempoSyncEnabled}
                      onChange={(event) => {
                        setTempoSyncEnabled(
                          getAppContext(),
                          event.target.checked,
                        );
                        refreshTuningForm();
                      }}
                    />{" "}
                    Tempo sync (match BPM)
                  </label>
                  <label>
                    <input
                      id="normalize-volume-enabled"
                      type="checkbox"
                      checked={normalizeVolumeEnabled}
                      onChange={(event) => {
                        setNormalizeVolumeEnabled(
                          getAppContext(),
                          event.target.checked,
                        );
                        refreshTuningForm();
                      }}
                    />{" "}
                    Volume normalization (premix)
                  </label>
                  <label>
                    <input
                      id="post-mix-normalize-volume-enabled"
                      type="checkbox"
                      checked={postMixNormalizeVolumeEnabled}
                      onChange={(event) =>
                        setPostMixNormalizeVolumeEnabled(
                          getAppContext(),
                          event.target.checked,
                        )
                      }
                    />{" "}
                    {t("tuning.normalizeVolumePostmix")}
                  </label>
                </div>
                <RangeRow
                  id="cross-threshold"
                  label={t("tuning.crossSimilarityThreshold")}
                  valueText={`${form?.crossThreshold ?? 2}`}
                  min={2}
                  max={100}
                  step={1}
                  value={form?.crossThreshold ?? 2}
                  onChange={(value) => setFormField("crossThreshold", value)}
                  hint={
                    <div className="hint">
                      {t("tuning.computedThreshold")}{" "}
                      <span id="computed-cross-threshold">
                        {form?.computedCrossThreshold === null ||
                        form?.computedCrossThreshold === undefined
                          ? "-"
                          : `${form.computedCrossThreshold}`}
                      </span>
                    </div>
                  }
                />
                {mixTracks.map((track, index) => {
                  const gainPct = mixTrackGainsPct[index] ?? 100;
                  return (
                    <RangeRow
                      key={index}
                      id={`mix-track-gain-${index}`}
                      label={`Track ${index + 1} Volume (${track.title})`}
                      valueText={`${gainPct}%`}
                      min={50}
                      max={150}
                      step={1}
                      value={gainPct}
                      onChange={(value) => {
                        setMixTrackGainPct(getAppContext(), index, value);
                        refreshTuningForm();
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div id="tuning-panel-visuals" className="tuning-visuals-section">
          <h3>Visuals</h3>
          <div className="checkbox-row visuals-checkbox-row">
            <label>
              <input
                id="bpm-bar-toggle"
                type="checkbox"
                checked={bpmBarEnabled}
                onChange={(event) => toggleBpmBar(event.target.checked)}
              />{" "}
              Show BPM bar
            </label>
            <label>
              <input
                id="use-square-beats"
                type="checkbox"
                checked={visualPreferences.useSquareBeats}
                onChange={(event) =>
                  updateVisualPreferences({
                    useSquareBeats: event.target.checked,
                  })
                }
              />{" "}
              Square beats
            </label>
            <label>
              <input
                id="use-alt-seek-shape"
                type="checkbox"
                checked={visualPreferences.useAltSeekShape}
                onChange={(event) =>
                  updateVisualPreferences({
                    useAltSeekShape: event.target.checked,
                  })
                }
              />{" "}
              Alternate Seek Shape
            </label>
          </div>
          <div className="visual-mode-group">
            <div className="label-line">Coloring</div>
            <div
              className="visual-mode-options"
              role="radiogroup"
              aria-label="Coloring"
            >
              {VISUAL_COLORING_OPTIONS.map((option) => (
                <label key={option.id} className="visual-mode-option">
                  <input
                    id={option.id}
                    type="radio"
                    name="visual-effect-mode"
                    value={option.value}
                    checked={visualPreferences.visualEffectMode === option.value}
                    onChange={() =>
                      updateVisualPreferences({
                        visualEffectMode: option.value,
                      })
                    }
                  />{" "}
                  {option.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div
          id="tuning-panel-extras"
          className={hasExtrasTab ? undefined : "hidden"}
        >
          <h3>{t("tuning.extras")}</h3>
          <div className="checkbox-row extras-checkbox-row">
            <label>
              <input
                id="extras-enabled"
                type="checkbox"
                checked={extras?.branchStatsEnabled ?? false}
                disabled={!hasExtrasTab}
                onChange={(event) =>
                  setExtrasField("branchStatsEnabled", event.target.checked)
                }
              />{" "}
              {t("tuning.showBranchStats")}
            </label>
            <label>
              <input
                id="bring-home-enabled"
                type="checkbox"
                checked={extras?.bringItHomeMode ?? false}
                disabled={!hasExtrasTab}
                onChange={(event) =>
                  setExtrasField("bringItHomeMode", event.target.checked)
                }
              />{" "}
              {t("tuning.bringItHome")}
            </label>
            <label>
              <input
                id="custom-anchor-enabled"
                type="checkbox"
                checked={extras?.customAnchorEnabled ?? false}
                disabled={!hasExtrasTab}
                onChange={(event) =>
                  setExtrasField("customAnchorEnabled", event.target.checked)
                }
              />{" "}
              {t("tuning.customAnchor")}
            </label>
          </div>
          <div id="jukebox-audio-mode-group" className="audio-mode-group">
            <div className="label-line">{t("tuning.audioMode")}</div>
            <div
              className="audio-mode-options"
              role="radiogroup"
              aria-label={t("tuning.audioMode")}
            >
              {audioModeOption(AUDIO_MODE_OPTIONS[0])}
              <div className="audio-mode-section">
                <div className="audio-mode-section-title">{t("tuning.playbackStyles")}</div>
                <div className="audio-mode-section-options">
                  {AUDIO_MODE_OPTIONS.filter(
                    (option) => option.section === "styles",
                  ).map(audioModeOption)}
                </div>
                {extras && audioModeSupportsIntensity(extras.audioMode) ? (
                  <RangeRow
                    id="audio-intensity"
                    label={t("tuning.audioIntensity")}
                    valueText={`${extras.audioIntensity}%`}
                    min={MIN_AUDIO_MODE_INTENSITY}
                    max={MAX_AUDIO_MODE_INTENSITY}
                    step={5}
                    value={extras.audioIntensity}
                    onChange={(value) => setExtrasField("audioIntensity", value)}
                  />
                ) : null}
              </div>
              <div className="audio-mode-section">
                <div className="audio-mode-section-title">{t("tuning.remixToys")}</div>
                <div className="audio-mode-section-options">
                  {AUDIO_MODE_OPTIONS.filter(
                    (option) =>
                      option.section === "toys" &&
                      (option.value !== "instrumental" ||
                        isInstrumentalModeAvailable()),
                  ).map(audioModeOption)}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="tuning-panel-advanced" className="tuning-advanced-section">
          <h3>{t("tuning.advanced")}</h3>
          <RangeRow
            id="max-branches"
            label={t("tuning.maxBranches")}
            valueText={`${form?.maxBranches ?? 8}`}
            min={MIN_MAX_BRANCHES}
            max={MAX_MAX_BRANCHES}
            step={1}
            value={form?.maxBranches ?? 8}
            onChange={(value) => setFormField("maxBranches", value)}
            hint={
              <div className="hint">{t("tuning.maxBranchesHint")}</div>
            }
          />
        </div>
      </div>
    </Modal>
  );
}
