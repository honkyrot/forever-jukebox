import type {
  LyricsLine,
  LyricsSyllable,
  NormalizedLyrics,
} from "./types";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > 0 ? value : null;
}

/**
 * Reconstructs readable line text from syllable tokens using `isPartOfWord`
 * (or `transliteratedIsPartOfWord` when `romanized` is true) to decide whether
 * adjacent tokens belong to the same word.
 */
function joinSyllablesText(
  syllables: readonly LyricsSyllable[],
  romanized = false,
): string {
  let result = "";
  for (let i = 0; i < syllables.length; i += 1) {
    const current = syllables[i];
    const tokenText = romanized
      ? (current.transliteratedText ?? current.text)
      : current.text;
    result += tokenText;
    if (i < syllables.length - 1) {
      const next = syllables[i + 1];
      const nextText = romanized
        ? (next.transliteratedText ?? next.text)
        : next.text;
      // Romanization can split words differently than original script (e.g., Japanese).
      const partOfWord = romanized
        ? (current.transliteratedIsPartOfWord ?? current.isPartOfWord)
        : current.isPartOfWord;
      const hasTrailingSpace = /\s$/.test(tokenText);
      const hasLeadingSpace = /^\s/.test(nextText);
      if (!partOfWord && !hasTrailingSpace && !hasLeadingSpace) {
        result += " ";
      }
    }
  }
  return result.trim();
}

/**
 * Parses a Spicy Lyrics VocalGroup object (`Syllables`, `StartTime`, `EndTime`,
 * and optional `TransliteratedText`).
 */
function parseSyllableGroup(rawGroup: unknown): {
  syllables: LyricsSyllable[];
  text: string;
  transliteratedText?: string;
  startTime: number | null;
  endTime: number | null;
} | null {
  if (!isRecord(rawGroup) || !Array.isArray(rawGroup.Syllables)) {
    return null;
  }
  const syllables: LyricsSyllable[] = [];
  for (const item of rawGroup.Syllables) {
    if (!isRecord(item)) {
      continue;
    }
    const text = asNonEmptyString(item.Text);
    const startTime = asFiniteNumber(item.StartTime);
    const endTime = asFiniteNumber(item.EndTime);
    if (text === null || startTime === null || endTime === null) {
      continue;
    }
    const isPartOfWord = Boolean(item.IsPartOfWord);
    const transliteratedText = asNonEmptyString(item.TransliteratedText);
    syllables.push({
      text,
      startTime,
      endTime: Math.max(startTime, endTime),
      isPartOfWord,
      ...(transliteratedText !== null
        ? {
            transliteratedText,
            transliteratedIsPartOfWord:
              typeof item.TransliteratedIsPartOfWord === "boolean"
                ? item.TransliteratedIsPartOfWord
                : isPartOfWord,
          }
        : {}),
    });
  }
  if (syllables.length === 0) {
    return null;
  }
  const text = joinSyllablesText(syllables);
  if (!text) {
    return null;
  }
  // Prefer per-syllable transliterations when present; fall back to group-level text.
  let transliteratedText: string | undefined;
  if (syllables.some((s) => Boolean(s.transliteratedText))) {
    const joined = joinSyllablesText(syllables, true);
    transliteratedText = joined || undefined;
  } else if (typeof rawGroup.TransliteratedText === "string") {
    const trimmed = rawGroup.TransliteratedText.trim();
    transliteratedText = trimmed || undefined;
  }
  const groupStart = asFiniteNumber(rawGroup.StartTime) ?? syllables[0].startTime;
  const groupEnd =
    asFiniteNumber(rawGroup.EndTime) ??
    syllables[syllables.length - 1].endTime;
  return {
    syllables,
    text,
    ...(transliteratedText ? { transliteratedText } : {}),
    startTime: groupStart,
    endTime: Math.max(groupStart, groupEnd),
  };
}

/**
 * Normalizes a Spicy Lyrics API response (`{ Body: ... }` envelope or unwrapped
 * body) across `Syllable`, `Line`, and `Static` formats.
 */
export function normalizeSpicyLyrics(raw: unknown): NormalizedLyrics | null {
  if (!isRecord(raw)) {
    return null;
  }
  const body = isRecord(raw.Body) ? raw.Body : raw;
  const rawType = typeof body.Type === "string" ? body.Type : null;
  if (rawType !== "Syllable" && rawType !== "Line" && rawType !== "Static") {
    return null;
  }

  const songWriters = Array.isArray(body.SongWriters)
    ? body.SongWriters.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      ).map((entry) => entry.trim())
    : [];

  const trackId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : isRecord(body.ids) && typeof body.ids.spotify === "string" && body.ids.spotify.trim()
        ? body.ids.spotify.trim()
        : null;

  const source =
    typeof body.source === "string" && body.source.trim()
      ? body.source.trim()
      : null;

  const lines: LyricsLine[] = [];

  if (rawType === "Syllable") {
    const content = Array.isArray(body.Content) ? body.Content : [];
    for (const item of content) {
      if (!isRecord(item) || item.Type !== "Vocal") {
        continue;
      }
      const lead = parseSyllableGroup(item.Lead);
      if (!lead) {
        continue;
      }
      let backgroundText: string | undefined;
      if (Array.isArray(item.Background) && item.Background.length > 0) {
        const parts: string[] = [];
        for (const bgItem of item.Background) {
          const parsedBg = parseSyllableGroup(bgItem);
          if (parsedBg?.text) {
            parts.push(parsedBg.text);
          }
        }
        if (parts.length > 0) {
          backgroundText = parts.join(" ");
        }
      }
      lines.push({
        index: 0,
        text: lead.text,
        ...(lead.transliteratedText
          ? { transliteratedText: lead.transliteratedText }
          : {}),
        startTime: lead.startTime,
        endTime: lead.endTime,
        ...(item.OppositeAligned === true ? { oppositeAligned: true } : {}),
        syllables: lead.syllables,
        ...(backgroundText ? { backgroundText } : {}),
      });
    }
  } else if (rawType === "Line") {
    const content = Array.isArray(body.Content) ? body.Content : [];
    for (const item of content) {
      if (!isRecord(item) || item.Type !== "Vocal") {
        continue;
      }
      const rawText = typeof item.Text === "string" ? item.Text.trim() : "";
      const startTime = asFiniteNumber(item.StartTime);
      const endTime = asFiniteNumber(item.EndTime);
      if (!rawText || startTime === null) {
        continue;
      }
      const transliteratedText =
        typeof item.TransliteratedText === "string"
          ? item.TransliteratedText.trim()
          : "";
      lines.push({
        index: 0,
        text: rawText,
        ...(transliteratedText ? { transliteratedText } : {}),
        startTime,
        endTime: endTime !== null ? Math.max(startTime, endTime) : null,
        ...(item.OppositeAligned === true ? { oppositeAligned: true } : {}),
      });
    }
  } else {
    const rawLines = Array.isArray(body.Lines) ? body.Lines : [];
    for (const item of rawLines) {
      if (!isRecord(item)) {
        continue;
      }
      const rawText = typeof item.Text === "string" ? item.Text.trim() : "";
      if (!rawText) {
        continue;
      }
      const transliteratedText =
        typeof item.TransliteratedText === "string"
          ? item.TransliteratedText.trim()
          : "";
      lines.push({
        index: 0,
        text: rawText,
        ...(transliteratedText ? { transliteratedText } : {}),
        startTime: null,
        endTime: null,
      });
    }
  }

  if (rawType !== "Static") {
    lines.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    // Fill missing line end times using the next line's start (or +4s on the tail).
    for (let i = 0; i < lines.length; i += 1) {
      const current = lines[i];
      if (current.startTime !== null && current.endTime === null) {
        const nextStart = lines[i + 1]?.startTime;
        current.endTime =
          nextStart !== null && nextStart !== undefined && nextStart > current.startTime
            ? nextStart
            : current.startTime + 4;
      }
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    lines[i].index = i;
  }

  const hasTransliterations = lines.some(
    (line) =>
      Boolean(line.transliteratedText) ||
      Boolean(line.syllables?.some((s) => Boolean(s.transliteratedText))),
  );

  return {
    type:
      rawType === "Syllable"
        ? "syllable"
        : rawType === "Line"
          ? "line"
          : "static",
    trackId,
    startTime: asFiniteNumber(body.StartTime),
    endTime: asFiniteNumber(body.EndTime),
    lines,
    songWriters,
    source,
    hasTransliterations,
  };
}
