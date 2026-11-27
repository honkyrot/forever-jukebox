import type { CSSProperties, ReactNode } from "react";
import type { LyricsLine } from "@forever-jukebox/shared/lyrics";

interface SyllableWordGroup {
  tokens: Array<{
    index: number;
    text: string;
    pct: number;
  }>;
}

/**
 * Returns the line text in either romanized form (when requested and available)
 * or its original script.
 */
export function getDisplayLineText(line: LyricsLine, romanized = false): string {
  if (romanized && line.transliteratedText) {
    return line.transliteratedText;
  }
  return line.text;
}

/**
 * Groups contiguous `isPartOfWord` syllables into word spans so multi-syllable
 * words never wrap mid-word, while placing inter-word spaces outside the clipped
 * gradient syllable boxes. Uses `transliteratedIsPartOfWord` when `romanized`
 * is true so romanized word boundaries are preserved accurately.
 */
function groupSyllablesIntoWords(
  line: LyricsLine,
  activeSyllableIndex: number,
  activeSyllableProgress: number,
  romanized = false,
): SyllableWordGroup[] {
  const syllables = line.syllables ?? [];
  const words: SyllableWordGroup[] = [];
  let currentWord: SyllableWordGroup = { tokens: [] };

  for (let i = 0; i < syllables.length; i += 1) {
    const syl = syllables[i];
    const isCompleted = i < activeSyllableIndex;
    const isCurrent = i === activeSyllableIndex;
    const pct = isCompleted
      ? 100
      : isCurrent
        ? Math.round(Math.max(0, Math.min(1, activeSyllableProgress)) * 100)
        : 0;

    const rawText = romanized ? (syl.transliteratedText ?? syl.text) : syl.text;
    // Trim trailing whitespace on the token when placing spaces outside.
    const cleanText = rawText.trimEnd();
    currentWord.tokens.push({
      index: i,
      text: cleanText || rawText,
      pct,
    });

    const next = syllables[i + 1];
    const nextText = next
      ? romanized
        ? (next.transliteratedText ?? next.text)
        : next.text
      : "";
    const partOfWord = romanized
      ? (syl.transliteratedIsPartOfWord ?? syl.isPartOfWord)
      : syl.isPartOfWord;
    const endsWord =
      i === syllables.length - 1 ||
      (!partOfWord && !(next && /^\s/.test(nextText)));

    if (endsWord) {
      words.push(currentWord);
      currentWord = { tokens: [] };
    }
  }

  if (currentWord.tokens.length > 0) {
    words.push(currentWord);
  }

  return words;
}

/**
 * Renders syllable-timed lyrics grouped by word with smooth gradient sweep
 * progress (`--syllable-progress`), falling back to plain line text when
 * syllable tokens (or per-syllable transliterations in romanized mode) are absent.
 */
export function renderSyncedLyricsLine(
  line: LyricsLine,
  activeSyllableIndex: number,
  activeSyllableProgress: number,
  romanized = false,
): ReactNode {
  const syllables = line.syllables;
  if (!syllables || syllables.length === 0) {
    return getDisplayLineText(line, romanized);
  }
  if (romanized && !syllables.some((s) => Boolean(s.transliteratedText))) {
    return getDisplayLineText(line, true);
  }

  const words = groupSyllablesIntoWords(
    line,
    activeSyllableIndex,
    activeSyllableProgress,
    romanized,
  );

  return words.map((word, wordIdx) => (
    <span key={wordIdx}>
      <span className="lyrics-word">
        {word.tokens.map((token) => (
          <span
            key={token.index}
            className="lyrics-syllable"
            style={{ "--syllable-progress": `${token.pct}%` } as CSSProperties}
          >
            {token.text}
          </span>
        ))}
      </span>
      {wordIdx < words.length - 1 ? " " : null}
    </span>
  ));
}
