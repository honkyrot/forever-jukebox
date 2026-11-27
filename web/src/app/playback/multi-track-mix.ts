import {
	DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
	DEFAULT_TIME_SIGNATURE_DENOMINATOR,
	DEFAULT_TIME_SIGNATURE_NUMERATOR,
	clampTimeSignatureDenominator,
	clampTimeSignatureNumerator,
	clampTimeSignatureTrackOffset,
	computeTempoSyncRatio,
	mergeTrackAnalyses,
	normalizeTimeSignatureBranchMode,
	type TimeSignatureBranchMode,
	type TrackAnalysis,
} from "@forever-jukebox/shared";
import {
	combineAudioBuffers,
	prepareDualAudioBuffers,
} from "@forever-jukebox/shared/audio/multiTrackBuffer";
import {
	clampMetronomeVolumePct,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import type {
	AutocanonizerMixAlignmentMode,
	AutocanonizerQuadBranchMode,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerController";
import { detectTrackBeatsPerBar } from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import {
	isAnalysisComplete,
	isAnalysisFailed,
	isAnalysisInProgress,
} from "../analysisStatus";
import {
	fetchAnalysis,
	fetchAudio,
	fetchJobBySource,
	startYoutubeAnalysis,
	type AnalysisComplete,
	type AnalysisResponse,
} from "../api";
import { readCachedTrack, updateCachedTrack } from "../cache";
import { ANALYSIS_POLL_INTERVAL_MS } from "../constants";
import type { AppContext } from "../context";
import { formatErrorForDisplay } from "../errorDisplay";
import i18n from "../i18n";
import { isLikelyJobId } from "../identity";
import { TRACK_STEP } from "../job-progress";
import type { PlaylistTrack } from "../playlist";
import {
	normalizeBpmBarTimeSignatureMode,
	resolveEffectiveMetronomeConfig,
	resolveStoredBpmBarBeatOffsetForTrack,
	storeBpmBarBeatOffsetForTrack,
	storeBpmBarDenominator,
	storeBpmBarNumerator,
	storeBpmBarTimeSignatureMode,
	storeTimeSignatureSimilarityRestrictForTrack,
	type BpmBarTimeSignatureInput,
	type BpmBarTimeSignatureMode,
} from "../bpmBarTimeSignature";
import { resolveTrackBaseTempoBpm } from "../liveBpm";
import { getPlaybackDeps } from "../runtime";
import { getCurrentTrackId, useAppStore } from "../store";
import {
	PENDING_STEP,
	setAnalysisStatus,
	setLoadingStep,
	showToast,
} from "../ui";
import {
	bumpLoadGeneration,
	getLoadGeneration,
	isStaleLoad,
} from "./load-generation";
import {
	resetLiveBpm,
	updateTrackInfo,
	updateVizVisibility,
} from "./status-ui";
import { delay, loadTrackById, loadTrackByJobId } from "./track-load";
import { startAutocanonizerPlayback, stopPlayback } from "./transport";
import { syncPredictedJumps } from "./branch-lookahead";

const MAX_MIX_TRACKS = 128;
export const MAX_AUTOCANONIZER_MIX_TRACKS = 2;

export const MIN_MIX_TRACK_GAIN_PCT = 0;
export const MAX_MIX_TRACK_GAIN_PCT = 200;
export const DEFAULT_MIX_TRACK_GAIN_PCT = 100;

/**
 * Clamps a per-track volume percentage to [0, 200], defaulting non-finite
 * values to 100%.
 */
function clampMixTrackGainPct(gainPct: number): number {
	if (!Number.isFinite(gainPct)) {
		return DEFAULT_MIX_TRACK_GAIN_PCT;
	}
	return Math.max(
		MIN_MIX_TRACK_GAIN_PCT,
		Math.min(MAX_MIX_TRACK_GAIN_PCT, Math.round(gainPct)),
	);
}

export type LoadedMixTrackSource = {
	jobId: string;
	track: PlaylistTrack;
	analysisResult: AnalysisComplete["result"];
	buffer: AudioBuffer;
	tempo?: number;
};

let cachedMixSources: LoadedMixTrackSource[] | null = null;
let cachedAutocanonizerMixSources:
	| [LoadedMixTrackSource, LoadedMixTrackSource]
	| null = null;

export function clearCachedMultiTrackSources(): void {
	cachedMixSources = null;
	cachedAutocanonizerMixSources = null;
}

export function getCachedMixSources(): LoadedMixTrackSource[] | null {
	return cachedMixSources;
}

export function getCachedAutocanonizerMixSources():
	| [LoadedMixTrackSource, LoadedMixTrackSource]
	| null {
	return cachedAutocanonizerMixSources;
}

export async function resolveTrackAnalysis(
	track: PlaylistTrack,
	generation: number,
): Promise<AnalysisComplete> {
	let response: AnalysisResponse | null = null;
	if (track.sourceType === "upload" || isLikelyJobId(track.id)) {
		response = await fetchAnalysis(track.id);
	} else {
		response = await fetchJobBySource(track.sourceType, track.id);
		if (!response && track.sourceType === "youtube") {
			response = await startYoutubeAnalysis({
				youtube_id: track.id,
				title: track.title,
				artist: track.artist,
			});
		}
	}

	while (response && isAnalysisInProgress(response)) {
		if (isStaleLoad(generation)) {
			throw new Error("Load cancelled");
		}
		await delay(ANALYSIS_POLL_INTERVAL_MS);
		if (isStaleLoad(generation)) {
			throw new Error("Load cancelled");
		}
		response = await fetchAnalysis(response.id);
	}

	if (!response) {
		throw new Error(
			`Track analysis unavailable for ${track.title || track.id}`,
		);
	}
	if (isAnalysisFailed(response)) {
		throw new Error(
			formatErrorForDisplay(response.error, {
				sourceProvider: response.source_provider,
				errorCode: response.error_code,
				fallback: i18n.t("status.loadingFailed"),
			}),
		);
	}
	if (!isAnalysisComplete(response)) {
		throw new Error(`Track analysis incomplete for ${track.title || track.id}`);
	}
	return response;
}

export async function resolveTrackAudioBuffer(
	context: AppContext,
	track: PlaylistTrack,
	jobId: string,
): Promise<AudioBuffer> {
	const cacheCandidates = [jobId, track.id];
	let audioBytes: ArrayBuffer | null = null;
	for (const cacheKey of cacheCandidates) {
		try {
			const cached = await readCachedTrack(cacheKey);
			if (cached?.audio) {
				audioBytes = cached.audio;
				break;
			}
		} catch {
			// Ignore cache lookup errors and fall back to network fetch.
		}
	}
	if (!audioBytes) {
		audioBytes = await fetchAudio(jobId);
		updateCachedTrack(jobId, { audio: audioBytes, jobId }).catch((err) => {
			console.warn(`Cache save failed: ${String(err)}`);
		});
	}
	return context.player.getContext().decodeAudioData(audioBytes.slice(0));
}

function applyLoadedMixSources(
	context: AppContext,
	sources: LoadedMixTrackSource[],
): void {
	const {
		crossTrackOnly,
		coverSyncEnabled,
		timeSignatureBranchingEnabled,
		timeSignatureBranchMode,
		timeSignatureNumerator,
		timeSignatureDenominator,
		timeSignatureTrackOffsets,
		timeSignatureSimilarityRestrictEnabled,
		timeSignatureSimilarityNumerator,
		timeSignatureSimilarityDenominator,
		tempoSyncEnabled,
		normalizeVolumeEnabled,
		postMixNormalizeVolumeEnabled,
		mixTrackGainsPct,
	} = useAppStore.getState();
	const masterTempo = sources[0]?.tempo;

	const tempoRatios = sources.map((source, index) =>
		index === 0
			? 1
			: computeTempoSyncRatio(masterTempo, source.tempo, tempoSyncEnabled),
	);
	const resolvedGainsPct = sources.map((_, index) =>
		clampMixTrackGainPct(mixTrackGainsPct[index] ?? DEFAULT_MIX_TRACK_GAIN_PCT),
	);
	const resolvedTrackOffsets = sources.map((_, index) =>
		clampTimeSignatureTrackOffset(timeSignatureTrackOffsets[index] ?? 0),
	);

	const combined = combineAudioBuffers(
		context.player.getContext(),
		sources.map((source, index) => ({
			buffer: source.buffer,
			tempoRatio: tempoRatios[index],
		})),
		{ normalizeVolume: normalizeVolumeEnabled },
	);

	const mergedAnalysis: TrackAnalysis = mergeTrackAnalyses(
		sources.map((source, index) => ({
			analysis: source.analysisResult,
			durationSec: combined.sliceDurations[index],
			title: source.track.title,
			artist: source.track.artist,
			tempoRatio: tempoRatios[index],
		})),
		{
			tempoSync: tempoSyncEnabled,
			normalizeLoudness: normalizeVolumeEnabled,
		},
	);

	context.player.loadBuffer(combined.buffer);
	context.player.setPostMixTrackSlices?.(
		combined.sliceDurations,
		resolvedGainsPct.map((pct) => pct / 100),
	);
	context.player.setPostMixNormalization?.(postMixNormalizeVolumeEnabled);
	context.engine.updateConfig({
		crossTrackOnly,
		coverSync: coverSyncEnabled,
		timeSignatureBranching: timeSignatureBranchingEnabled,
		timeSignatureBranchMode,
		timeSignatureNumerator,
		timeSignatureDenominator,
		timeSignatureTrackOffsets: resolvedTrackOffsets,
		timeSignatureSimilarityRestrict: timeSignatureSimilarityRestrictEnabled,
		timeSignatureSimilarityNumerator,
		timeSignatureSimilarityDenominator,
	});
	context.engine.loadAnalysis(mergedAnalysis);

	const vizData = context.engine.getVisualizationData();
	const detectedBeatsPerBar = detectTrackBeatsPerBar(
		vizData?.beats,
		mergedAnalysis.track?.time_signature,
	);
	context.metronomeOverlay.setBeatsPerBar(detectedBeatsPerBar);
	useAppStore.setState({
		vizData,
		selectedEdge: null,
		branchStats: null,
		multiTrackEnabled: true,
		mixTrackGainsPct: resolvedGainsPct,
		timeSignatureTrackOffsets: resolvedTrackOffsets,
		metronomeDetectedBeatsPerBar: detectedBeatsPerBar,
		audioLoaded: true,
		analysisLoaded: true,
		audioLoadInFlight: false,
		loadingStep: null,
		trackTitle: sources
			.map((s) => s.track.title || i18n.t("common.untitled"))
			.join(" × "),
		trackArtist: "",
		jukeboxCurrentSeconds: 0,
		trackDurationSec:
			mergedAnalysis.tracks?.[0]?.duration ??
			mergedAnalysis.track?.duration ??
			combined.buffer.duration,
	});

	if (vizData) {
		context.jukebox?.setData(vizData);
	}
	const baseTempo = resolveTrackBaseTempoBpm(
		mergedAnalysis.tracks?.[0]?.tempo ?? mergedAnalysis.track?.tempo,
		vizData?.beats,
	);
	resetLiveBpm(baseTempo);
	context.jukebox?.setSelectedEdge(null);
	syncPredictedJumps(context);
	syncMetronomeOverlayFromStore(context);
	updateVizVisibility();
	updateTrackInfo(context);
}

/**
 * Loads up to 4 tracks from the active playlist, combines their audio buffers
 * (with optional tempo sync), and starts a multi-track cross-branching session.
 */
export async function loadMultiTrackMix(context: AppContext): Promise<boolean> {
	const { playlist, playMode } = useAppStore.getState();
	if (playMode !== "jukebox" || playlist.tracks.length < 2) {
		return false;
	}

	const tracks = playlist.tracks.slice(0, MAX_MIX_TRACKS);
	stopPlayback(context);
	bumpLoadGeneration();
	const generation = getLoadGeneration();

	useAppStore.setState({
		audioLoaded: false,
		analysisLoaded: false,
		audioModePreparing: false,
		selectedEdge: null,
		branchStats: null,
		multiTrackEnabled: true,
	});
	setLoadingStep(context, PENDING_STEP);

	try {
		const sources: LoadedMixTrackSource[] = [];
		for (const track of tracks) {
			if (isStaleLoad(generation)) {
				return false;
			}
			setLoadingStep(context, TRACK_STEP);
			const complete = await resolveTrackAnalysis(track, generation);
			if (isStaleLoad(generation)) {
				return false;
			}
			const buffer = await resolveTrackAudioBuffer(context, track, complete.id);
			if (isStaleLoad(generation)) {
				return false;
			}
			const rawTrackMeta = complete.result.track ?? complete.track;
			const tempo =
				typeof rawTrackMeta?.tempo === "number" &&
				Number.isFinite(rawTrackMeta.tempo)
					? rawTrackMeta.tempo
					: undefined;
			sources.push({
				jobId: complete.id,
				track: {
					...track,
					title:
						typeof rawTrackMeta?.title === "string" && rawTrackMeta.title.trim()
							? rawTrackMeta.title
							: track.title,
					artist:
						typeof rawTrackMeta?.artist === "string"
							? rawTrackMeta.artist
							: track.artist,
				},
				analysisResult: complete.result,
				buffer,
				tempo,
			});
		}

		if (isStaleLoad(generation)) {
			return false;
		}

		const restoredOffsets = sources.map((source) =>
			resolveStoredBpmBarBeatOffsetForTrack(source.jobId || source.track.id),
		);
		useAppStore.setState({
			timeSignatureTrackOffsets: restoredOffsets,
			bpmBarBeatOffset: restoredOffsets[0] ?? 0,
		});
		cachedMixSources = sources;
		applyLoadedMixSources(context, sources);
		return true;
	} catch (err) {
		if (!isStaleLoad(generation)) {
			cachedMixSources = null;
			useAppStore.setState({ multiTrackEnabled: false });
			const message = formatErrorForDisplay(err, {
				fallback: i18n.t("status.loadingFailed"),
			});
			setAnalysisStatus(context, () => message);
			showToast(message, { tone: "error" });
		}
		return false;
	}
}

/**
 * Exits multi-track mix mode and restores single-track playback for the active
 * playlist item.
 */
export async function disableMultiTrackMix(
	context: AppContext,
): Promise<boolean> {
	cachedMixSources = null;
	stopPlayback(context);
	useAppStore.setState({ multiTrackEnabled: false });
	context.player.clearPostMixTrackGains?.();
	context.player.setPostMixNormalization?.(false);
	context.engine.updateConfig({
		crossTrackOnly: false,
		crossTrackThreshold: 0,
		coverSync: false,
		timeSignatureBranching: false,
		timeSignatureBranchMode: DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
		timeSignatureNumerator: DEFAULT_TIME_SIGNATURE_NUMERATOR,
		timeSignatureDenominator: DEFAULT_TIME_SIGNATURE_DENOMINATOR,
		timeSignatureTrackOffsets: [],
		timeSignatureSimilarityRestrict: false,
		timeSignatureSimilarityNumerator: DEFAULT_TIME_SIGNATURE_NUMERATOR,
		timeSignatureSimilarityDenominator: DEFAULT_TIME_SIGNATURE_DENOMINATOR,
	});

	const { playlist } = useAppStore.getState();
	const activeTrack =
		playlist.tracks[playlist.currentIndex] ?? playlist.tracks[0];
	const deps = getPlaybackDeps();
	if (!activeTrack || !deps) {
		return false;
	}

	if (activeTrack.sourceType === "upload" || isLikelyJobId(activeTrack.id)) {
		return loadTrackByJobId(context, deps, activeTrack.id, {
			playlistLoad: true,
			selectedTrack: activeTrack,
		});
	}
	const trackId =
		activeTrack.sourceType === "youtube"
			? activeTrack.id
			: `${activeTrack.sourceType}:${activeTrack.id}`;
	return loadTrackById(context, deps, trackId, {
		playlistLoad: true,
		selectedTrack: activeTrack,
	});
}

/**
 * Rebuilds the active multi-track jump graph and pushes updated visualization
 * and track-info state without reloading audio buffers.
 */
function rebuildMixGraphAndSyncViz(context: AppContext): void {
	if (!context.engine) {
		return;
	}
	context.engine.rebuildGraph();
	const vizData = context.engine.getVisualizationData();
	useAppStore.setState({ vizData, selectedEdge: null, branchStats: null });
	if (vizData) {
		context.jukebox?.setData(vizData);
	}
	context.jukebox?.setSelectedEdge(null);
	syncPredictedJumps(context);
	updateTrackInfo(context);
}

/**
 * Updates whether branches are restricted to cross-song jumps in multi-track mode.
 */
export function setCrossTrackOnly(context: AppContext, enabled: boolean): void {
	useAppStore.setState({ crossTrackOnly: enabled });
	if (!useAppStore.getState().multiTrackEnabled) {
		return;
	}
	context.engine.updateConfig({ crossTrackOnly: enabled });
	rebuildMixGraphAndSyncViz(context);
}

/**
 * Updates whether cross-song branches in multi-track mixes align parallel song
 * sections via chroma/dynamics DTW instead of unconstrained beat similarity.
 */
export function setCoverSyncEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	useAppStore.setState({ coverSyncEnabled: enabled });
	if (!useAppStore.getState().multiTrackEnabled) {
		return;
	}
	context.engine.updateConfig({ coverSync: enabled });
	rebuildMixGraphAndSyncViz(context);
}

/**
 * Updates whether time-signature boundary branching overwrites similarity-based
 * branches in multi-track mixes and rebuilds the active jump graph live.
 */
export function setTimeSignatureBranchingEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	const state = useAppStore.getState();
	// Automatically switch overwrite -> combine when similarity restriction is
	// already enabled so auto-created bar links layer onto the restricted grid.
	const nextMode: TimeSignatureBranchMode =
		enabled &&
		state.timeSignatureSimilarityRestrictEnabled &&
		state.timeSignatureBranchMode === "overwrite"
			? "combine"
			: state.timeSignatureBranchMode;
	useAppStore.setState({
		timeSignatureBranchingEnabled: enabled,
		timeSignatureBranchMode: nextMode,
	});
	const {
		multiTrackEnabled,
		timeSignatureNumerator,
		timeSignatureDenominator,
		timeSignatureTrackOffsets,
	} = useAppStore.getState();
	if (!multiTrackEnabled) {
		syncMetronomeOverlayFromStore(context);
		return;
	}
	context.engine?.updateConfig({
		timeSignatureBranching: enabled,
		timeSignatureBranchMode: nextMode,
		timeSignatureNumerator,
		timeSignatureDenominator,
		timeSignatureTrackOffsets,
	});
	rebuildMixGraphAndSyncViz(context);
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates whether similarity branches are restricted to time-signature bar
 * boundaries, synchronizing beat offsets and single-track signature with the BPM bar.
 */
export function setTimeSignatureSimilarityRestrictEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	const state = useAppStore.getState();
	const nextMode: TimeSignatureBranchMode =
		enabled &&
		state.timeSignatureBranchingEnabled &&
		state.timeSignatureBranchMode === "overwrite"
			? "combine"
			: state.timeSignatureBranchMode;
	const clampedBpmOffset = clampTimeSignatureTrackOffset(state.bpmBarBeatOffset);
	let nextOffsets = state.timeSignatureTrackOffsets;
	let nextNum = state.timeSignatureSimilarityNumerator;
	let nextDen = state.timeSignatureSimilarityDenominator;

	if (enabled) {
		// Sync track 0 offset from the BPM bar per-song offset instead of leaving it at 0.
		if (!state.multiTrackEnabled) {
			nextOffsets = clampedBpmOffset !== 0 ? [clampedBpmOffset] : [];
			if (state.bpmBarTimeSignatureMode === "custom") {
				nextNum = clampTimeSignatureNumerator(state.bpmBarNumerator);
				nextDen = clampTimeSignatureDenominator(state.bpmBarDenominator);
			} else {
				storeBpmBarNumerator(nextNum);
				storeBpmBarDenominator(nextDen);
			}
		} else if (
			state.timeSignatureTrackOffsets.length === 0 &&
			clampedBpmOffset !== 0
		) {
			nextOffsets = [clampedBpmOffset];
		}
	}

	useAppStore.setState({
		timeSignatureSimilarityRestrictEnabled: enabled,
		timeSignatureBranchMode: nextMode,
		timeSignatureTrackOffsets: nextOffsets,
		timeSignatureSimilarityNumerator: nextNum,
		timeSignatureSimilarityDenominator: nextDen,
		...(!state.multiTrackEnabled && enabled
			? {
					bpmBarNumerator: nextNum,
					bpmBarDenominator: nextDen,
				}
			: {}),
	});

	if (!state.multiTrackEnabled) {
		storeTimeSignatureSimilarityRestrictForTrack(
			getCurrentTrackId(),
			enabled ? { numerator: nextNum, denominator: nextDen } : null,
		);
	}

	if (context.engine) {
		context.engine.updateConfig({
			timeSignatureSimilarityRestrict: enabled,
			timeSignatureSimilarityNumerator: nextNum,
			timeSignatureSimilarityDenominator: nextDen,
			timeSignatureTrackOffsets: nextOffsets,
			...(state.multiTrackEnabled && state.timeSignatureBranchingEnabled
				? { timeSignatureBranchMode: nextMode }
				: {}),
		});
		rebuildMixGraphAndSyncViz(context);
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the time signature numerator for similarity bar-boundary restriction
 * and rebuilds the jump graph live when active.
 */
export function setTimeSignatureSimilarityNumerator(
	context: AppContext,
	numerator: number,
): void {
	const clamped = clampTimeSignatureNumerator(numerator);
	const state = useAppStore.getState();
	if (!state.multiTrackEnabled) {
		storeBpmBarNumerator(clamped);
		if (state.timeSignatureSimilarityRestrictEnabled) {
			storeTimeSignatureSimilarityRestrictForTrack(getCurrentTrackId(), {
				numerator: clamped,
				denominator: state.timeSignatureSimilarityDenominator,
			});
		}
	}
	useAppStore.setState({
		timeSignatureSimilarityNumerator: clamped,
		...(!state.multiTrackEnabled ? { bpmBarNumerator: clamped } : {}),
	});
	const {
		multiTrackEnabled,
		timeSignatureSimilarityRestrictEnabled,
		timeSignatureBranchingEnabled,
		timeSignatureBranchMode,
	} = useAppStore.getState();
	if (context.engine) {
		context.engine.updateConfig({ timeSignatureSimilarityNumerator: clamped });
		const isOverwrite =
			multiTrackEnabled &&
			timeSignatureBranchingEnabled &&
			timeSignatureBranchMode === "overwrite";
		if (timeSignatureSimilarityRestrictEnabled && !isOverwrite) {
			rebuildMixGraphAndSyncViz(context);
		}
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the time signature denominator for similarity bar-boundary
 * restriction and rebuilds the jump graph live when active.
 */
export function setTimeSignatureSimilarityDenominator(
	context: AppContext,
	denominator: number,
): void {
	const clamped = clampTimeSignatureDenominator(denominator);
	const state = useAppStore.getState();
	if (!state.multiTrackEnabled) {
		storeBpmBarDenominator(clamped);
		if (state.timeSignatureSimilarityRestrictEnabled) {
			storeTimeSignatureSimilarityRestrictForTrack(getCurrentTrackId(), {
				numerator: state.timeSignatureSimilarityNumerator,
				denominator: clamped,
			});
		}
	}
	useAppStore.setState({
		timeSignatureSimilarityDenominator: clamped,
		...(!state.multiTrackEnabled ? { bpmBarDenominator: clamped } : {}),
	});
	const {
		multiTrackEnabled,
		timeSignatureSimilarityRestrictEnabled,
		timeSignatureBranchingEnabled,
		timeSignatureBranchMode,
	} = useAppStore.getState();
	if (context.engine) {
		context.engine.updateConfig({ timeSignatureSimilarityDenominator: clamped });
		const isOverwrite =
			multiTrackEnabled &&
			timeSignatureBranchingEnabled &&
			timeSignatureBranchMode === "overwrite";
		if (timeSignatureSimilarityRestrictEnabled && !isOverwrite) {
			rebuildMixGraphAndSyncViz(context);
		}
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates whether time-signature bar branches overwrite or combine with
 * similarity branches in multi-track mixes, rebuilding the graph when active.
 */
export function setTimeSignatureBranchMode(
	context: AppContext,
	mode: TimeSignatureBranchMode,
): void {
	const normalized = normalizeTimeSignatureBranchMode(mode);
	useAppStore.setState({ timeSignatureBranchMode: normalized });
	const { multiTrackEnabled, timeSignatureBranchingEnabled } =
		useAppStore.getState();
	if (!multiTrackEnabled) {
		syncMetronomeOverlayFromStore(context);
		return;
	}
	context.engine?.updateConfig({ timeSignatureBranchMode: normalized });
	if (timeSignatureBranchingEnabled) {
		rebuildMixGraphAndSyncViz(context);
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the time signature numerator for multi-track boundary branching and
 * rebuilds the jump graph live when time-signature branching is active.
 */
export function setTimeSignatureNumerator(
	context: AppContext,
	numerator: number,
): void {
	const clamped = clampTimeSignatureNumerator(numerator);
	useAppStore.setState({ timeSignatureNumerator: clamped });
	const { multiTrackEnabled, timeSignatureBranchingEnabled } =
		useAppStore.getState();
	if (!multiTrackEnabled) {
		syncMetronomeOverlayFromStore(context);
		return;
	}
	context.engine?.updateConfig({ timeSignatureNumerator: clamped });
	if (timeSignatureBranchingEnabled) {
		rebuildMixGraphAndSyncViz(context);
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the time signature denominator for multi-track boundary branching and
 * rebuilds the jump graph live when time-signature branching is active.
 */
export function setTimeSignatureDenominator(
	context: AppContext,
	denominator: number,
): void {
	const clamped = clampTimeSignatureDenominator(denominator);
	useAppStore.setState({ timeSignatureDenominator: clamped });
	const { multiTrackEnabled, timeSignatureBranchingEnabled } =
		useAppStore.getState();
	if (!multiTrackEnabled) {
		syncMetronomeOverlayFromStore(context);
		return;
	}
	context.engine?.updateConfig({ timeSignatureDenominator: clamped });
	if (timeSignatureBranchingEnabled) {
		rebuildMixGraphAndSyncViz(context);
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates a single track's integer beat offset for time-signature branching,
 * similarity restriction, and the BPM bar / metronome, rebuilding live when active.
 */
export function setTimeSignatureTrackOffset(
	context: AppContext,
	trackIndex: number,
	offset: number,
): void {
	if (!Number.isInteger(trackIndex) || trackIndex < 0) {
		return;
	}
	const clamped = clampTimeSignatureTrackOffset(offset);
	const state = useAppStore.getState();
	const current = state.timeSignatureTrackOffsets;
	const targetLength = Math.max(
		trackIndex + 1,
		current.length,
		state.vizData?.tracks?.length ?? 0,
	);
	const next = current.slice();
	while (next.length < targetLength) {
		next.push(0);
	}
	next[trackIndex] = clamped;
	if (state.multiTrackEnabled) {
		const mixTrackId =
			cachedMixSources?.[trackIndex]?.jobId ??
			cachedMixSources?.[trackIndex]?.track.id ??
			state.playlist.tracks[trackIndex]?.id ??
			null;
		storeBpmBarBeatOffsetForTrack(mixTrackId, clamped);
		useAppStore.setState({
			timeSignatureTrackOffsets: next,
			...(trackIndex === 0 ? { bpmBarBeatOffset: clamped } : {}),
		});
	} else {
		if (trackIndex === 0) {
			storeBpmBarBeatOffsetForTrack(getCurrentTrackId(), clamped);
		}
		useAppStore.setState({
			timeSignatureTrackOffsets: next,
			...(trackIndex === 0 ? { bpmBarBeatOffset: clamped } : {}),
		});
	}
	if (context.engine) {
		context.engine.updateConfig({ timeSignatureTrackOffsets: next });
		if (
			state.timeSignatureSimilarityRestrictEnabled ||
			(state.multiTrackEnabled && state.timeSignatureBranchingEnabled)
		) {
			rebuildMixGraphAndSyncViz(context);
		}
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Builds the unified BPM bar / metronome time-signature input from store state.
 */
export function buildBpmBarTimeSignatureInputFromStore(): BpmBarTimeSignatureInput {
	const state = useAppStore.getState();
	return {
		bpmBarTimeSignatureMode: state.bpmBarTimeSignatureMode,
		bpmBarNumerator: state.bpmBarNumerator,
		bpmBarDenominator: state.bpmBarDenominator,
		bpmBarBeatOffset: state.bpmBarBeatOffset,
		multiTrackEnabled: state.multiTrackEnabled,
		coverSyncEnabled: state.coverSyncEnabled,
		timeSignatureBranchingEnabled: state.timeSignatureBranchingEnabled,
		timeSignatureBranchMode: state.timeSignatureBranchMode,
		timeSignatureNumerator: state.timeSignatureNumerator,
		timeSignatureDenominator: state.timeSignatureDenominator,
		timeSignatureTrackOffsets: state.timeSignatureTrackOffsets,
		timeSignatureSimilarityRestrictEnabled:
			state.timeSignatureSimilarityRestrictEnabled,
		timeSignatureSimilarityNumerator: state.timeSignatureSimilarityNumerator,
		timeSignatureSimilarityDenominator:
			state.timeSignatureSimilarityDenominator,
		metronomeEnabled: state.metronomeEnabled,
		metronomeDetectedBeatsPerBar: state.metronomeDetectedBeatsPerBar,
	};
}

/**
 * Synchronizes the live metronome overlay service with the BPM bar's
 * enablement, volume, time signature, and per-song beat offset.
 */
export function syncMetronomeOverlayFromStore(context: AppContext): void {
	const overlay = context?.metronomeOverlay;
	if (!overlay) {
		return;
	}
	const { bpmBarEnabled, metronomeEnabled, metronomeVolumePct } =
		useAppStore.getState();
	const effective = resolveEffectiveMetronomeConfig(
		buildBpmBarTimeSignatureInputFromStore(),
	);
	overlay.setMetronomeVolumePct?.(metronomeVolumePct);
	overlay.setBeatsPerBarOverride?.(effective.beatsPerBarOverride);
	overlay.setBeatOffset?.(effective.beatOffset);
	if (bpmBarEnabled && metronomeEnabled) {
		overlay.enable?.();
	} else {
		overlay.disable?.();
	}
}

/**
 * Toggles the BPM bar and automatically disables the metronome when the BPM
 * bar is turned off.
 */
export function setBpmBarEnabled(context: AppContext, enabled: boolean): void {
	if (typeof localStorage !== "undefined") {
		localStorage.setItem("bpmBarEnabled", String(enabled));
	}
	useAppStore.setState({
		bpmBarEnabled: enabled,
		...(!enabled ? { metronomeEnabled: false } : {}),
	});
	syncMetronomeOverlayFromStore(context);
}

/**
 * Toggles the metronome inside the BPM bar panel; only enabled when the BPM
 * bar itself is active, switching "off" bar time signature mode to "auto".
 */
export function setBpmBarMetronomeEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	const state = useAppStore.getState();
	const nextEnabled = state.bpmBarEnabled && enabled;
	if (nextEnabled && state.bpmBarTimeSignatureMode === "off") {
		storeBpmBarTimeSignatureMode("auto");
		useAppStore.setState({
			metronomeEnabled: true,
			bpmBarTimeSignatureMode: "auto",
		});
	} else {
		useAppStore.setState({ metronomeEnabled: nextEnabled });
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the metronome volume percentage (0% to 200%) and syncs the overlay.
 */
export function setBpmBarMetronomeVolumePct(
	context: AppContext,
	volumePct: number,
): void {
	const clamped = clampMetronomeVolumePct(volumePct);
	useAppStore.setState({ metronomeVolumePct: clamped });
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the BPM bar time signature mode ("auto", "off", or "custom") and
 * keeps the metronome overlay synchronized.
 */
export function setBpmBarTimeSignatureMode(
	context: AppContext,
	mode: BpmBarTimeSignatureMode,
): void {
	const normalized = normalizeBpmBarTimeSignatureMode(mode);
	storeBpmBarTimeSignatureMode(normalized);
	useAppStore.setState({ bpmBarTimeSignatureMode: normalized });
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the BPM bar numerator and keeps single-track similarity restriction
 * and the metronome overlay synchronized.
 */
export function setBpmBarNumerator(
	context: AppContext,
	numerator: number,
): void {
	const clamped = clampTimeSignatureNumerator(numerator);
	storeBpmBarNumerator(clamped);
	const state = useAppStore.getState();
	if (!state.multiTrackEnabled) {
		if (state.timeSignatureSimilarityRestrictEnabled) {
			storeTimeSignatureSimilarityRestrictForTrack(getCurrentTrackId(), {
				numerator: clamped,
				denominator: state.timeSignatureSimilarityDenominator,
			});
		}
		useAppStore.setState({
			bpmBarNumerator: clamped,
			timeSignatureSimilarityNumerator: clamped,
		});
		if (context.engine) {
			context.engine.updateConfig({
				timeSignatureSimilarityNumerator: clamped,
			});
			if (state.timeSignatureSimilarityRestrictEnabled) {
				rebuildMixGraphAndSyncViz(context);
			}
		}
	} else {
		useAppStore.setState({ bpmBarNumerator: clamped });
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the BPM bar denominator and keeps single-track similarity restriction
 * and the metronome overlay synchronized.
 */
export function setBpmBarDenominator(
	context: AppContext,
	denominator: number,
): void {
	const clamped = clampTimeSignatureDenominator(denominator);
	storeBpmBarDenominator(clamped);
	const state = useAppStore.getState();
	if (!state.multiTrackEnabled) {
		if (state.timeSignatureSimilarityRestrictEnabled) {
			storeTimeSignatureSimilarityRestrictForTrack(getCurrentTrackId(), {
				numerator: state.timeSignatureSimilarityNumerator,
				denominator: clamped,
			});
		}
		useAppStore.setState({
			bpmBarDenominator: clamped,
			timeSignatureSimilarityDenominator: clamped,
		});
		if (context.engine) {
			context.engine.updateConfig({
				timeSignatureSimilarityDenominator: clamped,
			});
			if (state.timeSignatureSimilarityRestrictEnabled) {
				rebuildMixGraphAndSyncViz(context);
			}
		}
	} else {
		useAppStore.setState({ bpmBarDenominator: clamped });
	}
	syncMetronomeOverlayFromStore(context);
}

/**
 * Updates the per-song beat offset from the BPM bar controls and propagates it
 * to track 0's time-signature offset, graph, and metronome overlay.
 */
export function setBpmBarBeatOffset(
	context: AppContext,
	offset: number,
): void {
	setTimeSignatureTrackOffset(context, 0, offset);
}

function reapplyMixFromCacheOrReload(context: AppContext): void {
	if (!useAppStore.getState().multiTrackEnabled) {
		return;
	}
	if (cachedMixSources && cachedMixSources.length >= 2) {
		stopPlayback(context);
		applyLoadedMixSources(context, cachedMixSources);
		return;
	}
	void loadMultiTrackMix(context);
}

/**
 * Updates whether secondary songs in a multi-track mix are time-scaled to the
 * master song's BPM, re-applying the mix immediately when cached sources exist.
 */
export function setTempoSyncEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	useAppStore.setState({ tempoSyncEnabled: enabled });
	reapplyMixFromCacheOrReload(context);
}

/**
 * Toggles automatic RMS audio normalization and analysis loudness alignment for
 * multi-track mixes, re-rendering immediately when a mix is active.
 */
export function setNormalizeVolumeEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	useAppStore.setState({ normalizeVolumeEnabled: enabled });
	reapplyMixFromCacheOrReload(context);
}

/**
 * Toggles live post-mix output leveling on the audio player without stopping
 * playback, reloading buffers, or modifying branch analysis.
 */
export function setPostMixNormalizeVolumeEnabled(
	context: AppContext,
	enabled: boolean,
): void {
	useAppStore.setState({ postMixNormalizeVolumeEnabled: enabled });
	if (!useAppStore.getState().multiTrackEnabled) {
		return;
	}
	context.player.setPostMixNormalization?.(enabled);
}

/**
 * Sets an individual track's live post-mix volume trim percentage (0–200%)
 * without stopping playback, re-rendering audio buffers, or recomputing branches.
 */
export function setMixTrackGainPct(
	context: AppContext,
	trackIndex: number,
	gainPct: number,
): void {
	if (!Number.isInteger(trackIndex) || trackIndex < 0) {
		return;
	}
	const clamped = clampMixTrackGainPct(gainPct);
	const state = useAppStore.getState();
	const current = state.mixTrackGainsPct;
	const targetLength = Math.max(
		trackIndex + 1,
		current.length,
		state.vizData?.tracks?.length ?? 0,
	);
	const next = current.slice();
	while (next.length < targetLength) {
		next.push(DEFAULT_MIX_TRACK_GAIN_PCT);
	}
	next[trackIndex] = clamped;
	useAppStore.setState({ mixTrackGainsPct: next });
	if (!state.multiTrackEnabled) {
		return;
	}
	context.player?.setPostMixTrackGains?.(next.map((pct) => pct / 100));
}

/**
 * Applies two loaded cover sources to the Autocanonizer controller with automatic
 * tempo sync, RMS volume normalization, and the active alignment mode.
 */
function applyLoadedAutocanonizerMixSources(
	context: AppContext,
	sources: [LoadedMixTrackSource, LoadedMixTrackSource],
): void {
	const [mainSource, otherSource] = sources;
	const {
		autocanonizerMixAlignment,
		autocanonizerQuadMode,
		autocanonizerQuadBranchMode,
		autocanonizerMainPan,
		autocanonizerOtherPan,
		autocanonizerPinkPan,
		autocanonizerGoldPan,
		autocanonizerMainGainPct,
		autocanonizerOtherGainPct,
		autocanonizerPinkGainPct,
		autocanonizerGoldGainPct,
	} = useAppStore.getState();

	const otherTempoRatio = computeTempoSyncRatio(
		mainSource.tempo,
		otherSource.tempo,
		true,
	);
	const prepared = prepareDualAudioBuffers(
		context.player.getContext(),
		mainSource.buffer,
		otherSource.buffer,
		{
			tempoRatio: otherTempoRatio,
			normalizeVolume: true,
		},
	);

	context.autocanonizer?.setDualAudio?.(
		prepared.mainBuffer,
		prepared.otherBuffer,
		context.player.getContext(),
	);
	context.autocanonizer?.setDualAnalysis?.(
		mainSource.analysisResult,
		otherSource.analysisResult,
		{
			mainDuration: prepared.mainDurationSec,
			otherDuration: prepared.otherDurationSec,
			otherTempoRatio,
			alignmentMode: autocanonizerMixAlignment,
			quadMode: autocanonizerQuadMode,
			quadBranchMode: autocanonizerQuadBranchMode,
		},
	);
	context.autocanonizer?.setStreamPans?.(
		autocanonizerMainPan / 100,
		autocanonizerOtherPan / 100,
	);
	context.autocanonizer?.setStreamGains?.(
		autocanonizerMainGainPct / 100,
		autocanonizerOtherGainPct / 100,
	);
	context.autocanonizer?.setQuadStreamPans?.(
		autocanonizerPinkPan / 100,
		autocanonizerGoldPan / 100,
	);
	context.autocanonizer?.setQuadStreamGains?.(
		autocanonizerPinkGainPct / 100,
		autocanonizerGoldGainPct / 100,
	);

	const title1 = mainSource.track.title || i18n.t("common.untitled");
	const title2 = otherSource.track.title || i18n.t("common.untitled");
	useAppStore.setState({
		autocanonizerMixEnabled: true,
		autocanonizerMixTrackTitles: [title1, title2],
		autocanonizerOtherDurationSec: prepared.otherDurationSec,
		audioLoaded: true,
		analysisLoaded: true,
		audioLoadInFlight: false,
		loadingStep: null,
		trackTitle: `${title1} × ${title2}`,
		trackArtist: "",
		trackDurationSec: prepared.mainDurationSec,
		autocanonizerMainSeconds: 0,
		autocanonizerOtherSeconds: 0,
		autocanonizerPinkSeconds: 0,
		autocanonizerGoldSeconds: 0,
	});
	updateVizVisibility();
	updateTrackInfo(context);
	const rawMainBeats = Array.isArray(mainSource.analysisResult?.beats)
		? (mainSource.analysisResult.beats as Array<{ duration: number }>)
		: undefined;
	const baseTempo = resolveTrackBaseTempoBpm(
		mainSource.tempo ?? mainSource.analysisResult?.track?.tempo,
		rawMainBeats,
	);
	resetLiveBpm(baseTempo);
}

/**
 * Loads up to the first 2 playlist tracks, tempo-syncs the second cover to the
 * first, and starts a dual-song Autocanonizer mix session.
 */
export async function loadAutocanonizerMix(
	context: AppContext,
): Promise<boolean> {
	const { playlist, playMode } = useAppStore.getState();
	if (playMode !== "autocanonizer" || playlist.tracks.length < 2) {
		return false;
	}

	if (playlist.tracks.length > MAX_AUTOCANONIZER_MIX_TRACKS) {
		showToast("Autocanonizer mix uses the first 2 playlist songs.");
	}

	const tracks = playlist.tracks.slice(0, MAX_AUTOCANONIZER_MIX_TRACKS);
	stopPlayback(context);
	bumpLoadGeneration();
	const generation = getLoadGeneration();

	useAppStore.setState({
		audioLoaded: false,
		analysisLoaded: false,
		audioModePreparing: false,
		autocanonizerMixEnabled: true,
	});
	setLoadingStep(context, PENDING_STEP);

	try {
		const sources: LoadedMixTrackSource[] = [];
		for (const track of tracks) {
			if (isStaleLoad(generation)) {
				return false;
			}
			setLoadingStep(context, TRACK_STEP);
			const complete = await resolveTrackAnalysis(track, generation);
			if (isStaleLoad(generation)) {
				return false;
			}
			const buffer = await resolveTrackAudioBuffer(context, track, complete.id);
			if (isStaleLoad(generation)) {
				return false;
			}
			const rawTrackMeta = complete.result.track ?? complete.track;
			const tempo =
				typeof rawTrackMeta?.tempo === "number" &&
				Number.isFinite(rawTrackMeta.tempo)
					? rawTrackMeta.tempo
					: undefined;
			sources.push({
				jobId: complete.id,
				track: {
					...track,
					title:
						typeof rawTrackMeta?.title === "string" && rawTrackMeta.title.trim()
							? rawTrackMeta.title
							: track.title,
					artist:
						typeof rawTrackMeta?.artist === "string"
							? rawTrackMeta.artist
							: track.artist,
				},
				analysisResult: complete.result,
				buffer,
				tempo,
			});
		}

		if (isStaleLoad(generation) || sources.length < 2) {
			return false;
		}

		const pair: [LoadedMixTrackSource, LoadedMixTrackSource] = [
			sources[0],
			sources[1],
		];
		cachedAutocanonizerMixSources = pair;
		applyLoadedAutocanonizerMixSources(context, pair);
		return true;
	} catch (err) {
		if (!isStaleLoad(generation)) {
			cachedAutocanonizerMixSources = null;
			useAppStore.setState({
				autocanonizerMixEnabled: false,
				autocanonizerMixTrackTitles: null,
				autocanonizerOtherDurationSec: null,
			});
			const message = formatErrorForDisplay(err, {
				fallback: i18n.t("status.loadingFailed"),
			});
			setAnalysisStatus(context, () => message);
			showToast(message, { tone: "error" });
		}
		return false;
	}
}

/**
 * Exits 2-song Autocanonizer mix mode, resets per-song gain trims, and
 * restores single-track playback for the active playlist item.
 */
export async function disableAutocanonizerMix(
	context: AppContext,
): Promise<boolean> {
	cachedAutocanonizerMixSources = null;
	stopPlayback(context);
	useAppStore.setState({
		autocanonizerMixEnabled: false,
		autocanonizerQuadMode: false,
		autocanonizerMixTrackTitles: null,
		autocanonizerOtherDurationSec: null,
		autocanonizerMainGainPct: DEFAULT_MIX_TRACK_GAIN_PCT,
		autocanonizerOtherGainPct: DEFAULT_MIX_TRACK_GAIN_PCT,
		autocanonizerPinkGainPct: DEFAULT_MIX_TRACK_GAIN_PCT,
		autocanonizerGoldGainPct: DEFAULT_MIX_TRACK_GAIN_PCT,
	});
	context.autocanonizer?.setQuadMode?.(false);
	context.autocanonizer?.setStreamGains?.(1, 1);
	context.autocanonizer?.setQuadStreamGains?.(1, 1);

	const { playlist } = useAppStore.getState();
	const activeTrack =
		playlist.tracks[playlist.currentIndex] ?? playlist.tracks[0];
	const deps = getPlaybackDeps();
	if (!activeTrack || !deps) {
		return false;
	}

	if (activeTrack.sourceType === "upload" || isLikelyJobId(activeTrack.id)) {
		return loadTrackByJobId(context, deps, activeTrack.id, {
			playlistLoad: true,
			selectedTrack: activeTrack,
		});
	}
	const trackId =
		activeTrack.sourceType === "youtube"
			? activeTrack.id
			: `${activeTrack.sourceType}:${activeTrack.id}`;
	return loadTrackById(context, deps, trackId, {
		playlistLoad: true,
		selectedTrack: activeTrack,
	});
}

/**
 * Switches the 2-song Autocanonizer cross-alignment mode ("cover-sync" or
 * "section-fold") and updates the active controller live when mixed.
 */
export function setAutocanonizerMixAlignment(
	context: AppContext,
	mode: AutocanonizerMixAlignmentMode,
): void {
	useAppStore.setState({ autocanonizerMixAlignment: mode });
	if (!useAppStore.getState().autocanonizerMixEnabled) {
		return;
	}
	context.autocanonizer?.setDualAlignmentMode?.(mode);
}

/**
 * Sets Song 1 or Song 2's live volume balance trim percentage (0–200%) in
 * Autocanonizer mix mode without interrupting playback.
 */
export function setAutocanonizerSongGainPct(
	context: AppContext,
	stream: "main" | "other",
	gainPct: number,
): void {
	const clamped = clampMixTrackGainPct(gainPct);
	const state = useAppStore.getState();
	const nextMain = stream === "main" ? clamped : state.autocanonizerMainGainPct;
	const nextOther =
		stream === "other" ? clamped : state.autocanonizerOtherGainPct;
	useAppStore.setState({
		autocanonizerMainGainPct: nextMain,
		autocanonizerOtherGainPct: nextOther,
	});
	context.autocanonizer?.setStreamGains?.(nextMain / 100, nextOther / 100);
}

/**
 * Swaps Song 1 (top / Blue / straight) and Song 2 (bottom / Green / jumping)
 * using the cached dual mix sources, resuming playback if already running.
 */
export function swapAutocanonizerMixSongs(context: AppContext): boolean {
	if (
		!useAppStore.getState().autocanonizerMixEnabled ||
		!cachedAutocanonizerMixSources
	) {
		return false;
	}
	const wasRunning = useAppStore.getState().isRunning;
	stopPlayback(context);
	cachedAutocanonizerMixSources = [
		cachedAutocanonizerMixSources[1],
		cachedAutocanonizerMixSources[0],
	];
	applyLoadedAutocanonizerMixSources(context, cachedAutocanonizerMixSources);
	if (wasRunning) {
		startAutocanonizerPlayback(context, 0, { resetSession: true });
	}
	return true;
}

/**
 * Toggles 4-voice quad mode (Song 1 on Blue+Green, Song 2 on Pink+Gold) for
 * an active 2-song Autocanonizer mix.
 */
export function setAutocanonizerQuadMode(
	context: AppContext,
	enabled: boolean,
): void {
	useAppStore.setState({ autocanonizerQuadMode: enabled });
	if (!useAppStore.getState().autocanonizerMixEnabled) {
		return;
	}
	context.autocanonizer?.setQuadMode?.(enabled);
}

/**
 * Switches whether Gold mirrors Green ("synced") or follows Song 2's own
 * canon ("independent") when 4-voice quad mode is active.
 */
export function setAutocanonizerQuadBranchMode(
	context: AppContext,
	mode: AutocanonizerQuadBranchMode,
): void {
	useAppStore.setState({ autocanonizerQuadBranchMode: mode });
	if (
		!useAppStore.getState().autocanonizerMixEnabled ||
		!useAppStore.getState().autocanonizerQuadMode
	) {
		return;
	}
	context.autocanonizer?.setQuadBranchMode?.(mode);
}

/**
 * Sets L/R pan percentages (-100 to 100) for Song 2's Pink and Gold streams
 * in 4-voice quad mode.
 */
export function setAutocanonizerQuadStreamPans(
	context: AppContext,
	pinkPanPct: number,
	goldPanPct: number,
): void {
	const clampPanPct = (pan: number) =>
		Number.isFinite(pan) ? Math.max(-100, Math.min(100, Math.round(pan))) : 0;
	const nextPink = clampPanPct(pinkPanPct);
	const nextGold = clampPanPct(goldPanPct);
	useAppStore.setState({
		autocanonizerPinkPan: nextPink,
		autocanonizerGoldPan: nextGold,
	});
	context.autocanonizer?.setQuadStreamPans?.(nextPink / 100, nextGold / 100);
}

/**
 * Sets Song 2's Pink or Gold stream live volume percentage (0–200%) in 4-voice
 * quad mode without interrupting playback.
 */
export function setAutocanonizerQuadSongGainPct(
	context: AppContext,
	stream: "pink" | "gold",
	gainPct: number,
): void {
	const clamped = clampMixTrackGainPct(gainPct);
	const state = useAppStore.getState();
	const nextPink = stream === "pink" ? clamped : state.autocanonizerPinkGainPct;
	const nextGold = stream === "gold" ? clamped : state.autocanonizerGoldGainPct;
	useAppStore.setState({
		autocanonizerPinkGainPct: nextPink,
		autocanonizerGoldGainPct: nextGold,
	});
	context.autocanonizer?.setQuadStreamGains?.(nextPink / 100, nextGold / 100);
}
