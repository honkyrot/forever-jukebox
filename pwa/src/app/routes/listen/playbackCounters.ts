import type { BpmTrend } from "./liveBpm";

export type PlaybackCounterValues = {
  beatsPlayed: number;
  listenSeconds: number;
  jukeboxCurrentSeconds: number;
  branchChanceText: string;
  bpmText: string;
  bpmTrend: BpmTrend;
  autocanonizerMainSeconds: number;
  autocanonizerOtherSeconds: number;
  autocanonizerPinkSeconds: number;
  autocanonizerGoldSeconds: number;
  songSyncTrackSeconds: number[];
  wubMachineSeconds: number;
};

export type PlaybackCounters = {
  get: () => PlaybackCounterValues;
  set: (patch: Partial<PlaybackCounterValues>) => void;
  subscribe: (listener: (values: PlaybackCounterValues) => void) => () => void;
};

// Live playback counters kept outside React state; subscribers write them to the DOM.
export function createPlaybackCounters(): PlaybackCounters {
  let values: PlaybackCounterValues = {
    beatsPlayed: 0,
    listenSeconds: 0,
    jukeboxCurrentSeconds: 0,
    branchChanceText: "0%",
    bpmText: "--",
    bpmTrend: null,
    autocanonizerMainSeconds: 0,
    autocanonizerOtherSeconds: 0,
    autocanonizerPinkSeconds: 0,
    autocanonizerGoldSeconds: 0,
    songSyncTrackSeconds: [],
    wubMachineSeconds: 0,
  };
  const listeners = new Set<(values: PlaybackCounterValues) => void>();
  return {
    get: () => values,
    set: (patch) => {
      const next = { ...values, ...patch };
      const keys = Object.keys(next) as (keyof PlaybackCounterValues)[];
      if (keys.every((key) => next[key] === values[key])) {
        return;
      }
      values = next;
      listeners.forEach((listener) => listener(values));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
