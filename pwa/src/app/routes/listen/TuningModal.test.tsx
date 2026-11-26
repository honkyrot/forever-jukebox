import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_TIME_SIGNATURE_BRANCH_MODE } from "@forever-jukebox/shared";
import "@/app/i18n";
import {
  TuningModal,
  type MultiTuningProps,
  type VisualsTuningProps,
} from "./TuningModal";
import type { TuneFormState } from "./tuning";
import { resolveStoredVisualPreferences } from "./visualPreferences";

const baseTuneForm: TuneFormState = {
  threshold: 30,
  computedThreshold: 30,
  crossThreshold: 30,
  computedCrossThreshold: null,
  maxBranches: 8,
  minProb: 18,
  maxProb: 50,
  ramp: 10,
  volume: 50,
  highlightAnchorBranch: false,
  justBackwards: false,
  minLongBranchPercent: 0,
  maxLongBranchPercent: 100,
  removeSequentialBranches: false,
};

const baseExtrasForm = {
  branchStatsEnabled: false,
  bringItHomeMode: false,
  customAnchorEnabled: false,
  audioMode: "off" as const,
  audioIntensity: 100,
  metronomeVolumePct: 100,
  metronomeBeatsPerBar: null,
  metronomeBeatOffset: 0,
};

function createMulti(overrides: Partial<MultiTuningProps> = {}): MultiTuningProps {
  return {
    multiTrackEnabled: false,
    mixTracks: [],
    crossTrackOnly: false,
    onCrossTrackOnlyChange: vi.fn(),
    coverSyncEnabled: false,
    onCoverSyncChange: vi.fn(),
    tempoSyncEnabled: true,
    onTempoSyncChange: vi.fn(),
    normalizeVolumeEnabled: false,
    onNormalizeVolumeChange: vi.fn(),
    postMixNormalizeVolumeEnabled: false,
    onPostMixNormalizeVolumeChange: vi.fn(),
    mixTrackGainsPct: [],
    onMixTrackGainChange: vi.fn(),
    timeSignatureBranchingEnabled: false,
    onTimeSignatureBranchingChange: vi.fn(),
    timeSignatureBranchMode: DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
    onTimeSignatureBranchModeChange: vi.fn(),
    timeSignatureNumerator: 4,
    onTimeSignatureNumeratorChange: vi.fn(),
    timeSignatureDenominator: 4,
    onTimeSignatureDenominatorChange: vi.fn(),
    timeSignatureTrackOffsets: [0],
    onTimeSignatureTrackOffsetChange: vi.fn(),
    timeSignatureSimilarityRestrictEnabled: false,
    onTimeSignatureSimilarityRestrictChange: vi.fn(),
    timeSignatureSimilarityNumerator: 4,
    onTimeSignatureSimilarityNumeratorChange: vi.fn(),
    timeSignatureSimilarityDenominator: 4,
    onTimeSignatureSimilarityDenominatorChange: vi.fn(),
    ...overrides,
  };
}

function createVisuals(
  overrides: Partial<VisualsTuningProps> = {},
): VisualsTuningProps {
  return {
    visualPreferences: resolveStoredVisualPreferences(),
    onVisualPreferencesChange: vi.fn(),
    bpmBarEnabled: true,
    onBpmBarEnabledChange: vi.fn(),
    bpmBarStyle: "pulse",
    onBpmBarStyleChange: vi.fn(),
    bpmBarTimeSignatureMode: "auto",
    onBpmBarTimeSignatureModeChange: vi.fn(),
    bpmBarNumerator: 4,
    onBpmBarNumeratorChange: vi.fn(),
    bpmBarDenominator: 4,
    onBpmBarDenominatorChange: vi.fn(),
    bpmBarBeatOffset: 0,
    onBpmBarBeatOffsetChange: vi.fn(),
    branchLookaheadEnabled: false,
    onBranchLookaheadEnabledChange: vi.fn(),
    branchLookaheadCount: 4,
    onBranchLookaheadCountChange: vi.fn(),
    ...overrides,
  };
}

describe("TuningModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the inline tuning dialog with tuning, visuals, extras, and advanced sections", () => {
    const onTuneFormChange = vi.fn();
    const onExtrasFormChange = vi.fn();
    const visuals = createVisuals();

    const { container } = render(
      <TuningModal
        open={true}
        playMode="jukebox"
        tuneForm={baseTuneForm}
        onTuneFormChange={onTuneFormChange}
        extrasForm={baseExtrasForm}
        onExtrasFormChange={onExtrasFormChange}
        multi={createMulti()}
        visuals={visuals}
        detectedBeatsPerBar={4}
        onClose={() => {}}
        showReset={false}
        onReset={() => {}}
      />,
    );

    const title = screen.getByRole("heading", { level: 2 }).textContent!;
    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(container.querySelector("#tuning-panel-tuning")).not.toBeNull();
    expect(container.querySelector("#tuning-panel-visuals")).not.toBeNull();
    expect(container.querySelector("#tuning-panel-extras")).not.toBeNull();
    expect(container.querySelector("#tuning-panel-advanced")).not.toBeNull();
    expect(container.querySelector("#tuning-panel-multi")).toBeNull();

    const squareToggle = container.querySelector<HTMLInputElement>("#use-square-beats")!;
    fireEvent.click(squareToggle);
    expect(visuals.onVisualPreferencesChange).toHaveBeenCalledWith({
      useSquareBeats: true,
    });

    const justBackwards = container.querySelector<HTMLInputElement>("#just-backwards")!;
    fireEvent.click(justBackwards);
    expect(onTuneFormChange).toHaveBeenCalledWith(
      expect.objectContaining({ justBackwards: true }),
    );
  });

  it("renders Multi Tuning controls when multiTrackEnabled is true and shows reset when dirty", () => {
    const onReset = vi.fn();
    const { container } = render(
      <TuningModal
        open={true}
        playMode="jukebox"
        tuneForm={baseTuneForm}
        onTuneFormChange={() => {}}
        extrasForm={baseExtrasForm}
        onExtrasFormChange={() => {}}
        multi={createMulti({
          multiTrackEnabled: true,
          mixTracks: [{ title: "Track A" }, { title: "Track B" }],
          mixTrackGainsPct: [100, 120],
          timeSignatureTrackOffsets: [0, 0],
        })}
        visuals={createVisuals()}
        detectedBeatsPerBar={4}
        onClose={() => {}}
        showReset={true}
        onReset={onReset}
      />,
    );

    expect(container.querySelector("#tuning-panel-multi")).not.toBeNull();
    const resetBtn = container.querySelector<HTMLButtonElement>("#tuning-reset");
    expect(resetBtn).not.toBeNull();
    fireEvent.click(resetBtn!);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("renders Pitch Based coloring option and emits visualEffectMode '4'", () => {
    const visuals = createVisuals();
    const { container } = render(
      <TuningModal
        open={true}
        playMode="jukebox"
        tuneForm={baseTuneForm}
        onTuneFormChange={() => {}}
        extrasForm={baseExtrasForm}
        onExtrasFormChange={() => {}}
        multi={createMulti()}
        visuals={visuals}
        detectedBeatsPerBar={4}
        onClose={() => {}}
        showReset={false}
        onReset={() => {}}
      />,
    );

    const pitchRadio = container.querySelector<HTMLInputElement>(
      "#use-pitch-colors",
    );
    expect(pitchRadio).not.toBeNull();
    fireEvent.click(pitchRadio!);
    expect(visuals.onVisualPreferencesChange).toHaveBeenCalledWith({
      visualEffectMode: "4",
    });
  });
});
