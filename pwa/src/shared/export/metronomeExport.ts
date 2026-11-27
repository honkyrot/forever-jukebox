import type { AnalysisOutput } from "@/shared/analysis-schema/schema";
import {
  clampTimeSignatureTrackOffset,
  normalizeAnalysis,
} from "@forever-jukebox/shared";
import {
  BASE_METRONOME_GAIN,
  DEFAULT_METRONOME_BEAT_OFFSET,
  DEFAULT_METRONOME_VOLUME_PCT,
  HI_TICK_GAIN,
  LO_TICK_GAIN,
  clampMetronomeVolumePct,
  createMetronomeTickBuffers,
  detectTrackBeatsPerBar,
  isMetronomeDownbeat,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import type { PlannedJukeboxSegment } from "./plan";
import type { CowbellRenderEvent } from "./render";

export type PlanMetronomeExportEventsOptions = {
  analysis: AnalysisOutput;
  segments: PlannedJukeboxSegment[];
  sampleRate: number;
  volume: number;
  metronomeVolumePct?: number;
  metronomeBeatsPerBar?: number | null;
  metronomeBeatOffset?: number;
};

/**
 * Plans centered hi/lo metronome click render events across all scheduled
 * jukebox export segments using the track's normalized bar structure.
 */
export function planMetronomeExportEvents(
  options: PlanMetronomeExportEventsOptions,
): CowbellRenderEvent[] {
  const decodeContext = createDecodeContext(options.sampleRate);
  const buffers = createMetronomeTickBuffers(decodeContext);
  if (!buffers) {
    return [];
  }

  // Normalize analysis so beats carry parent bar references and indexInParent.
  const normalized = normalizeAnalysis(options.analysis);
  const beatsPerBar = detectTrackBeatsPerBar(
    normalized.beats,
    options.analysis.track?.time_signature,
  );
  const beatsPerBarOverride = options.metronomeBeatsPerBar ?? null;
  const beatOffset = clampTimeSignatureTrackOffset(
    options.metronomeBeatOffset ?? DEFAULT_METRONOME_BEAT_OFFSET,
  );
  const metronomeGainScale =
    clampMetronomeVolumePct(
      options.metronomeVolumePct ?? DEFAULT_METRONOME_VOLUME_PCT,
    ) / 100;
  const volume = clamp01(options.volume);
  const events: CowbellRenderEvent[] = [];

  for (const segment of options.segments) {
    const beat = normalized.beats[segment.beatIndex];
    const downbeat = isMetronomeDownbeat(segment.beatIndex, beat, {
      beatsPerBar,
      beatsPerBarOverride,
      beatOffset,
    });
    const buffer = downbeat ? buffers.hi : buffers.lo;
    const tickGain = downbeat ? HI_TICK_GAIN : LO_TICK_GAIN;
    events.push({
      outputStart: segment.outputStart,
      buffer,
      gain: tickGain * BASE_METRONOME_GAIN * volume * metronomeGainScale,
      pan: 0,
    });
  }

  return events;
}

/**
 * Creates a lightweight 1-frame offline audio context for buffer synthesis.
 */
function createDecodeContext(sampleRate: number): BaseAudioContext {
  const safeRate = Math.max(8000, Math.round(sampleRate));
  try {
    return new OfflineAudioContext({
      numberOfChannels: 1,
      length: 1,
      sampleRate: safeRate,
    });
  } catch {
    return new OfflineAudioContext(1, 1, safeRate);
  }
}

/**
 * Clamps a numeric gain value into [0, 1], defaulting non-finite values to 1.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}
