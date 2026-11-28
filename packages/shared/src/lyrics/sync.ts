import type { PredictedJump, QuantumBase } from "../engine/types";
import type {
  AutocanonizerLyricsState,
  KaraokeDisplayState,
  LyricsBackgroundSyncState,
  LyricsLine,
  LyricsVoiceCursor,
  NormalizedLyrics,
} from "./types";

const DEFAULT_MEASURE_BEATS = 4;
const DEFAULT_BEAT_DURATION_SEC = 0.5;
const MIN_LEAD_IN_SEC = 1.5;
const MAX_LEAD_IN_SEC = 4.0;
// Small gaps between consecutive lyric lines stay anchored to the outgoing line
// rather than flashing empty between every phrase.
const MAX_LINE_BRIDGE_GAP_SEC = 0.35;

/**
 * Binary-searches sorted timed lyric lines for the line active at `timeSec`.
 * Returns `-1` before the first line or during instrumental gaps.
 */
export function findActiveLineIndex(
  lines: readonly LyricsLine[],
  timeSec: number,
): number {
  if (lines.length === 0 || !Number.isFinite(timeSec)) {
    return -1;
  }
  let low = 0;
  let high = lines.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const lineStart = lines[mid].startTime;
    if (lineStart === null) {
      return -1;
    }
    if (lineStart <= timeSec) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) {
    return -1;
  }

  const line = lines[candidate];
  if (line.startTime === null) {
    return -1;
  }
  const nextLine = lines[candidate + 1];
  const lineEnd =
    line.endTime !== null
      ? line.endTime
      : nextLine?.startTime ?? line.startTime + 4;

  if (timeSec <= lineEnd) {
    return candidate;
  }

  if (
    nextLine?.startTime !== null &&
    nextLine?.startTime !== undefined &&
    nextLine.startTime - lineEnd <= MAX_LINE_BRIDGE_GAP_SEC &&
    timeSec < nextLine.startTime
  ) {
    return candidate;
  }

  return -1;
}

/**
 * Binary-searches sorted timed lyric lines for the first line starting strictly
 * after `timeSec`. Returns `-1` when no upcoming line exists.
 */
export function findNextLineIndex(
  lines: readonly LyricsLine[],
  timeSec: number,
): number {
  if (lines.length === 0 || !Number.isFinite(timeSec)) {
    return -1;
  }
  let low = 0;
  let high = lines.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const lineStart = lines[mid].startTime;
    if (lineStart === null) {
      return -1;
    }
    if (lineStart > timeSec) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
}

/**
 * Computes the active syllable index and `[0, 1]` sweep progress within that
 * syllable for a `Syllable`-timed vocal group.
 */
export function resolveSyllableProgress(
  line: Pick<LyricsLine, "syllables">,
  timeSec: number,
): { activeSyllableIndex: number; progress: number } {
  const syllables = line.syllables;
  if (!syllables || syllables.length === 0 || !Number.isFinite(timeSec)) {
    return { activeSyllableIndex: -1, progress: 0 };
  }
  if (timeSec < syllables[0].startTime) {
    return { activeSyllableIndex: -1, progress: 0 };
  }
  const lastIndex = syllables.length - 1;
  if (timeSec >= syllables[lastIndex].endTime) {
    return { activeSyllableIndex: syllables.length, progress: 1 };
  }

  for (let i = 0; i < syllables.length; i += 1) {
    const syl = syllables[i];
    if (timeSec < syl.startTime) {
      // Between syllables: hold previous syllable complete.
      return { activeSyllableIndex: i - 1, progress: 1 };
    }
    if (timeSec <= syl.endTime) {
      const span = syl.endTime - syl.startTime;
      const progress =
        span > 0
          ? Math.max(0, Math.min(1, (timeSec - syl.startTime) / span))
          : 1;
      return { activeSyllableIndex: i, progress };
    }
  }

  return { activeSyllableIndex: syllables.length, progress: 1 };
}

export interface ResolveKaraokeStateInput {
  lyrics: NormalizedLyrics | null;
  playbackTimeSec: number;
  offsetSec?: number;
  beats?: readonly QuantumBase[];
  currentBeatIndex?: number | null;
  beatsPerBar?: number;
  nextJump?: PredictedJump | null;
}

const EMPTY_KARAOKE_STATE: KaraokeDisplayState = {
  activeLine: null,
  activeLineIndex: -1,
  activeSyllableIndex: -1,
  activeSyllableProgress: 0,
  backgroundStates: [],
  nextLine: null,
  nextLineIndex: -1,
  nextLineVisible: false,
  isBranchPreview: false,
  branchBeatsRemaining: null,
};

/**
 * Resolves syllable progress and active window status for each concurrent
 * `Background` vocal phrase attached to `line`.
 */
function resolveBackgroundStates(
  line: LyricsLine | null,
  timeSec: number,
): LyricsBackgroundSyncState[] {
  if (!line?.backgroundVocals || line.backgroundVocals.length === 0) {
    return [];
  }
  return line.backgroundVocals.map((bg) => {
    const { activeSyllableIndex, progress } = resolveSyllableProgress(bg, timeSec);
    const isActive =
      bg.startTime !== null && bg.endTime !== null
        ? timeSec >= bg.startTime && timeSec <= bg.endTime
        : activeSyllableIndex >= 0 &&
          activeSyllableIndex < (bg.syllables?.length ?? 0);
    return {
      isActive,
      activeSyllableIndex,
      activeSyllableProgress: progress,
    };
  });
}

/**
 * Resolves the two-line karaoke display state for the current playback cursor,
 * switching Line 2 to the predicted branch destination lyric when a Jukebox jump
 * is within one measure (and suppressing far-away lyrics during instrumental breaks).
 */
export function resolveKaraokeState(
  input: ResolveKaraokeStateInput,
): KaraokeDisplayState {
  const {
    lyrics,
    playbackTimeSec,
    offsetSec = 0,
    beats = [],
    currentBeatIndex = -1,
    beatsPerBar = DEFAULT_MEASURE_BEATS,
    nextJump = null,
  } = input;

  if (!lyrics || lyrics.type === "static" || lyrics.lines.length === 0) {
    return EMPTY_KARAOKE_STATE;
  }

  const adjustedTime = playbackTimeSec + offsetSec;
  const activeLineIndex = findActiveLineIndex(lyrics.lines, adjustedTime);
  const activeLine =
    activeLineIndex >= 0 ? lyrics.lines[activeLineIndex] : null;
  const { activeSyllableIndex, progress: activeSyllableProgress } = activeLine
    ? resolveSyllableProgress(activeLine, adjustedTime)
    : { activeSyllableIndex: -1, progress: 0 };
  const backgroundStates = resolveBackgroundStates(activeLine, adjustedTime);

  const linearNextIndex =
    activeLineIndex >= 0
      ? activeLineIndex + 1 < lyrics.lines.length
        ? activeLineIndex + 1
        : -1
      : findNextLineIndex(lyrics.lines, adjustedTime);

  const measureBeats = Math.max(
    1,
    Math.round(
      Number.isFinite(beatsPerBar) && beatsPerBar > 0
        ? beatsPerBar
        : DEFAULT_MEASURE_BEATS,
    ),
  );
  const resolvedBeatIndex =
    typeof currentBeatIndex === "number" && currentBeatIndex >= 0
      ? currentBeatIndex
      : -1;
  const currentBeat =
    resolvedBeatIndex >= 0 ? beats[resolvedBeatIndex] : undefined;
  const beatDur =
    currentBeat && currentBeat.duration > 0
      ? currentBeat.duration
      : DEFAULT_BEAT_DURATION_SEC;
  const leadInSec = Math.max(
    MIN_LEAD_IN_SEC,
    Math.min(measureBeats * beatDur, MAX_LEAD_IN_SEC),
  );

  // JukeboxEngine executes predicted jumps at `fromBeat.start` (skipping `fromIndex`
  // into `toIndex`). When that jump is within 1 measure and happens before the
  // next linear line starts, preview the destination lyric (or hide Line 2 if the
  // jump lands in a long instrumental break).
  if (nextJump && resolvedBeatIndex >= 0) {
    const fromBeat = beats[nextJump.fromIndex];
    const toBeat = beats[nextJump.toIndex];
    if (fromBeat && toBeat) {
      const beatsUntilJump =
        nextJump.fromIndex >= resolvedBeatIndex
          ? nextJump.fromIndex - resolvedBeatIndex
          : beats.length > 0
            ? beats.length - resolvedBeatIndex + nextJump.fromIndex
            : -1;
      const jumpExecTime = fromBeat.start;
      const secsUntilJump = Math.max(0, jumpExecTime - playbackTimeSec);
      const linearNextStart =
        linearNextIndex >= 0
          ? (lyrics.lines[linearNextIndex].startTime ?? Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;

      if (
        beatsUntilJump >= 1 &&
        beatsUntilJump <= measureBeats &&
        jumpExecTime >= playbackTimeSec - 0.05 &&
        secsUntilJump <= leadInSec &&
        jumpExecTime + offsetSec < linearNextStart
      ) {
        const destLyricTime = toBeat.start + offsetSec;
        const destActiveIndex = findActiveLineIndex(lyrics.lines, destLyricTime);
        if (destActiveIndex >= 0 && destActiveIndex !== activeLineIndex) {
          return {
            activeLine,
            activeLineIndex,
            activeSyllableIndex,
            activeSyllableProgress,
            backgroundStates,
            nextLine: lyrics.lines[destActiveIndex],
            nextLineIndex: destActiveIndex,
            nextLineVisible: true,
            isBranchPreview: true,
            branchBeatsRemaining: beatsUntilJump,
          };
        }

        const destNextIndex = findNextLineIndex(lyrics.lines, destLyricTime);
        if (destNextIndex >= 0) {
          const destNextStart =
            lyrics.lines[destNextIndex].startTime ?? Number.POSITIVE_INFINITY;
          const totalWaitFromNow =
            secsUntilJump + Math.max(0, destNextStart - destLyricTime);
          if (totalWaitFromNow <= leadInSec) {
            return {
              activeLine,
              activeLineIndex,
              activeSyllableIndex,
              activeSyllableProgress,
              backgroundStates,
              nextLine: lyrics.lines[destNextIndex],
              nextLineIndex: destNextIndex,
              nextLineVisible: true,
              isBranchPreview: true,
              branchBeatsRemaining: beatsUntilJump,
            };
          }
        }

        // Jump is imminent and bypasses the linear next line, landing in an instrumental gap.
        return {
          activeLine,
          activeLineIndex,
          activeSyllableIndex,
          activeSyllableProgress,
          backgroundStates,
          nextLine: null,
          nextLineIndex: -1,
          nextLineVisible: false,
          isBranchPreview: false,
          branchBeatsRemaining: null,
        };
      }
    }
  }

  const nextLine = linearNextIndex >= 0 ? lyrics.lines[linearNextIndex] : null;
  const nextLineVisible = Boolean(
    nextLine &&
      nextLine.startTime !== null &&
      nextLine.startTime - adjustedTime <= leadInSec,
  );

  return {
    activeLine,
    activeLineIndex,
    activeSyllableIndex,
    activeSyllableProgress,
    backgroundStates,
    nextLine,
    nextLineIndex: linearNextIndex,
    nextLineVisible,
    isBranchPreview: false,
    branchBeatsRemaining: null,
  };
}

const EMPTY_VOICE_CURSOR: LyricsVoiceCursor = {
  activeLine: null,
  activeLineIndex: -1,
  activeSyllableIndex: -1,
  activeSyllableProgress: 0,
  backgroundStates: [],
  upcomingLine: null,
  upcomingLineIndex: -1,
  upcomingLineVisible: false,
};

export const EMPTY_AUTOCANONIZER_LYRICS_STATE: AutocanonizerLyricsState = {
  main: EMPTY_VOICE_CURSOR,
  other: EMPTY_VOICE_CURSOR,
  gold: EMPTY_VOICE_CURSOR,
  pink: EMPTY_VOICE_CURSOR,
  inUnison: false,
  fallbackNextLine: null,
  fallbackNextLineIndex: -1,
  fallbackNextLineVisible: false,
};

export interface ResolveAutocanonizerLyricsInput {
  lyrics: NormalizedLyrics | null;
  mainTimeSec: number | null;
  otherTimeSec: number | null;
  goldTimeSec?: number | null;
  pinkTimeSec?: number | null;
  offsetSec?: number;
  inUnison?: boolean;
  leadInSec?: number;
}

function resolveVoiceCursor(
  lyrics: NormalizedLyrics,
  timeSec: number | null,
  offsetSec: number,
  leadInSec: number,
): LyricsVoiceCursor {
  if (timeSec === null || !Number.isFinite(timeSec)) {
    return EMPTY_VOICE_CURSOR;
  }
  const adjusted = timeSec + offsetSec;
  const activeLineIndex = findActiveLineIndex(lyrics.lines, adjusted);
  const activeLine =
    activeLineIndex >= 0 ? lyrics.lines[activeLineIndex] : null;
  const { activeSyllableIndex, progress: activeSyllableProgress } = activeLine
    ? resolveSyllableProgress(activeLine, adjusted)
    : { activeSyllableIndex: -1, progress: 0 };

  if (activeLineIndex >= 0) {
    return {
      activeLine,
      activeLineIndex,
      activeSyllableIndex,
      activeSyllableProgress,
      backgroundStates: resolveBackgroundStates(activeLine, adjusted),
      upcomingLine: null,
      upcomingLineIndex: -1,
      upcomingLineVisible: false,
    };
  }

  const upcomingLineIndex = findNextLineIndex(lyrics.lines, adjusted);
  const upcomingLine =
    upcomingLineIndex >= 0 ? lyrics.lines[upcomingLineIndex] : null;
  const upcomingLineVisible = Boolean(
    upcomingLine &&
      upcomingLine.startTime !== null &&
      upcomingLine.startTime - adjusted <= leadInSec,
  );

  return {
    activeLine: null,
    activeLineIndex: -1,
    activeSyllableIndex: -1,
    activeSyllableProgress: 0,
    backgroundStates: [],
    upcomingLine,
    upcomingLineIndex,
    upcomingLineVisible,
  };
}

/**
 * Resolves independent lyric cursors for Autocanonizer's Blue (main), Green
 * (canon/other), and optional Gold / Pink voices, including per-lane in-place
 * upcoming line previews.
 */
export function resolveAutocanonizerLyricsState(
  input: ResolveAutocanonizerLyricsInput,
): AutocanonizerLyricsState {
  const {
    lyrics,
    mainTimeSec,
    otherTimeSec,
    goldTimeSec = null,
    pinkTimeSec = null,
    offsetSec = 0,
    inUnison = false,
    leadInSec = 2.5,
  } = input;

  if (!lyrics || lyrics.type === "static" || lyrics.lines.length === 0) {
    return EMPTY_AUTOCANONIZER_LYRICS_STATE;
  }

  const main = resolveVoiceCursor(lyrics, mainTimeSec, offsetSec, leadInSec);
  const exactUnison = Boolean(inUnison);
  const other = exactUnison
    ? main
    : resolveVoiceCursor(lyrics, otherTimeSec, offsetSec, leadInSec);
  const gold = resolveVoiceCursor(lyrics, goldTimeSec, offsetSec, leadInSec);
  const pink = resolveVoiceCursor(lyrics, pinkTimeSec, offsetSec, leadInSec);

  const primaryCursor =
    mainTimeSec !== null
      ? main
      : otherTimeSec !== null
        ? other
        : goldTimeSec !== null
          ? gold
          : pink;

  // Keep offset voices inside the same lyric line in separate lanes unless the
  // controller reports true beat unison (`inUnison`), so their staggered timing
  // remains visible.
  return {
    main,
    other,
    gold,
    pink,
    inUnison: exactUnison,
    fallbackNextLine: primaryCursor.upcomingLine,
    fallbackNextLineIndex: primaryCursor.upcomingLineIndex,
    fallbackNextLineVisible: primaryCursor.upcomingLineVisible,
  };
}
