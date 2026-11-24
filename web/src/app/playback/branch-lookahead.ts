import type { AppContext } from "../context";
import { useAppStore } from "../store";

/**
 * Pushes the current predicted upcoming branch jumps from the engine to the
 * visualization, or clears them when lookahead is disabled or outside jukebox mode.
 */
export function syncPredictedJumps(context: AppContext | null | undefined): void {
  if (
    !context?.jukebox ||
    typeof context.jukebox.setPredictedJumps !== "function"
  ) {
    return;
  }
  const { branchLookaheadEnabled, branchLookaheadCount, playMode } =
    useAppStore.getState();
  if (
    !branchLookaheadEnabled ||
    playMode !== "jukebox" ||
    !context.engine ||
    typeof context.engine.getPredictedJumps !== "function"
  ) {
    context.jukebox.setPredictedJumps([]);
    return;
  }
  context.jukebox.setPredictedJumps(
    context.engine.getPredictedJumps(branchLookaheadCount),
  );
}
