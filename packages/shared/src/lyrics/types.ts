export type LyricsSyncType = "syllable" | "line" | "static";

export interface LyricsSyllable {
  text: string;
  startTime: number;
  endTime: number;
  isPartOfWord: boolean;
  transliteratedText?: string;
  transliteratedIsPartOfWord?: boolean;
}

export interface LyricsLine {
  index: number;
  text: string;
  transliteratedText?: string;
  startTime: number | null;
  endTime: number | null;
  oppositeAligned?: boolean;
  syllables?: LyricsSyllable[];
  backgroundText?: string;
}

export interface NormalizedLyrics {
  type: LyricsSyncType;
  trackId: string | null;
  title?: string;
  artist?: string;
  startTime: number | null;
  endTime: number | null;
  lines: LyricsLine[];
  songWriters: string[];
  source: string | null;
  hasTransliterations: boolean;
}

export interface KaraokeDisplayState {
  activeLine: LyricsLine | null;
  activeLineIndex: number;
  activeSyllableIndex: number;
  activeSyllableProgress: number;
  nextLine: LyricsLine | null;
  nextLineIndex: number;
  nextLineVisible: boolean;
  isBranchPreview: boolean;
  branchBeatsRemaining: number | null;
}

export interface LyricsVoiceCursor {
  activeLine: LyricsLine | null;
  activeLineIndex: number;
  activeSyllableIndex: number;
  activeSyllableProgress: number;
  upcomingLine: LyricsLine | null;
  upcomingLineIndex: number;
  upcomingLineVisible: boolean;
}

export interface AutocanonizerLyricsState {
  main: LyricsVoiceCursor;
  other: LyricsVoiceCursor;
  inUnison: boolean;
  fallbackNextLine: LyricsLine | null;
  fallbackNextLineIndex: number;
  fallbackNextLineVisible: boolean;
}
