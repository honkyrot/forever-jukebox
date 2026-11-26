import { useLayoutEffect, useState } from "react";
import {
  clampTimeSignatureDenominator,
  clampTimeSignatureNumerator,
  clampTimeSignatureTrackOffset,
  hasNonDefaultExtras,
  MAX_MAX_BRANCHES,
  MAX_TIME_SIGNATURE_NUMERATOR,
  MAX_TIME_SIGNATURE_TRACK_OFFSET,
  MIN_MAX_BRANCHES,
  MIN_TIME_SIGNATURE_NUMERATOR,
  MIN_TIME_SIGNATURE_TRACK_OFFSET,
  TIME_SIGNATURE_DENOMINATOR_OPTIONS,
  resolveTimeSignatureBranchStepBeats,
  type TimeSignatureBranchMode,
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
  MAX_METRONOME_VOLUME_PCT,
  METRONOME_TIME_SIGNATURE_OPTIONS,
  MIN_METRONOME_VOLUME_PCT,
  clampMetronomeBeatOffset,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_MIX_TRACK_GAIN_PCT,
  MIN_MIX_TRACK_GAIN_PCT,
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
  setTimeSignatureBranchingEnabled,
  setTimeSignatureBranchMode,
  setTimeSignatureDenominator,
  setTimeSignatureNumerator,
  setTimeSignatureSimilarityDenominator,
  setTimeSignatureSimilarityNumerator,
  setTimeSignatureSimilarityRestrictEnabled,
  setTimeSignatureTrackOffset,
  type ExtrasFormValues,
  type TuningFormValues,
} from "../../playback";
import { applyExtrasAndSync } from "../../playback-ui";
import { syncPredictedJumps } from "../../playback";
import {
  MAX_BRANCH_LOOKAHEAD_COUNT,
  MIN_BRANCH_LOOKAHEAD_COUNT,
  clampBranchLookaheadCount,
  storeBranchLookaheadCount,
  storeBranchLookaheadEnabled,
} from "../../branchLookahead";
import {
  MAX_BPM_BAR_SEGMENTS,
  isSmoothBpmBarStyle,
  normalizeBpmBarStyle,
  normalizeBpmBarTimeSignatureMode,
  storeBpmBarBeatOffsetForTrack,
  storeBpmBarDenominator,
  storeBpmBarNumerator,
  storeBpmBarStyle,
  storeBpmBarTimeSignatureMode,
  type BpmBarStyle,
  type BpmBarTimeSignatureMode,
} from "../../bpmBarTimeSignature";
import { isInstrumentalModeAvailable } from "@forever-jukebox/shared/audio/instrumentalRenderer";
import { getAppContext } from "../../runtime";
import { getCurrentTrackId, useAppStore } from "../../store";
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
    | "audioModes.metronome"
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
  { id: "audio-mode-metronome", value: "metronome", labelKey: "audioModes.metronome", section: "styles" },
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
  { id: "use-pitch-colors", value: "4", label: "Pitch Based" },
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
  const bpmBarStyle = useAppStore((s) => s.bpmBarStyle);
  const bpmBarTimeSignatureMode = useAppStore((s) => s.bpmBarTimeSignatureMode);
  const bpmBarNumerator = useAppStore((s) => s.bpmBarNumerator);
  const bpmBarDenominator = useAppStore((s) => s.bpmBarDenominator);
  const bpmBarBeatOffset = useAppStore((s) => s.bpmBarBeatOffset);
  const bpmBarSegmentCount = Math.min(
    MAX_BPM_BAR_SEGMENTS,
    Math.max(
      1,
      resolveTimeSignatureBranchStepBeats(bpmBarNumerator, bpmBarDenominator),
    ),
  );
  const metronomeDetectedBeatsPerBar = useAppStore(
    (s) => s.metronomeDetectedBeatsPerBar,
  );
  const visualPreferences = useAppStore((s) => s.visualPreferences);
  const branchLookaheadEnabled = useAppStore((s) => s.branchLookaheadEnabled);
  const branchLookaheadCount = useAppStore((s) => s.branchLookaheadCount);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const crossTrackOnly = useAppStore((s) => s.crossTrackOnly);
  const coverSyncEnabled = useAppStore((s) => s.coverSyncEnabled);
  const timeSignatureBranchingEnabled = useAppStore(
    (s) => s.timeSignatureBranchingEnabled,
  );
  const timeSignatureBranchMode = useAppStore((s) => s.timeSignatureBranchMode);
  const isTimeSignatureOverwrite =
    timeSignatureBranchingEnabled && timeSignatureBranchMode === "overwrite";
  const timeSignatureNumerator = useAppStore((s) => s.timeSignatureNumerator);
  const timeSignatureDenominator = useAppStore(
    (s) => s.timeSignatureDenominator,
  );
  const timeSignatureTrackOffsets = useAppStore(
    (s) => s.timeSignatureTrackOffsets,
  );
  const timeSignatureStepBeats = resolveTimeSignatureBranchStepBeats(
    timeSignatureNumerator,
    timeSignatureDenominator,
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
  const timeSignatureSimilarityStepBeats = resolveTimeSignatureBranchStepBeats(
    timeSignatureSimilarityNumerator,
    timeSignatureSimilarityDenominator,
  );
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

  /**
   * Updates the metronome time-signature override and clamps the beat offset
   * in the same state transition so the offset stays valid for the new meter.
   */
  const selectMetronomeBeatsPerBar = (nextBeatsPerBar: number | null) => {
    setExtras((prev) => {
      if (!prev) {
        return prev;
      }
      const effectiveBeats = nextBeatsPerBar ?? metronomeDetectedBeatsPerBar;
      const next: ExtrasFormValues = {
        ...prev,
        metronomeBeatsPerBar: nextBeatsPerBar,
        metronomeBeatOffset: clampMetronomeBeatOffset(
          prev.metronomeBeatOffset,
          effectiveBeats,
        ),
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

  /**
   * Normalizes, persists, and applies the selected BPM bar display style.
   */
  const updateBpmBarStyle = (style: BpmBarStyle) => {
    const normalized = normalizeBpmBarStyle(style);
    storeBpmBarStyle(normalized);
    useAppStore.setState({ bpmBarStyle: normalized });
  };

  const updateBpmBarTimeSignatureMode = (mode: BpmBarTimeSignatureMode) => {
    const normalized = normalizeBpmBarTimeSignatureMode(mode);
    storeBpmBarTimeSignatureMode(normalized);
    useAppStore.setState({ bpmBarTimeSignatureMode: normalized });
  };

  const updateBpmBarNumerator = (numerator: number) => {
    const clamped = clampTimeSignatureNumerator(numerator);
    storeBpmBarNumerator(clamped);
    useAppStore.setState({ bpmBarNumerator: clamped });
  };

  const updateBpmBarDenominator = (denominator: number) => {
    const clamped = clampTimeSignatureDenominator(denominator);
    storeBpmBarDenominator(clamped);
    useAppStore.setState({ bpmBarDenominator: clamped });
  };

  const updateBpmBarBeatOffset = (offset: number) => {
    const clamped = clampTimeSignatureTrackOffset(offset);
    storeBpmBarBeatOffsetForTrack(getCurrentTrackId(), clamped);
    useAppStore.setState({ bpmBarBeatOffset: clamped });
  };

  const toggleBranchLookahead = (enabled: boolean) => {
    storeBranchLookaheadEnabled(enabled);
    useAppStore.setState({ branchLookaheadEnabled: enabled });
    syncPredictedJumps(getAppContext());
  };

  const updateBranchLookaheadCount = (count: number) => {
    const clamped = clampBranchLookaheadCount(count);
    storeBranchLookaheadCount(clamped);
    useAppStore.setState({ branchLookaheadCount: clamped });
    syncPredictedJumps(getAppContext());
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

  const renderSimilarityRestrictGroup = (includeSingleTrackOffset: boolean) => {
    const singleTrackOffset = timeSignatureTrackOffsets[0] ?? 0;
    return (
      <div className="multi-time-sig-group">
        <label>
          <input
            id="time-signature-similarity-restrict-enabled"
            type="checkbox"
            checked={timeSignatureSimilarityRestrictEnabled}
            onChange={(event) => {
              setTimeSignatureSimilarityRestrictEnabled(
                getAppContext(),
                event.target.checked,
              );
              refreshTuningForm();
            }}
          />{" "}
          {t("tuning.timeSignatureSimilarityRestrict")}
        </label>
        {timeSignatureSimilarityRestrictEnabled ? (
          <div
            id="multi-time-sig-restrict-controls"
            className="multi-time-sig-controls"
          >
            <div className="multi-time-sig-fraction">
              <input
                id="time-signature-similarity-numerator"
                type="number"
                min={MIN_TIME_SIGNATURE_NUMERATOR}
                max={MAX_TIME_SIGNATURE_NUMERATOR}
                step={1}
                aria-label={t("tuning.timeSignatureNumeratorAria")}
                value={timeSignatureSimilarityNumerator}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (!Number.isFinite(parsed)) {
                    return;
                  }
                  setTimeSignatureSimilarityNumerator(getAppContext(), parsed);
                  refreshTuningForm();
                }}
              />
              <span className="multi-time-sig-slash">/</span>
              <select
                id="time-signature-similarity-denominator"
                aria-label={t("tuning.timeSignatureDenominatorAria")}
                value={timeSignatureSimilarityDenominator}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (!Number.isFinite(parsed)) {
                    return;
                  }
                  setTimeSignatureSimilarityDenominator(
                    getAppContext(),
                    parsed,
                  );
                  refreshTuningForm();
                }}
              >
                {TIME_SIGNATURE_DENOMINATOR_OPTIONS.map((den) => (
                  <option key={den} value={den}>
                    {den}
                  </option>
                ))}
              </select>
              <span id="time-signature-similarity-step-beats" className="hint">
                {t("tuning.timeSignatureEveryBeats", {
                  count: timeSignatureSimilarityStepBeats,
                })}
              </span>
            </div>
            {includeSingleTrackOffset ? (
              <div className="multi-time-sig-offset-row">
                <div className="multi-time-sig-offset-header">
                  <span>{t("tuning.bpmBarBeatOffset")}</span>
                </div>
                <div className="multi-time-sig-stepper">
                  <button
                    type="button"
                    id="time-signature-track-offset-dec-0"
                    aria-label="-"
                    disabled={
                      singleTrackOffset <= MIN_TIME_SIGNATURE_TRACK_OFFSET
                    }
                    onClick={() => {
                      setTimeSignatureTrackOffset(
                        getAppContext(),
                        0,
                        singleTrackOffset - 1,
                      );
                      refreshTuningForm();
                    }}
                  >
                    -
                  </button>
                  <input
                    id="time-signature-track-offset-0"
                    type="number"
                    min={MIN_TIME_SIGNATURE_TRACK_OFFSET}
                    max={MAX_TIME_SIGNATURE_TRACK_OFFSET}
                    step={1}
                    aria-label={t("tuning.bpmBarBeatOffset")}
                    value={singleTrackOffset}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(parsed)) {
                        return;
                      }
                      setTimeSignatureTrackOffset(getAppContext(), 0, parsed);
                      refreshTuningForm();
                    }}
                  />
                  <button
                    type="button"
                    id="time-signature-track-offset-inc-0"
                    aria-label="+"
                    disabled={
                      singleTrackOffset >= MAX_TIME_SIGNATURE_TRACK_OFFSET
                    }
                    onClick={() => {
                      setTimeSignatureTrackOffset(
                        getAppContext(),
                        0,
                        singleTrackOffset + 1,
                      );
                      refreshTuningForm();
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            ) : null}
            <div className="hint">
              {isTimeSignatureOverwrite
                ? t("tuning.timeSignatureOverriddenHint")
                : t("tuning.timeSignatureSimilarityRestrictHint")}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

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
                  ) : !multiTrackEnabled &&
                    timeSignatureSimilarityRestrictEnabled ? (
                    <div>{t("tuning.timeSignatureRestrictedHint")}</div>
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
            {!multiTrackEnabled && playMode === "jukebox"
              ? renderSimilarityRestrictGroup(true)
              : null}
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
                  disabled={isTimeSignatureOverwrite}
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
                      {isTimeSignatureOverwrite ? (
                        <div>{t("tuning.timeSignatureOverriddenHint")}</div>
                      ) : timeSignatureSimilarityRestrictEnabled &&
                        timeSignatureBranchingEnabled ? (
                        <div>{t("tuning.timeSignatureBothHint")}</div>
                      ) : timeSignatureSimilarityRestrictEnabled ? (
                        <div>{t("tuning.timeSignatureRestrictedHint")}</div>
                      ) : timeSignatureBranchingEnabled ? (
                        <div>{t("tuning.timeSignatureCombinedHint")}</div>
                      ) : null}
                    </div>
                  }
                />
                {mixTracks.map((track, index) => {
                  const gainPct =
                    mixTrackGainsPct[index] ?? DEFAULT_MIX_TRACK_GAIN_PCT;
                  return (
                    <RangeRow
                      key={index}
                      id={`mix-track-gain-${index}`}
                      label={`Track ${index + 1} Volume (${track.title})`}
                      valueText={`${gainPct}%`}
                      min={MIN_MIX_TRACK_GAIN_PCT}
                      max={MAX_MIX_TRACK_GAIN_PCT}
                      step={1}
                      value={gainPct}
                      onChange={(value) => {
                        setMixTrackGainPct(getAppContext(), index, value);
                      }}
                    />
                  );
                })}
                {renderSimilarityRestrictGroup(false)}
                <div className="multi-time-sig-group">
                  <label>
                    <input
                      id="time-signature-branching-enabled"
                      type="checkbox"
                      checked={timeSignatureBranchingEnabled}
                      onChange={(event) => {
                        setTimeSignatureBranchingEnabled(
                          getAppContext(),
                          event.target.checked,
                        );
                        refreshTuningForm();
                      }}
                    />{" "}
                    {t("tuning.timeSignatureOverwrite")}
                  </label>
                  {timeSignatureBranchingEnabled ? (
                    <div
                      id="multi-time-sig-controls"
                      className="multi-time-sig-controls"
                    >
                      <div className="multi-time-sig-mode">
                        <label htmlFor="time-signature-branch-mode">
                          {t("tuning.timeSignatureModeLabel")}
                        </label>
                        <select
                          id="time-signature-branch-mode"
                          aria-label={t("tuning.timeSignatureModeLabel")}
                          value={timeSignatureBranchMode}
                          onChange={(event) => {
                            setTimeSignatureBranchMode(
                              getAppContext(),
                              event.target.value as TimeSignatureBranchMode,
                            );
                            refreshTuningForm();
                          }}
                        >
                          <option value="overwrite">
                            {t("tuning.timeSignatureModeOverwrite")}
                          </option>
                          <option value="combine">
                            {t("tuning.timeSignatureModeCombine")}
                          </option>
                        </select>
                      </div>
                      <div className="multi-time-sig-fraction">
                        <input
                          id="time-signature-numerator"
                          type="number"
                          min={MIN_TIME_SIGNATURE_NUMERATOR}
                          max={MAX_TIME_SIGNATURE_NUMERATOR}
                          step={1}
                          aria-label={t("tuning.timeSignatureNumeratorAria")}
                          value={timeSignatureNumerator}
                          onChange={(event) => {
                            const parsed = Number.parseInt(
                              event.target.value,
                              10,
                            );
                            if (!Number.isFinite(parsed)) {
                              return;
                            }
                            setTimeSignatureNumerator(getAppContext(), parsed);
                            refreshTuningForm();
                          }}
                        />
                        <span className="multi-time-sig-slash">/</span>
                        <select
                          id="time-signature-denominator"
                          aria-label={t("tuning.timeSignatureDenominatorAria")}
                          value={timeSignatureDenominator}
                          onChange={(event) => {
                            const parsed = Number.parseInt(
                              event.target.value,
                              10,
                            );
                            if (!Number.isFinite(parsed)) {
                              return;
                            }
                            setTimeSignatureDenominator(
                              getAppContext(),
                              parsed,
                            );
                            refreshTuningForm();
                          }}
                        >
                          {TIME_SIGNATURE_DENOMINATOR_OPTIONS.map((den) => (
                            <option key={den} value={den}>
                              {den}
                            </option>
                          ))}
                        </select>
                        <span id="time-signature-step-beats" className="hint">
                          {t("tuning.timeSignatureEveryBeats", {
                            count: timeSignatureStepBeats,
                          })}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {timeSignatureBranchingEnabled ||
                  timeSignatureSimilarityRestrictEnabled ? (
                    <div
                      id="multi-time-sig-offsets-panel"
                      className="multi-time-sig-controls"
                    >
                      <div className="hint">
                        {coverSyncEnabled
                          ? t("tuning.timeSignatureCoverSyncHint")
                          : t("tuning.timeSignatureOffsetOnlyHint")}
                      </div>
                      <div className="multi-time-sig-offsets">
                        {mixTracks.map((track, index) => {
                          const offset = timeSignatureTrackOffsets[index] ?? 0;
                          return (
                            <div
                              key={index}
                              className="multi-time-sig-offset-row"
                            >
                              <div className="multi-time-sig-offset-header">
                                <span>
                                  {t("tuning.timeSignatureTrackOffset", {
                                    index: index + 1,
                                    title: track.title,
                                  })}
                                </span>
                              </div>
                              <div className="multi-time-sig-stepper">
                                <button
                                  type="button"
                                  id={`time-signature-track-offset-dec-${index}`}
                                  aria-label="-"
                                  disabled={
                                    offset <= MIN_TIME_SIGNATURE_TRACK_OFFSET
                                  }
                                  onClick={() => {
                                    setTimeSignatureTrackOffset(
                                      getAppContext(),
                                      index,
                                      offset - 1,
                                    );
                                    refreshTuningForm();
                                  }}
                                >
                                  -
                                </button>
                                <input
                                  id={`time-signature-track-offset-${index}`}
                                  type="number"
                                  min={MIN_TIME_SIGNATURE_TRACK_OFFSET}
                                  max={MAX_TIME_SIGNATURE_TRACK_OFFSET}
                                  step={1}
                                  aria-label={t(
                                    "tuning.timeSignatureTrackOffset",
                                    {
                                      index: index + 1,
                                      title: track.title,
                                    },
                                  )}
                                  value={offset}
                                  onChange={(event) => {
                                    const parsed = Number.parseInt(
                                      event.target.value,
                                      10,
                                    );
                                    if (!Number.isFinite(parsed)) {
                                      return;
                                    }
                                    setTimeSignatureTrackOffset(
                                      getAppContext(),
                                      index,
                                      parsed,
                                    );
                                    refreshTuningForm();
                                  }}
                                />
                                <button
                                  type="button"
                                  id={`time-signature-track-offset-inc-${index}`}
                                  aria-label="+"
                                  disabled={
                                    offset >= MAX_TIME_SIGNATURE_TRACK_OFFSET
                                  }
                                  onClick={() => {
                                    setTimeSignatureTrackOffset(
                                      getAppContext(),
                                      index,
                                      offset + 1,
                                    );
                                    refreshTuningForm();
                                  }}
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
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
            <label>
              <input
                id="branch-lookahead-toggle"
                type="checkbox"
                checked={branchLookaheadEnabled}
                onChange={(event) =>
                  toggleBranchLookahead(event.target.checked)
                }
              />{" "}
              Show upcoming branches
            </label>
          </div>
          {bpmBarEnabled ? (
            <div
              id="bpm-bar-time-sig-controls"
              className="multi-time-sig-controls"
            >
              <div className="multi-time-sig-mode">
                <label htmlFor="bpm-bar-style">
                  {t("tuning.bpmBarStyleLabel")}
                </label>
                <select
                  id="bpm-bar-style"
                  aria-label={t("tuning.bpmBarStyleLabel")}
                  value={bpmBarStyle}
                  onChange={(event) =>
                    updateBpmBarStyle(event.target.value as BpmBarStyle)
                  }
                >
                  <option value="pulse">{t("tuning.bpmBarStylePulse")}</option>
                  <option value="smooth">
                    {t("tuning.bpmBarStyleSmooth")}
                  </option>
                  <option value="smooth-pulse">
                    {t("tuning.bpmBarStyleSmoothPulse")}
                  </option>
                </select>
              </div>
              <div className="multi-time-sig-mode">
                <label htmlFor="bpm-bar-time-sig-mode">
                  {t("tuning.bpmBarTimeSignatureLabel")}
                </label>
                <select
                  id="bpm-bar-time-sig-mode"
                  aria-label={t("tuning.bpmBarTimeSignatureLabel")}
                  value={bpmBarTimeSignatureMode}
                  onChange={(event) =>
                    updateBpmBarTimeSignatureMode(
                      event.target.value as BpmBarTimeSignatureMode,
                    )
                  }
                >
                  <option value="auto">
                    {t("tuning.bpmBarTimeSignatureAuto")}
                  </option>
                  <option value="off">
                    {t("tuning.bpmBarTimeSignatureOff")}
                  </option>
                  <option value="custom">
                    {t("tuning.bpmBarTimeSignatureCustom")}
                  </option>
                </select>
              </div>
              {bpmBarTimeSignatureMode === "custom" ? (
                <>
                  <div className="multi-time-sig-fraction">
                    <input
                      id="bpm-bar-numerator"
                      type="number"
                      min={MIN_TIME_SIGNATURE_NUMERATOR}
                      max={MAX_TIME_SIGNATURE_NUMERATOR}
                      step={1}
                      aria-label={t("tuning.timeSignatureNumeratorAria")}
                      value={bpmBarNumerator}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        if (!Number.isFinite(parsed)) {
                          return;
                        }
                        updateBpmBarNumerator(parsed);
                      }}
                    />
                    <span className="multi-time-sig-slash">/</span>
                    <select
                      id="bpm-bar-denominator"
                      aria-label={t("tuning.timeSignatureDenominatorAria")}
                      value={bpmBarDenominator}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        if (!Number.isFinite(parsed)) {
                          return;
                        }
                        updateBpmBarDenominator(parsed);
                      }}
                    >
                      {TIME_SIGNATURE_DENOMINATOR_OPTIONS.map((den) => (
                        <option key={den} value={den}>
                          {den}
                        </option>
                      ))}
                    </select>
                    <span id="bpm-bar-step-beats" className="hint">
                      {t(
                        isSmoothBpmBarStyle(bpmBarStyle)
                          ? "tuning.bpmBarBeats"
                          : "tuning.bpmBarSegments",
                        {
                          count: bpmBarSegmentCount,
                        },
                      )}
                    </span>
                  </div>
                  <div className="multi-time-sig-offset-row">
                    <div className="multi-time-sig-offset-header">
                      <span>{t("tuning.bpmBarBeatOffset")}</span>
                    </div>
                    <div className="multi-time-sig-stepper">
                      <button
                        type="button"
                        id="bpm-bar-beat-offset-dec"
                        aria-label="-"
                        disabled={
                          bpmBarBeatOffset <= MIN_TIME_SIGNATURE_TRACK_OFFSET
                        }
                        onClick={() =>
                          updateBpmBarBeatOffset(bpmBarBeatOffset - 1)
                        }
                      >
                        -
                      </button>
                      <input
                        id="bpm-bar-beat-offset"
                        type="number"
                        min={MIN_TIME_SIGNATURE_TRACK_OFFSET}
                        max={MAX_TIME_SIGNATURE_TRACK_OFFSET}
                        step={1}
                        aria-label={t("tuning.bpmBarBeatOffset")}
                        value={bpmBarBeatOffset}
                        onChange={(event) => {
                          const parsed = Number.parseInt(
                            event.target.value,
                            10,
                          );
                          if (!Number.isFinite(parsed)) {
                            return;
                          }
                          updateBpmBarBeatOffset(parsed);
                        }}
                      />
                      <button
                        type="button"
                        id="bpm-bar-beat-offset-inc"
                        aria-label="+"
                        disabled={
                          bpmBarBeatOffset >= MAX_TIME_SIGNATURE_TRACK_OFFSET
                        }
                        onClick={() =>
                          updateBpmBarBeatOffset(bpmBarBeatOffset + 1)
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {branchLookaheadEnabled ? (
            <RangeRow
              id="branch-lookahead-count"
              label="Upcoming branches:"
              valueText={`${branchLookaheadCount}`}
              min={MIN_BRANCH_LOOKAHEAD_COUNT}
              max={MAX_BRANCH_LOOKAHEAD_COUNT}
              step={1}
              value={branchLookaheadCount}
              onChange={updateBranchLookaheadCount}
            />
          ) : null}
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
                {extras && extras.audioMode === "metronome"
                  ? (() => {
                      const effectiveBeats =
                        extras.metronomeBeatsPerBar ??
                        metronomeDetectedBeatsPerBar;
                      const clampedOffset = clampMetronomeBeatOffset(
                        extras.metronomeBeatOffset,
                        effectiveBeats,
                      );
                      const timeSignatureIndex = Math.max(
                        0,
                        METRONOME_TIME_SIGNATURE_OPTIONS.indexOf(
                          extras.metronomeBeatsPerBar,
                        ),
                      );
                      const timeSignatureText =
                        extras.metronomeBeatsPerBar === null
                          ? t("audioModes.metronomeTimeSignatureAuto", {
                              beats: metronomeDetectedBeatsPerBar,
                            })
                          : `${extras.metronomeBeatsPerBar}/4`;
                      return (
                        <>
                          <RangeRow
                            id="metronome-volume"
                            label={t("audioModes.metronomeVolume")}
                            valueText={`${extras.metronomeVolumePct}%`}
                            min={MIN_METRONOME_VOLUME_PCT}
                            max={MAX_METRONOME_VOLUME_PCT}
                            step={5}
                            value={extras.metronomeVolumePct}
                            onChange={(value) =>
                              setExtrasField("metronomeVolumePct", value)
                            }
                          />
                          <RangeRow
                            id="metronome-time-signature"
                            label={t("audioModes.metronomeTimeSignature")}
                            valueText={timeSignatureText}
                            min={0}
                            max={METRONOME_TIME_SIGNATURE_OPTIONS.length - 1}
                            step={1}
                            value={timeSignatureIndex}
                            onChange={(index) =>
                              selectMetronomeBeatsPerBar(
                                METRONOME_TIME_SIGNATURE_OPTIONS[index] ?? null,
                              )
                            }
                          />
                          <RangeRow
                            id="metronome-beat-offset"
                            label={t("audioModes.metronomeBeatOffset")}
                            valueText={t("audioModes.metronomeBeatOffsetValue", {
                              offset: clampedOffset,
                              beat: clampedOffset + 1,
                            })}
                            min={0}
                            max={Math.max(0, effectiveBeats - 1)}
                            step={1}
                            value={clampedOffset}
                            onChange={(value) =>
                              setExtrasField("metronomeBeatOffset", value)
                            }
                          />
                        </>
                      );
                    })()
                  : null}
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
