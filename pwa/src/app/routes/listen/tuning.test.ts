import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import {
  formatMaxJumpDistance,
  tuneFormChanged,
  type TuneFormState,
} from "./tuning";

const FORM: TuneFormState = {
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

describe("tuneFormChanged", () => {
  it("ignores volume, anchor highlight, and computed threshold", () => {
    expect(
      tuneFormChanged(FORM, {
        ...FORM,
        volume: 80,
        highlightAnchorBranch: true,
        computedThreshold: 35,
        computedCrossThreshold: 40,
      }),
    ).toBe(false);
  });

  it("flags tuning edits", () => {
    expect(tuneFormChanged(FORM, { ...FORM, threshold: 40 })).toBe(true);
    expect(tuneFormChanged(FORM, { ...FORM, crossThreshold: 45 })).toBe(true);
    expect(tuneFormChanged(FORM, { ...FORM, maxBranches: 4 })).toBe(true);
    expect(tuneFormChanged(FORM, { ...FORM, minLongBranchPercent: 10 })).toBe(true);
    expect(tuneFormChanged(FORM, { ...FORM, maxLongBranchPercent: 80 })).toBe(true);
    expect(tuneFormChanged(FORM, { ...FORM, justBackwards: true })).toBe(true);
  });

  it("formats max jump distance checkpoints", () => {
    const t = ((key: string, opts?: Record<string, unknown>) =>
      opts?.percent ? `<=${opts.percent}%` : key) as unknown as TFunction;
    expect(formatMaxJumpDistance(100, t)).toBe("tuning.anyDistance");
    expect(formatMaxJumpDistance(80, t)).toBe("<=80%");
  });
});
