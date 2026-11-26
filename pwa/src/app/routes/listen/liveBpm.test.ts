import { describe, expect, it } from "vitest";
import {
  BPM_CHANGE_HOLD_BEATS,
  clearBpmTrackerTrend,
  createBpmTrackerState,
  formatBpmText,
  resolveEffectivePlaybackRate,
  resolveLocalBeatBpm,
  resolveTrackBaseTempoBpm,
  stepBpmTracker,
} from "./liveBpm";

describe("liveBpm", () => {
  it("resolves baseline track tempo or falls back to median beat duration", () => {
    expect(resolveTrackBaseTempoBpm(128, [])).toBe(128);
    expect(
      resolveTrackBaseTempoBpm(null, [
        { duration: 0.5 },
        { duration: 0.5 },
        { duration: 1.0 },
      ]),
    ).toBeCloseTo(120);
    expect(resolveTrackBaseTempoBpm(undefined, [])).toBeNull();
  });

  it("computes local median BPM constrained by trackIndex", () => {
    const beats = [
      { duration: 0.5, trackIndex: 0 },
      { duration: 0.5, trackIndex: 0 },
      { duration: 0.5, trackIndex: 0 },
      { duration: 1.0, trackIndex: 1 },
      { duration: 1.0, trackIndex: 1 },
    ];
    expect(resolveLocalBeatBpm(beats[1], beats, 1)).toBeCloseTo(120);
    expect(resolveLocalBeatBpm(beats[3], beats, 3)).toBeCloseTo(60);
  });

  it("flags up/down tempo trend on shifts over 10 BPM and settles after hold beats", () => {
    let state = createBpmTrackerState(120);
    expect(state.trend).toBeNull();

    state = stepBpmTracker(state, 135);
    expect(state.currentBpm).toBe(135);
    expect(state.trend).toBe("up");

    for (let i = 0; i < BPM_CHANGE_HOLD_BEATS - 1; i += 1) {
      state = stepBpmTracker(state, 135);
      expect(state.trend).toBe("up");
    }
    state = stepBpmTracker(state, 135);
    expect(state.trend).toBeNull();

    state = stepBpmTracker(state, 118);
    expect(state.trend).toBe("down");
    state = clearBpmTrackerTrend(state);
    expect(state.trend).toBeNull();
    expect(state.referenceBpm).toBe(118);
  });

  it("formats BPM display values and resolves playback rate", () => {
    expect(formatBpmText(123.6)).toBe("124");
    expect(formatBpmText(null)).toBe("--");
    expect(resolveEffectivePlaybackRate("jukebox", "nightcore", 100, 1.25)).toBe(1.25);
    expect(resolveEffectivePlaybackRate("autocanonizer", "nightcore", 100, 1.25)).toBe(1);
  });
});
