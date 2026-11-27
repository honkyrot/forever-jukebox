import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_MAX_BRANCHES,
  MAX_TIME_SIGNATURE_NUMERATOR,
  MAX_TIME_SIGNATURE_TRACK_OFFSET,
  MIN_MAX_BRANCHES,
  MIN_TIME_SIGNATURE_NUMERATOR,
  MIN_TIME_SIGNATURE_TRACK_OFFSET,
  TIME_SIGNATURE_DENOMINATOR_OPTIONS,
  clampTimeSignatureTrackOffset,
  resolveTimeSignatureBranchStepBeats,
  type TimeSignatureBranchMode,
} from "@forever-jukebox/shared";
import type {
  VisualEffectMode,
  VisualPreferences,
} from "@forever-jukebox/shared/viz/JukeboxViz";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import {
  MAX_METRONOME_VOLUME_PCT,
  MIN_METRONOME_VOLUME_PCT,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { AudioModeOptions } from "./AudioModeOptions";
import {
  MIN_JUMP_DISTANCE_OPTIONS,
  formatMaxJumpDistance,
  formatMinJumpDistance,
  type ExtrasFormState,
  type TuneFormState,
} from "./tuning";
import {
  MAX_BPM_BAR_SEGMENTS,
  isSmoothBpmBarStyle,
  type BpmBarStyle,
  type BpmBarTimeSignatureMode,
} from "./bpmBarTimeSignature";
import {
  MAX_BRANCH_LOOKAHEAD_COUNT,
  MIN_BRANCH_LOOKAHEAD_COUNT,
} from "./branchLookahead";
import {
  DEFAULT_MIX_TRACK_GAIN_PCT,
  MAX_MIX_TRACK_GAIN_PCT,
  MIN_MIX_TRACK_GAIN_PCT,
} from "./localMix";

export type SongSyncTrackUiState = {
  title: string;
  color: string;
  gainPct: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  beatOffset: number;
};

export type SongSyncTuningProps = {
  tracks: readonly SongSyncTrackUiState[];
  masterTrackIndex: number;
  tempoSyncEnabled: boolean;
  normalizeVolumeEnabled: boolean;
  onMasterTrackChange: (index: number) => void;
  onTempoSyncChange: (enabled: boolean) => void;
  onNormalizeVolumeChange: (enabled: boolean) => void;
  onTrackGainChange: (index: number, gainPct: number) => void;
  onTrackPanChange: (index: number, pan: number) => void;
  onTrackMutedChange: (index: number, muted: boolean) => void;
  onTrackSoloChange: (index: number, solo: boolean) => void;
  onTrackBeatOffsetChange: (index: number, beatOffset: number) => void;
};

const VISUAL_COLORING_OPTIONS: Array<{
  id: string;
  value: VisualEffectMode;
  labelKey:
    | "tuning.visualColorDefault"
    | "tuning.visualColorRainbow"
    | "tuning.visualColorSimilarity"
    | "tuning.visualColorEngine"
    | "tuning.visualColorPitch";
}> = [
  { id: "visual-effect-default", value: "0", labelKey: "tuning.visualColorDefault" },
  { id: "use-rgb-gradient", value: "1", labelKey: "tuning.visualColorRainbow" },
  { id: "use-similarity-colors", value: "2", labelKey: "tuning.visualColorSimilarity" },
  { id: "use-engine-colors", value: "3", labelKey: "tuning.visualColorEngine" },
  { id: "use-pitch-colors", value: "4", labelKey: "tuning.visualColorPitch" },
];

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
        <span>{label}</span>
        <span id={`${id}-val`}>{valueText}</span>
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

export type MultiTuningProps = {
  multiTrackEnabled: boolean;
  mixTracks: Array<{ title: string }>;
  crossTrackOnly: boolean;
  onCrossTrackOnlyChange: (enabled: boolean) => void;
  coverSyncEnabled: boolean;
  onCoverSyncChange: (enabled: boolean) => void;
  tempoSyncEnabled: boolean;
  onTempoSyncChange: (enabled: boolean) => void;
  normalizeVolumeEnabled: boolean;
  onNormalizeVolumeChange: (enabled: boolean) => void;
  postMixNormalizeVolumeEnabled: boolean;
  onPostMixNormalizeVolumeChange: (enabled: boolean) => void;
  mixTrackGainsPct: readonly number[];
  onMixTrackGainChange: (index: number, gainPct: number) => void;
  timeSignatureBranchingEnabled: boolean;
  onTimeSignatureBranchingChange: (enabled: boolean) => void;
  timeSignatureBranchMode: TimeSignatureBranchMode;
  onTimeSignatureBranchModeChange: (mode: TimeSignatureBranchMode) => void;
  timeSignatureNumerator: number;
  onTimeSignatureNumeratorChange: (numerator: number) => void;
  timeSignatureDenominator: number;
  onTimeSignatureDenominatorChange: (denominator: number) => void;
  timeSignatureTrackOffsets: readonly number[];
  onTimeSignatureTrackOffsetChange: (index: number, offset: number) => void;
  timeSignatureSimilarityRestrictEnabled: boolean;
  onTimeSignatureSimilarityRestrictChange: (enabled: boolean) => void;
  timeSignatureSimilarityNumerator: number;
  onTimeSignatureSimilarityNumeratorChange: (numerator: number) => void;
  timeSignatureSimilarityDenominator: number;
  onTimeSignatureSimilarityDenominatorChange: (denominator: number) => void;
};

export type VisualsTuningProps = {
  visualPreferences: VisualPreferences;
  onVisualPreferencesChange: (patch: Partial<VisualPreferences>) => void;
  bpmBarEnabled: boolean;
  onBpmBarEnabledChange: (enabled: boolean) => void;
  metronomeEnabled: boolean;
  onMetronomeEnabledChange: (enabled: boolean) => void;
  metronomeVolumePct: number;
  onMetronomeVolumeChange: (volumePct: number) => void;
  bpmBarStyle: BpmBarStyle;
  onBpmBarStyleChange: (style: BpmBarStyle) => void;
  bpmBarTimeSignatureMode: BpmBarTimeSignatureMode;
  onBpmBarTimeSignatureModeChange: (mode: BpmBarTimeSignatureMode) => void;
  bpmBarNumerator: number;
  onBpmBarNumeratorChange: (numerator: number) => void;
  bpmBarDenominator: number;
  onBpmBarDenominatorChange: (denominator: number) => void;
  bpmBarBeatOffset: number;
  onBpmBarBeatOffsetChange: (offset: number) => void;
  branchLookaheadEnabled: boolean;
  onBranchLookaheadEnabledChange: (enabled: boolean) => void;
  branchLookaheadCount: number;
  onBranchLookaheadCountChange: (count: number) => void;
};

export function TuningModal({
  open = true,
  playMode,
  tuneForm,
  onTuneFormChange,
  extrasForm,
  onExtrasFormChange,
  multi,
  visuals,
  songSync,
  onClose,
  showReset,
  onReset,
}: {
  open?: boolean;
  playMode: PlayMode;
  tuneForm: TuneFormState;
  onTuneFormChange: (next: TuneFormState) => void;
  extrasForm: ExtrasFormState;
  onExtrasFormChange: (next: ExtrasFormState) => void;
  multi: MultiTuningProps;
  visuals: VisualsTuningProps;
  detectedBeatsPerBar?: number;
  songSync?: SongSyncTuningProps;
  onClose: () => void;
  showReset: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  const isJukeboxMode = playMode === "jukebox";
  const isSongSyncMode = playMode === "songsync";
  const hasExtras = isJukeboxMode;
  const isTimeSignatureOverwrite =
    multi.multiTrackEnabled &&
    multi.timeSignatureBranchingEnabled &&
    multi.timeSignatureBranchMode === "overwrite";
  const timeSignatureStepBeats = resolveTimeSignatureBranchStepBeats(
    multi.timeSignatureNumerator,
    multi.timeSignatureDenominator,
  );
  const timeSignatureSimilarityStepBeats = resolveTimeSignatureBranchStepBeats(
    multi.timeSignatureSimilarityNumerator,
    multi.timeSignatureSimilarityDenominator,
  );
  const bpmBarSegmentCount = Math.min(
    MAX_BPM_BAR_SEGMENTS,
    Math.max(
      1,
      resolveTimeSignatureBranchStepBeats(
        visuals.bpmBarNumerator,
        visuals.bpmBarDenominator,
      ),
    ),
  );
  const requiresTimeSignature =
    isJukeboxMode &&
    (multi.timeSignatureSimilarityRestrictEnabled ||
      (multi.multiTrackEnabled && multi.timeSignatureBranchingEnabled));
  const showBpmBarPanel = visuals.bpmBarEnabled || requiresTimeSignature;
  const showTimeSignatureFraction =
    visuals.bpmBarTimeSignatureMode === "custom" ||
    (!visuals.bpmBarEnabled && requiresTimeSignature);
  const showBeatOffsetStepper =
    visuals.bpmBarTimeSignatureMode === "custom" ||
    (visuals.bpmBarEnabled && visuals.metronomeEnabled) ||
    requiresTimeSignature;

  const renderSimilarityRestrictGroup = (includeSingleTrackOffset: boolean) => {
    const singleTrackOffset = clampTimeSignatureTrackOffset(
      multi.timeSignatureTrackOffsets[0] ?? 0,
    );
    return (
      <div className="multi-time-sig-group">
        <label>
          <input
            id="time-signature-similarity-restrict-enabled"
            type="checkbox"
            checked={multi.timeSignatureSimilarityRestrictEnabled}
            onChange={(event) =>
              multi.onTimeSignatureSimilarityRestrictChange(event.target.checked)
            }
          />
          <span>{t("tuning.timeSignatureSimilarityRestrict")}</span>
        </label>
        {multi.timeSignatureSimilarityRestrictEnabled ? (
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
                value={multi.timeSignatureSimilarityNumerator}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(parsed)) {
                    multi.onTimeSignatureSimilarityNumeratorChange(parsed);
                  }
                }}
              />
              <span className="multi-time-sig-slash">/</span>
              <select
                id="time-signature-similarity-denominator"
                aria-label={t("tuning.timeSignatureDenominatorAria")}
                value={multi.timeSignatureSimilarityDenominator}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(parsed)) {
                    multi.onTimeSignatureSimilarityDenominatorChange(parsed);
                  }
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
                    onClick={() =>
                      multi.onTimeSignatureTrackOffsetChange(
                        0,
                        singleTrackOffset - 1,
                      )
                    }
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
                      if (Number.isFinite(parsed)) {
                        multi.onTimeSignatureTrackOffsetChange(0, parsed);
                      }
                    }}
                  />
                  <button
                    type="button"
                    id="time-signature-track-offset-inc-0"
                    aria-label="+"
                    disabled={
                      singleTrackOffset >= MAX_TIME_SIGNATURE_TRACK_OFFSET
                    }
                    onClick={() =>
                      multi.onTimeSignatureTrackOffsetChange(
                        0,
                        singleTrackOffset + 1,
                      )
                    }
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
    <div
      id="tuning-modal"
      className="modal inline-modal open"
      role="dialog"
      aria-modal="false"
      aria-labelledby="tuning-title"
    >
      <div className="modal-panel">
        <div className="modal-header">
          <div className="modal-header-main">
            <h2 id="tuning-title">
              <span id="tuning-title-text">{t("tuning.title")}</span>
            </h2>
          </div>
          <div className="modal-header-actions">
            <button
              id="tuning-close"
              className="modal-close"
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              <SymbolIcon className="modal-close-icon" name="close" />
            </button>
          </div>
        </div>
        <div className="modal-body tuning-body">
          {isJukeboxMode ? (
            <div id="tuning-panel-tuning" className="tuning-section-grid">
            <div className="tuning-sliders-col">
              <RangeRow
                id="threshold"
                label={t("tuning.similarityThreshold")}
                valueText={String(tuneForm.threshold)}
                min={2}
                max={100}
                step={1}
                value={tuneForm.threshold}
                disabled={multi.multiTrackEnabled && multi.crossTrackOnly}
                onChange={(threshold) =>
                  onTuneFormChange({ ...tuneForm, threshold })
                }
                hint={
                  <div className="hint">
                    <span>{t("tuning.computedThreshold")}</span>{" "}
                    <span id="computed-threshold">
                      {tuneForm.computedThreshold}
                    </span>
                    {multi.multiTrackEnabled && multi.crossTrackOnly ? (
                      <div>{t("tuning.sameSongThresholdDisabledHint")}</div>
                    ) : !multi.multiTrackEnabled &&
                      multi.timeSignatureSimilarityRestrictEnabled ? (
                      <div>{t("tuning.timeSignatureRestrictedHint")}</div>
                    ) : null}
                  </div>
                }
              />
              <RangeRow
                id="min-jump-distance"
                label={t("tuning.minJumpDistance")}
                valueText={formatMinJumpDistance(
                  tuneForm.minLongBranchPercent,
                  t,
                )}
                min={0}
                max={MIN_JUMP_DISTANCE_OPTIONS.length - 1}
                step={1}
                value={Math.max(
                  0,
                  MIN_JUMP_DISTANCE_OPTIONS.indexOf(
                    tuneForm.minLongBranchPercent as (typeof MIN_JUMP_DISTANCE_OPTIONS)[number],
                  ),
                )}
                onChange={(index) =>
                  onTuneFormChange({
                    ...tuneForm,
                    minLongBranchPercent:
                      MIN_JUMP_DISTANCE_OPTIONS[index] ?? 0,
                  })
                }
                hint={
                  <div className="hint">{t("tuning.minJumpDistanceHint")}</div>
                }
              />
              <RangeRow
                id="max-jump-distance"
                label={t("tuning.maxJumpDistance")}
                valueText={formatMaxJumpDistance(
                  tuneForm.maxLongBranchPercent,
                  t,
                )}
                min={1}
                max={100}
                step={1}
                value={
                  tuneForm.maxLongBranchPercent > 0
                    ? tuneForm.maxLongBranchPercent
                    : 100
                }
                onChange={(maxLongBranchPercent) =>
                  onTuneFormChange({ ...tuneForm, maxLongBranchPercent })
                }
                hint={
                  <div className="hint">{t("tuning.maxJumpDistanceHint")}</div>
                }
              />
              <RangeRow
                id="min-prob"
                label={t("tuning.probabilityMin")}
                valueText={`${tuneForm.minProb}%`}
                min={0}
                max={100}
                step={2}
                value={tuneForm.minProb}
                onChange={(minProb) =>
                  onTuneFormChange({ ...tuneForm, minProb })
                }
              />
              <RangeRow
                id="max-prob"
                label={t("tuning.probabilityMax")}
                valueText={`${tuneForm.maxProb}%`}
                min={0}
                max={100}
                step={2}
                value={tuneForm.maxProb}
                onChange={(maxProb) =>
                  onTuneFormChange({ ...tuneForm, maxProb })
                }
              />
              <RangeRow
                id="ramp"
                label={t("tuning.rampSpeed")}
                valueText={`${tuneForm.ramp}%`}
                min={0}
                max={100}
                step={2}
                value={tuneForm.ramp}
                onChange={(ramp) => onTuneFormChange({ ...tuneForm, ramp })}
              />
              {showReset ? (
                <div className="tuning-reset-row">
                  <button
                    type="button"
                    id="tuning-reset"
                    className="tab-btn"
                    onClick={onReset}
                  >
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
                    checked={tuneForm.justBackwards}
                    onChange={(event) =>
                      onTuneFormChange({
                        ...tuneForm,
                        justBackwards: event.target.checked,
                      })
                    }
                  />
                  <span>{t("tuning.onlyReverse")}</span>
                </label>
                <label>
                  <input
                    id="remove-seq"
                    type="checkbox"
                    checked={tuneForm.removeSequentialBranches}
                    onChange={(event) =>
                      onTuneFormChange({
                        ...tuneForm,
                        removeSequentialBranches: event.target.checked,
                      })
                    }
                  />
                  <span>{t("tuning.removeSequential")}</span>
                </label>
                <label>
                  <input
                    id="highlight-anchor-branch"
                    type="checkbox"
                    checked={tuneForm.highlightAnchorBranch}
                    onChange={(event) =>
                      onTuneFormChange({
                        ...tuneForm,
                        highlightAnchorBranch: event.target.checked,
                      })
                    }
                  />
                  <span>{t("tuning.highlightAnchor")}</span>
                </label>
              </div>
              {!multi.multiTrackEnabled && playMode === "jukebox"
                ? renderSimilarityRestrictGroup(true)
                : null}
              {multi.multiTrackEnabled ? (
                <div id="tuning-panel-multi" className="tuning-multi-section">
                  <h3>{t("tuning.multiTuning")}</h3>
                  <div className="checkbox-row multi-checkbox-row">
                    <label>
                      <input
                        id="cross-track-only"
                        type="checkbox"
                        checked={multi.crossTrackOnly}
                        onChange={(event) =>
                          multi.onCrossTrackOnlyChange(event.target.checked)
                        }
                      />
                      <span>{t("tuning.crossTrackOnly")}</span>
                    </label>
                    <label>
                      <input
                        id="cover-sync-enabled"
                        type="checkbox"
                        checked={multi.coverSyncEnabled}
                        onChange={(event) =>
                          multi.onCoverSyncChange(event.target.checked)
                        }
                      />
                      <span>{t("tuning.coverSync")}</span>
                    </label>
                    <label>
                      <input
                        id="tempo-sync-enabled"
                        type="checkbox"
                        checked={multi.tempoSyncEnabled}
                        onChange={(event) =>
                          multi.onTempoSyncChange(event.target.checked)
                        }
                      />
                      <span>{t("tuning.tempoSync")}</span>
                    </label>
                    <label>
                      <input
                        id="normalize-volume-enabled"
                        type="checkbox"
                        checked={multi.normalizeVolumeEnabled}
                        onChange={(event) =>
                          multi.onNormalizeVolumeChange(event.target.checked)
                        }
                      />
                      <span>{t("tuning.normalizeVolumePremix")}</span>
                    </label>
                    <label>
                      <input
                        id="post-mix-normalize-volume-enabled"
                        type="checkbox"
                        checked={multi.postMixNormalizeVolumeEnabled}
                        onChange={(event) =>
                          multi.onPostMixNormalizeVolumeChange(
                            event.target.checked,
                          )
                        }
                      />
                      <span>{t("tuning.normalizeVolumePostmix")}</span>
                    </label>
                  </div>
                  <RangeRow
                    id="cross-threshold"
                    label={t("tuning.crossSimilarityThreshold")}
                    valueText={String(tuneForm.crossThreshold)}
                    min={2}
                    max={100}
                    step={1}
                    value={tuneForm.crossThreshold}
                    disabled={isTimeSignatureOverwrite}
                    onChange={(crossThreshold) =>
                      onTuneFormChange({ ...tuneForm, crossThreshold })
                    }
                    hint={
                      <div className="hint">
                        {t("tuning.computedThreshold")}{" "}
                        <span id="computed-cross-threshold">
                          {tuneForm.computedCrossThreshold ?? "-"}
                        </span>
                        {isTimeSignatureOverwrite ? (
                          <div>{t("tuning.timeSignatureOverriddenHint")}</div>
                        ) : multi.timeSignatureSimilarityRestrictEnabled &&
                          multi.timeSignatureBranchingEnabled ? (
                          <div>{t("tuning.timeSignatureBothHint")}</div>
                        ) : multi.timeSignatureSimilarityRestrictEnabled ? (
                          <div>{t("tuning.timeSignatureRestrictedHint")}</div>
                        ) : multi.timeSignatureBranchingEnabled ? (
                          <div>{t("tuning.timeSignatureCombinedHint")}</div>
                        ) : null}
                      </div>
                    }
                  />
                  {multi.mixTracks.map((track, index) => {
                    const gainPct =
                      multi.mixTrackGainsPct[index] ??
                      DEFAULT_MIX_TRACK_GAIN_PCT;
                    return (
                      <RangeRow
                        key={index}
                        id={`mix-track-gain-${index}`}
                        label={t("tuning.trackVolume", {
                          index: index + 1,
                          title: track.title,
                        })}
                        valueText={`${gainPct}%`}
                        min={MIN_MIX_TRACK_GAIN_PCT}
                        max={MAX_MIX_TRACK_GAIN_PCT}
                        step={1}
                        value={gainPct}
                        onChange={(value) =>
                          multi.onMixTrackGainChange(index, value)
                        }
                      />
                    );
                  })}
                  {renderSimilarityRestrictGroup(false)}
                  <div className="multi-time-sig-group">
                    <label>
                      <input
                        id="time-signature-branching-enabled"
                        type="checkbox"
                        checked={multi.timeSignatureBranchingEnabled}
                        onChange={(event) =>
                          multi.onTimeSignatureBranchingChange(
                            event.target.checked,
                          )
                        }
                      />
                      <span>{t("tuning.timeSignatureOverwrite")}</span>
                    </label>
                    {multi.timeSignatureBranchingEnabled ? (
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
                            value={multi.timeSignatureBranchMode}
                            onChange={(event) =>
                              multi.onTimeSignatureBranchModeChange(
                                event.target.value as TimeSignatureBranchMode,
                              )
                            }
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
                            value={multi.timeSignatureNumerator}
                            onChange={(event) => {
                              const parsed = Number.parseInt(
                                event.target.value,
                                10,
                              );
                              if (Number.isFinite(parsed)) {
                                multi.onTimeSignatureNumeratorChange(parsed);
                              }
                            }}
                          />
                          <span className="multi-time-sig-slash">/</span>
                          <select
                            id="time-signature-denominator"
                            aria-label={t(
                              "tuning.timeSignatureDenominatorAria",
                            )}
                            value={multi.timeSignatureDenominator}
                            onChange={(event) => {
                              const parsed = Number.parseInt(
                                event.target.value,
                                10,
                              );
                              if (Number.isFinite(parsed)) {
                                multi.onTimeSignatureDenominatorChange(parsed);
                              }
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
                    {multi.timeSignatureBranchingEnabled ||
                    multi.timeSignatureSimilarityRestrictEnabled ? (
                      <div
                        id="multi-time-sig-offsets-panel"
                        className="multi-time-sig-controls"
                      >
                        <div className="hint">
                          {multi.coverSyncEnabled
                            ? t("tuning.timeSignatureCoverSyncHint")
                            : t("tuning.timeSignatureOffsetOnlyHint")}
                        </div>
                        <div className="multi-time-sig-offsets">
                          {multi.mixTracks.map((track, index) => {
                            const offset = clampTimeSignatureTrackOffset(
                              multi.timeSignatureTrackOffsets[index] ?? 0,
                            );
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
                                    onClick={() =>
                                      multi.onTimeSignatureTrackOffsetChange(
                                        index,
                                        offset - 1,
                                      )
                                    }
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
                                      if (Number.isFinite(parsed)) {
                                        multi.onTimeSignatureTrackOffsetChange(
                                          index,
                                          parsed,
                                        );
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    id={`time-signature-track-offset-inc-${index}`}
                                    aria-label="+"
                                    disabled={
                                      offset >= MAX_TIME_SIGNATURE_TRACK_OFFSET
                                    }
                                    onClick={() =>
                                      multi.onTimeSignatureTrackOffsetChange(
                                        index,
                                        offset + 1,
                                      )
                                    }
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
          ) : null}

          {isSongSyncMode && songSync ? (
            <div id="tuning-panel-songsync" className="tuning-multi-section">
              <h3>{t("tuning.songSyncTitle")}</h3>
              <div className="checkbox-row multi-checkbox-row">
                <label>
                  <input
                    id="songsync-tempo-sync-enabled"
                    type="checkbox"
                    checked={songSync.tempoSyncEnabled}
                    onChange={(event) =>
                      songSync.onTempoSyncChange(event.target.checked)
                    }
                  />
                  <span>{t("tuning.tempoSync")}</span>
                </label>
                <label>
                  <input
                    id="songsync-normalize-volume-enabled"
                    type="checkbox"
                    checked={songSync.normalizeVolumeEnabled}
                    onChange={(event) =>
                      songSync.onNormalizeVolumeChange(event.target.checked)
                    }
                  />
                  <span>{t("tuning.normalizeVolume")}</span>
                </label>
              </div>
              {songSync.tracks.length > 0 ? (
                <>
                  <div className="multi-time-sig-mode">
                    <label htmlFor="songsync-master-track">
                      {t("tuning.masterTrack")}
                    </label>
                    <select
                      id="songsync-master-track"
                      value={songSync.masterTrackIndex}
                      onChange={(event) =>
                        songSync.onMasterTrackChange(Number(event.target.value))
                      }
                    >
                      {songSync.tracks.map((track, idx) => (
                        <option key={idx} value={idx}>
                          {track.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="songsync-tracks-list">
                    {songSync.tracks.map((track, idx) => (
                      <div key={idx} className="songsync-track-row">
                        <div className="songsync-track-header">
                          <span className="songsync-track-title">
                            <span
                              className="songsync-track-dot"
                              style={{ background: track.color }}
                              aria-hidden="true"
                            />
                            <span>{track.title}</span>
                          </span>
                          <div className="checkbox-row">
                            <label>
                              <input
                                id={`songsync-track-mute-${idx}`}
                                type="checkbox"
                                checked={track.muted}
                                onChange={(event) =>
                                  songSync.onTrackMutedChange(
                                    idx,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>{t("tuning.mute")}</span>
                            </label>
                            <label>
                              <input
                                id={`songsync-track-solo-${idx}`}
                                type="checkbox"
                                checked={track.solo}
                                onChange={(event) =>
                                  songSync.onTrackSoloChange(
                                    idx,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>{t("tuning.solo")}</span>
                            </label>
                          </div>
                        </div>
                        <div className="songsync-track-controls">
                          <RangeRow
                            id={`songsync-track-gain-${idx}`}
                            label={t("tuning.trackVolume", {
                              index: idx + 1,
                              title: track.title,
                            })}
                            valueText={`${track.gainPct}%`}
                            min={MIN_MIX_TRACK_GAIN_PCT}
                            max={MAX_MIX_TRACK_GAIN_PCT}
                            step={1}
                            value={track.gainPct}
                            onChange={(value) =>
                              songSync.onTrackGainChange(idx, value)
                            }
                          />
                          <RangeRow
                            id={`songsync-track-pan-${idx}`}
                            label={t("tuning.pan")}
                            valueText={`${track.pan}`}
                            min={-100}
                            max={100}
                            step={1}
                            value={track.pan}
                            onChange={(value) =>
                              songSync.onTrackPanChange(idx, value)
                            }
                          />
                          <div className="multi-time-sig-offset-row">
                            <div className="multi-time-sig-offset-header">
                              <span>{t("tuning.beatOffset")}</span>
                            </div>
                            <div className="multi-time-sig-stepper">
                              <button
                                type="button"
                                id={`songsync-track-offset-dec-${idx}`}
                                aria-label="-"
                                disabled={
                                  track.beatOffset <=
                                  MIN_TIME_SIGNATURE_TRACK_OFFSET
                                }
                                onClick={() =>
                                  songSync.onTrackBeatOffsetChange(
                                    idx,
                                    track.beatOffset - 1,
                                  )
                                }
                              >
                                -
                              </button>
                              <input
                                id={`songsync-track-offset-${idx}`}
                                type="number"
                                min={MIN_TIME_SIGNATURE_TRACK_OFFSET}
                                max={MAX_TIME_SIGNATURE_TRACK_OFFSET}
                                step={1}
                                aria-label={t("tuning.beatOffset")}
                                value={track.beatOffset}
                                onChange={(event) => {
                                  const parsed = Number.parseInt(
                                    event.target.value,
                                    10,
                                  );
                                  if (Number.isFinite(parsed)) {
                                    songSync.onTrackBeatOffsetChange(
                                      idx,
                                      parsed,
                                    );
                                  }
                                }}
                              />
                              <button
                                type="button"
                                id={`songsync-track-offset-inc-${idx}`}
                                aria-label="+"
                                disabled={
                                  track.beatOffset >=
                                  MAX_TIME_SIGNATURE_TRACK_OFFSET
                                }
                                onClick={() =>
                                  songSync.onTrackBeatOffsetChange(
                                    idx,
                                    track.beatOffset + 1,
                                  )
                                }
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          <div id="tuning-panel-visuals" className="tuning-visuals-section">
            <h3>{t("tuning.visuals")}</h3>
            <div className="checkbox-row visuals-checkbox-row">
              <label>
                <input
                  id="bpm-bar-toggle"
                  type="checkbox"
                  checked={visuals.bpmBarEnabled}
                  onChange={(event) =>
                    visuals.onBpmBarEnabledChange(event.target.checked)
                  }
                />
                <span>{t("tuning.showBpmBar")}</span>
              </label>
              {isJukeboxMode ? (
                <>
                  <label>
                    <input
                      id="use-square-beats"
                      type="checkbox"
                      checked={visuals.visualPreferences.useSquareBeats}
                      onChange={(event) =>
                        visuals.onVisualPreferencesChange({
                          useSquareBeats: event.target.checked,
                        })
                      }
                    />
                    <span>{t("tuning.squareBeats")}</span>
                  </label>
                  <label>
                    <input
                      id="use-alt-seek-shape"
                      type="checkbox"
                      checked={visuals.visualPreferences.useAltSeekShape}
                      onChange={(event) =>
                        visuals.onVisualPreferencesChange({
                          useAltSeekShape: event.target.checked,
                        })
                      }
                    />
                    <span>{t("tuning.altSeekShape")}</span>
                  </label>
                  <label>
                    <input
                      id="branch-lookahead-toggle"
                      type="checkbox"
                      checked={visuals.branchLookaheadEnabled}
                      onChange={(event) =>
                        visuals.onBranchLookaheadEnabledChange(
                          event.target.checked,
                        )
                      }
                    />
                    <span>{t("tuning.showUpcomingBranches")}</span>
                  </label>
                </>
              ) : null}
            </div>
            {showBpmBarPanel ? (
              <div
                id="bpm-bar-time-sig-controls"
                className="multi-time-sig-controls"
              >
                {visuals.bpmBarEnabled ? (
                  <>
                    <div className="multi-time-sig-mode">
                      <label htmlFor="bpm-bar-style">
                        {t("tuning.bpmBarStyleLabel")}
                      </label>
                      <select
                        id="bpm-bar-style"
                        aria-label={t("tuning.bpmBarStyleLabel")}
                        value={visuals.bpmBarStyle}
                        onChange={(event) =>
                          visuals.onBpmBarStyleChange(
                            event.target.value as BpmBarStyle,
                          )
                        }
                      >
                        <option value="pulse">
                          {t("tuning.bpmBarStylePulse")}
                        </option>
                        <option value="smooth">
                          {t("tuning.bpmBarStyleSmooth")}
                        </option>
                        <option value="smooth-pulse">
                          {t("tuning.bpmBarStyleSmoothPulse")}
                        </option>
                      </select>
                    </div>
                    <div className="checkbox-row">
                      <label>
                        <input
                          id="bpm-bar-metronome-toggle"
                          type="checkbox"
                          checked={visuals.metronomeEnabled}
                          onChange={(event) =>
                            visuals.onMetronomeEnabledChange(
                              event.target.checked,
                            )
                          }
                        />
                        <span>{t("audioModes.metronome")}</span>
                      </label>
                    </div>
                    {visuals.metronomeEnabled ? (
                      <RangeRow
                        id="metronome-volume"
                        label={t("audioModes.metronomeVolume")}
                        valueText={`${visuals.metronomeVolumePct}%`}
                        min={MIN_METRONOME_VOLUME_PCT}
                        max={MAX_METRONOME_VOLUME_PCT}
                        step={5}
                        value={visuals.metronomeVolumePct}
                        onChange={visuals.onMetronomeVolumeChange}
                      />
                    ) : null}
                    <div className="multi-time-sig-mode">
                      <label htmlFor="bpm-bar-time-sig-mode">
                        {t("tuning.bpmBarTimeSignatureLabel")}
                      </label>
                      <select
                        id="bpm-bar-time-sig-mode"
                        aria-label={t("tuning.bpmBarTimeSignatureLabel")}
                        value={visuals.bpmBarTimeSignatureMode}
                        onChange={(event) =>
                          visuals.onBpmBarTimeSignatureModeChange(
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
                  </>
                ) : null}
                {showTimeSignatureFraction ? (
                  <div className="multi-time-sig-fraction">
                    <input
                      id="bpm-bar-numerator"
                      type="number"
                      min={MIN_TIME_SIGNATURE_NUMERATOR}
                      max={MAX_TIME_SIGNATURE_NUMERATOR}
                      step={1}
                      aria-label={t("tuning.timeSignatureNumeratorAria")}
                      value={visuals.bpmBarNumerator}
                      onChange={(event) => {
                        const parsed = Number.parseInt(
                          event.target.value,
                          10,
                        );
                        if (Number.isFinite(parsed)) {
                          visuals.onBpmBarNumeratorChange(parsed);
                        }
                      }}
                    />
                    <span className="multi-time-sig-slash">/</span>
                    <select
                      id="bpm-bar-denominator"
                      aria-label={t("tuning.timeSignatureDenominatorAria")}
                      value={visuals.bpmBarDenominator}
                      onChange={(event) => {
                        const parsed = Number.parseInt(
                          event.target.value,
                          10,
                        );
                        if (Number.isFinite(parsed)) {
                          visuals.onBpmBarDenominatorChange(parsed);
                        }
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
                        isSmoothBpmBarStyle(visuals.bpmBarStyle)
                          ? "tuning.bpmBarBeats"
                          : "tuning.bpmBarSegments",
                        { count: bpmBarSegmentCount },
                      )}
                    </span>
                  </div>
                ) : null}
                {showBeatOffsetStepper ? (
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
                          visuals.bpmBarBeatOffset <=
                          MIN_TIME_SIGNATURE_TRACK_OFFSET
                        }
                        onClick={() =>
                          visuals.onBpmBarBeatOffsetChange(
                            visuals.bpmBarBeatOffset - 1,
                          )
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
                        value={visuals.bpmBarBeatOffset}
                        onChange={(event) => {
                          const parsed = Number.parseInt(
                            event.target.value,
                            10,
                          );
                          if (Number.isFinite(parsed)) {
                            visuals.onBpmBarBeatOffsetChange(parsed);
                          }
                        }}
                      />
                      <button
                        type="button"
                        id="bpm-bar-beat-offset-inc"
                        aria-label="+"
                        disabled={
                          visuals.bpmBarBeatOffset >=
                          MAX_TIME_SIGNATURE_TRACK_OFFSET
                        }
                        onClick={() =>
                          visuals.onBpmBarBeatOffsetChange(
                            visuals.bpmBarBeatOffset + 1,
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {isJukeboxMode && visuals.branchLookaheadEnabled ? (
              <RangeRow
                id="branch-lookahead-count"
                label={t("tuning.upcomingBranches")}
                valueText={String(visuals.branchLookaheadCount)}
                min={MIN_BRANCH_LOOKAHEAD_COUNT}
                max={MAX_BRANCH_LOOKAHEAD_COUNT}
                step={1}
                value={visuals.branchLookaheadCount}
                onChange={visuals.onBranchLookaheadCountChange}
              />
            ) : null}
            {isJukeboxMode ? (
              <div className="visual-mode-group">
                <div className="label-line">{t("tuning.coloring")}</div>
                <div
                  className="visual-mode-options"
                  role="radiogroup"
                  aria-label={t("tuning.coloring")}
                >
                  {VISUAL_COLORING_OPTIONS.map((option) => (
                    <label key={option.id} className="visual-mode-option">
                      <input
                        id={option.id}
                        type="radio"
                        name="visual-effect-mode"
                        value={option.value}
                        checked={
                          visuals.visualPreferences.visualEffectMode ===
                          option.value
                        }
                        onChange={() =>
                          visuals.onVisualPreferencesChange({
                            visualEffectMode: option.value,
                          })
                        }
                      />
                      <span>{t(option.labelKey)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div
            id="tuning-panel-extras"
            className={hasExtras ? undefined : "hidden"}
          >
            <h3>{t("tuning.extras")}</h3>
            <div className="checkbox-row extras-checkbox-row">
              <label>
                <input
                  id="extras-enabled"
                  type="checkbox"
                  checked={extrasForm.branchStatsEnabled}
                  disabled={!hasExtras}
                  onChange={(event) =>
                    onExtrasFormChange({
                      ...extrasForm,
                      branchStatsEnabled: event.target.checked,
                    })
                  }
                />
                <span>{t("tuning.showBranchStats")}</span>
              </label>
              <label>
                <input
                  id="bring-home-enabled"
                  type="checkbox"
                  checked={extrasForm.bringItHomeMode}
                  disabled={!hasExtras}
                  onChange={(event) =>
                    onExtrasFormChange({
                      ...extrasForm,
                      bringItHomeMode: event.target.checked,
                    })
                  }
                />
                <span>{t("tuning.bringItHome")}</span>
              </label>
              <label>
                <input
                  id="custom-anchor-enabled"
                  type="checkbox"
                  checked={extrasForm.customAnchorEnabled}
                  disabled={!hasExtras}
                  onChange={(event) =>
                    onExtrasFormChange({
                      ...extrasForm,
                      customAnchorEnabled: event.target.checked,
                    })
                  }
                />
                <span>{t("tuning.customAnchor")}</span>
              </label>
            </div>
            <div id="jukebox-audio-mode-group" className="audio-mode-group">
              <div className="label-line">{t("tuning.audioMode")}</div>
              <AudioModeOptions
                selectedAudioMode={extrasForm.audioMode}
                disabled={!hasExtras}
                onChange={(audioMode) =>
                  onExtrasFormChange({ ...extrasForm, audioMode })
                }
                intensityPct={extrasForm.audioIntensity}
                onIntensityChange={(audioIntensity) =>
                  onExtrasFormChange({ ...extrasForm, audioIntensity })
                }
              />
            </div>
          </div>

          {isJukeboxMode ? (
            <div id="tuning-panel-advanced" className="tuning-advanced-section">
              <h3>{t("tuning.advanced")}</h3>
              <RangeRow
                id="max-branches"
                label={t("tuning.maxBranches")}
                valueText={String(tuneForm.maxBranches)}
                min={MIN_MAX_BRANCHES}
                max={MAX_MAX_BRANCHES}
                step={1}
                value={tuneForm.maxBranches}
                onChange={(maxBranches) =>
                  onTuneFormChange({ ...tuneForm, maxBranches })
                }
                hint={<div className="hint">{t("tuning.maxBranchesHint")}</div>}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
