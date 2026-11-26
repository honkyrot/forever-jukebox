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
  type BpmBeatSample,
} from "./liveBpm";

function makeBeats(
  durations: number[],
  trackIndices?: number[],
): BpmBeatSample[] {
  const list: BpmBeatSample[] = durations.map((duration, idx) => ({
    duration,
    trackIndex: trackIndices?.[idx],
  }));
  for (let i = 0; i < list.length; i += 1) {
    list[i].prev = i > 0 ? list[i - 1] : null;
    list[i].next = i < list.length - 1 ? list[i + 1] : null;
  }
  return list;
}

describe("liveBpm", () => {
  describe("resolveTrackBaseTempoBpm", () => {
    it("prefers valid track.tempo metadata", () => {
      const beats = makeBeats([0.5, 0.5]);
      expect(resolveTrackBaseTempoBpm(128.4, beats)).toBe(128.4);
    });

    it("falls back to median beat BPM when track.tempo is missing or invalid", () => {
      const beats = makeBeats([0.5, 0.6, 0.5, 10, 0.5]); // 120, 100, 120, invalid, 120
      expect(resolveTrackBaseTempoBpm(undefined, beats)).toBe(120);
      expect(resolveTrackBaseTempoBpm(0, beats)).toBe(120);
      expect(resolveTrackBaseTempoBpm(Number.NaN, beats)).toBe(120);
    });

    it("returns null when neither tempo nor valid beats exist", () => {
      expect(resolveTrackBaseTempoBpm(null, [])).toBeNull();
      expect(resolveTrackBaseTempoBpm(undefined, makeBeats([0.01, 8]))).toBeNull();
    });
  });

  describe("resolveLocalBeatBpm", () => {
    it("smooths alternating quantization jitter and single-beat outliers with a 5-beat median", () => {
      // Durations around 125 BPM (0.48s) with a single 0.25s (240 BPM) outlier at index 2.
      const beats = makeBeats([0.48, 0.49, 0.25, 0.48, 0.49]);
      const bpm = resolveLocalBeatBpm(beats[2], beats, 2);
      expect(bpm).toBeCloseTo(125, 5);
    });

    it("works via prev/next pointers when no beats array is supplied", () => {
      const beats = makeBeats([0.5, 0.5, 0.5, 0.5, 0.5]);
      const bpm = resolveLocalBeatBpm(beats[2]);
      expect(bpm).toBeCloseTo(120, 5);
    });

    it("stays within the same trackIndex across multi-track boundaries", () => {
      const beats = makeBeats(
        [0.5, 0.5, 0.4, 0.4, 0.4],
        [0, 0, 1, 1, 1],
      );
      // Beat 2 is the first beat of track 1 (150 BPM); track 0 (120 BPM) must not bleed in.
      expect(resolveLocalBeatBpm(beats[2], beats, 2)).toBeCloseTo(150, 5);
      // Linked-list fallback must also stop at the trackIndex boundary.
      expect(resolveLocalBeatBpm(beats[2])).toBeCloseTo(150, 5);
    });
  });

  describe("resolveEffectivePlaybackRate", () => {
    it("returns 1 outside jukebox mode", () => {
      expect(
        resolveEffectivePlaybackRate("autocanonizer", "nightcore", 130, 1.3),
      ).toBe(1);
    });

    it("prefers explicit positive playerRate in jukebox mode and falls back to mode settings", () => {
      expect(
        resolveEffectivePlaybackRate("jukebox", "nightcore", 100, 1.25),
      ).toBe(1.25);
      expect(
        resolveEffectivePlaybackRate("jukebox", "nightcore", 100, null),
      ).toBeCloseTo(1.2, 5);
      expect(
        resolveEffectivePlaybackRate("jukebox", "daycore", 100),
      ).toBeCloseTo(0.8, 5);
    });
  });

  describe("stepBpmTracker", () => {
    it("seeds without triggering an arrow on the first reading", () => {
      const initial = createBpmTrackerState(null);
      const next = stepBpmTracker(initial, 125);
      expect(next).toEqual({
        currentBpm: 125,
        referenceBpm: 125,
        trend: null,
        beatsSinceChange: 0,
      });
    });

    it("does not trigger an arrow for shifts of 10 BPM or less", () => {
      let state = createBpmTrackerState(120);
      state = stepBpmTracker(state, 130);
      expect(state.trend).toBeNull();
      expect(state.currentBpm).toBe(130);

      state = createBpmTrackerState(120);
      state = stepBpmTracker(state, 110);
      expect(state.trend).toBeNull();
      expect(state.currentBpm).toBe(110);
    });

    it("triggers up/down arrows for shifts strictly greater than 10 BPM and clears after holding", () => {
      let state = createBpmTrackerState(120);
      state = stepBpmTracker(state, 131);
      expect(state.trend).toBe("up");
      expect(state.currentBpm).toBe(131);
      expect(state.beatsSinceChange).toBe(0);

      for (let i = 1; i < BPM_CHANGE_HOLD_BEATS; i += 1) {
        state = stepBpmTracker(state, 131);
        expect(state.trend).toBe("up");
        expect(state.beatsSinceChange).toBe(i);
      }

      // The 6th stable beat clears the trend and settles the new reference.
      state = stepBpmTracker(state, 131);
      expect(state.trend).toBeNull();
      expect(state.referenceBpm).toBe(131);

      state = stepBpmTracker(state, 120);
      expect(state.trend).toBe("down");
      expect(state.currentBpm).toBe(120);
    });

    it("flips direction immediately when tempo drops by >10 BPM mid-hold", () => {
      let state = createBpmTrackerState(100);
      state = stepBpmTracker(state, 130);
      expect(state.trend).toBe("up");
      state = stepBpmTracker(state, 115);
      expect(state.trend).toBe("down");
      expect(state.beatsSinceChange).toBe(0);
    });

    it("supports gradual ramps accumulating past 10 BPM", () => {
      let state = createBpmTrackerState(100);
      // 116 BPM exceeds the slowly drifting reference by > 10 BPM.
      for (const bpm of [104, 108, 112, 116]) {
        state = stepBpmTracker(state, bpm);
      }
      expect(state.trend).toBe("up");
    });

    it("does not advance hold beat count when advanceBeat is false", () => {
      let state = createBpmTrackerState(120);
      state = stepBpmTracker(state, 144, { advanceBeat: false });
      expect(state.trend).toBe("up");
      expect(state.beatsSinceChange).toBe(0);
      state = stepBpmTracker(state, 144, { advanceBeat: false });
      expect(state.trend).toBe("up");
      expect(state.beatsSinceChange).toBe(0);
    });

    it("clears trend via clearBpmTrackerTrend", () => {
      const jumped = stepBpmTracker(createBpmTrackerState(120), 140);
      expect(jumped.trend).toBe("up");
      const cleared = clearBpmTrackerTrend(jumped);
      expect(cleared).toEqual({
        currentBpm: 140,
        referenceBpm: 140,
        trend: null,
        beatsSinceChange: 0,
      });
    });
  });

  describe("formatBpmText", () => {
    it("formats finite positive BPMs as rounded integers and falls back to --", () => {
      expect(formatBpmText(124.6)).toBe("125");
      expect(formatBpmText(null)).toBe("--");
      expect(formatBpmText(0)).toBe("--");
      expect(formatBpmText(Number.NaN)).toBe("--");
    });
  });
});
