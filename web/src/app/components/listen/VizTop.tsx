import { useState } from "react";
import {
	CANONIZER_FINISH_KEY,
	VISUALIZATION_LABELS,
	WUB_MACHINE_LOOP_KEY,
} from "../../constants";
import { trackEvent } from "../../analytics";
import { getAppContext } from "../../runtime";
import {
	disableAutocanonizerMix,
	disableMultiTrackMix,
	loadAutocanonizerMix,
	loadMultiTrackMix,
	loadSongSyncMix,
	setAutocanonizerMixAlignment,
	setAutocanonizerQuadBranchMode,
	setAutocanonizerQuadMode,
	setAutocanonizerSingleVoiceCount,
	setSongSyncLoop,
	swapAutocanonizerMixSongs,
} from "../../playback";
import { showToast } from "../../ui";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import type { AutocanonizerSingleVoiceCount } from "@forever-jukebox/shared/autocanonizer/AutocanonizerController";
import { useAppStore } from "../../store";
import {
	setActiveVisualization,
	setCanonizerFinish,
	setPlayMode,
	setWubMachineLoop,
} from "../../playback-ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CustomAnchorButton, CustomAnchorToolbar } from "./CustomAnchorEditor";
import {
	isLyricsSupportedMode,
	setLyricsKaraokeEnabled,
	setLyricsPanelOpen,
} from "../../lyrics";

function getVisualizationLabel(index: number, t: TFunction) {
	return (
		VISUALIZATION_LABELS[index] ??
		t("playback.visualizationNumber", { number: index + 1 })
	);
}

function getVisualizationSelectEntries(count: number, t: TFunction) {
	return Array.from({ length: count }, (_, index) => ({
		index,
		label: getVisualizationLabel(index, t),
	})).sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
	);
}

// The viz-top controls: play-mode select, visualization select, the
// autocanonizer finish-out checkbox and the Wub Machine loop checkbox. Rendered into the .viz-top container.
// The custom anchor toolbar replaces them while it is open.
export function VizTop() {
	const { t } = useTranslation();
	const playMode = useAppStore((s) => s.playMode);
	const activeVizIndex = useAppStore((s) => s.activeVizIndex);
	const audioLoaded = useAppStore((s) => s.audioLoaded);
	const analysisLoaded = useAppStore((s) => s.analysisLoaded);
	const audioModePreparing = useAppStore((s) => s.audioModePreparing);
	const anchorEditing = useAppStore((s) => s.customAnchorEdit !== null);
	const playlistCount = useAppStore((s) => s.playlist.tracks.length);
	const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
	const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
	const autocanonizerMixAlignment = useAppStore(
		(s) => s.autocanonizerMixAlignment,
	);
	const autocanonizerQuadMode = useAppStore((s) => s.autocanonizerQuadMode);
	const autocanonizerQuadBranchMode = useAppStore(
		(s) => s.autocanonizerQuadBranchMode,
	);
	const autocanonizerTrioMode = useAppStore((s) => s.autocanonizerTrioMode);
	const autocanonizerSingleVoiceCount = useAppStore(
		(s) => s.autocanonizerSingleVoiceCount,
	);
	const singleVoiceCount: AutocanonizerSingleVoiceCount =
		autocanonizerSingleVoiceCount > 2
			? autocanonizerSingleVoiceCount
			: autocanonizerTrioMode
				? 3
				: 2;
  const isCanonizer = playMode === "autocanonizer";
  const isSongSync = playMode === "songsync";
  const songSyncLoop = useAppStore((s) => s.songSyncLoop);
  const songSyncEnabled = useAppStore((s) => s.songSyncEnabled);
  const appConfig = useAppStore((s) => s.appConfig);
  const lyricsKaraokeEnabled = useAppStore((s) => s.lyricsKaraokeEnabled);
  const lyricsPanelOpen = useAppStore((s) => s.lyricsPanelOpen);
  const activeMixEnabled = isCanonizer
    ? autocanonizerMixEnabled
    : multiTrackEnabled;
	const [finishOutSong, setFinishOutSong] = useState(
		() => localStorage.getItem(CANONIZER_FINISH_KEY) === "true",
	);
	const [loopTrack, setLoopTrack] = useState(
		() => localStorage.getItem(WUB_MACHINE_LOOP_KEY) === "true",
	);

	const vizSelectDisabled =
		!(audioLoaded && analysisLoaded) ||
		audioModePreparing ||
		playMode !== "jukebox";
	// On the very first render the controllers are not constructed yet (the
	// ref handoff happens at commit); fall back to the static label count.
	const entries = getVisualizationSelectEntries(
		getAppContext().jukebox?.getCount() ?? VISUALIZATION_LABELS.length,
		t,
	);

	if (anchorEditing) {
		return <CustomAnchorToolbar />;
	}

	return (
		<>
			<div className="viz-actions">
				<label className="viz-select-group" htmlFor="play-mode-select">
					<span className="viz-select-wrap">
						<select
							id="play-mode-select"
							className="viz-select"
							aria-label={t("playback.mode")}
							value={playMode}
							onChange={(event) => setPlayMode(event.target.value as PlayMode)}
						>
							<option value="autocanonizer">
								{t("playback.autocanonizer")}
							</option>
							<option value="jukebox">{t("playback.jukebox")}</option>
							<option value="songsync">{t("playback.songSync")}</option>
							<option value="wubmachine">{t("playback.wubMachine")}</option>
						</select>
						<span
							className="material-symbols-outlined viz-select-arrow"
							aria-hidden="true"
						>
							arrow_drop_down
						</span>
					</span>
				</label>
				<CustomAnchorButton />
				{(playMode === "jukebox" || isCanonizer) &&
				((audioLoaded && analysisLoaded) ||
					multiTrackEnabled ||
					autocanonizerMixEnabled) ? (
					<button
						type="button"
						id="multi-track-mix-toggle"
						className={
							activeMixEnabled
								? "custom-anchor-button is-active"
								: "custom-anchor-button"
						}
						title={
							isCanonizer
								? autocanonizerMixEnabled
									? "Exit 2-song mix and return to single-song Autocanonizer"
									: "Layer two covers together as a 2-song canon"
								: undefined
						}
						onClick={() => {
							const ctx = getAppContext();
							if (activeMixEnabled) {
								void (isCanonizer
									? disableAutocanonizerMix(ctx)
									: disableMultiTrackMix(ctx));
								return;
							}
							if (playlistCount >= 2) {
								useAppStore.setState({ playlistAddSticky: false });
								void (isCanonizer
									? loadAutocanonizerMix(ctx)
									: loadMultiTrackMix(ctx));
								return;
							}
							useAppStore.setState({ playlistAddSticky: true });
							useAppStore.getState().selectTab("top");
							showToast(
								isCanonizer
									? "Click + on a song to add it to your 2-song mix"
									: "Click + on a song to add it to your mix",
							);
						}}
					>
						{activeMixEnabled
							? "Unmix Songs"
							: isCanonizer
								? "Mix 2 Songs"
								: "Mix Songs"}
					</button>
				) : null}
				{isLyricsSupportedMode({
					playMode,
					multiTrackEnabled,
					autocanonizerMixEnabled,
				}) &&
				audioLoaded &&
				analysisLoaded &&
				appConfig?.allow_lyrics ? (
					<>
						<button
							type="button"
							id="lyrics-karaoke-toggle"
							className={
								lyricsKaraokeEnabled
									? "custom-anchor-button is-active"
									: "custom-anchor-button"
							}
							aria-pressed={lyricsKaraokeEnabled}
							onClick={() => setLyricsKaraokeEnabled(!lyricsKaraokeEnabled)}
						>
							{t("lyrics.karaoke")}
						</button>
						<button
							type="button"
							id="lyrics-panel-toggle"
							className={
								lyricsPanelOpen
									? "custom-anchor-button is-active"
									: "custom-anchor-button"
							}
							aria-pressed={lyricsPanelOpen}
							onClick={() => setLyricsPanelOpen(!lyricsPanelOpen)}
						>
							{t("lyrics.panel")}
						</button>
					</>
				) : null}
				{isSongSync ? (
					<button
						type="button"
						id="song-sync-load-toggle"
						className={
							songSyncEnabled
								? "custom-anchor-button is-active"
								: "custom-anchor-button"
						}
						onClick={() => {
							const ctx = getAppContext();
							if (playlistCount >= 2) {
								useAppStore.setState({ playlistAddSticky: false });
								void loadSongSyncMix(ctx);
								return;
							}
							useAppStore.setState({ playlistAddSticky: true });
							useAppStore.getState().selectTab("top");
							showToast(t("playback.songSyncNeedPlaylist"));
						}}
					>
						{playlistCount >= 2
							? t("playback.syncPlaylist")
							: t("playback.addSongsToSync")}
					</button>
				) : null}
				{isCanonizer &&
				!autocanonizerMixEnabled &&
				audioLoaded &&
				analysisLoaded ? (
					<>
						<button
							type="button"
							id="canonizer-trio-toggle"
							className={
								singleVoiceCount === 3
									? "custom-anchor-button is-active"
									: "custom-anchor-button"
							}
							aria-pressed={singleVoiceCount === 3}
							title={t("playback.trioModeTitle")}
							onClick={() =>
								setAutocanonizerSingleVoiceCount(
									getAppContext(),
									singleVoiceCount === 3 ? 2 : 3,
								)
							}
						>
							{t("playback.trioMode")}
						</button>
						<button
							type="button"
							id="canonizer-single-quad-toggle"
							className={
								singleVoiceCount === 4
									? "custom-anchor-button is-active"
									: "custom-anchor-button"
							}
							aria-pressed={singleVoiceCount === 4}
							title={t("playback.singleQuadModeTitle")}
							onClick={() =>
								setAutocanonizerSingleVoiceCount(
									getAppContext(),
									singleVoiceCount === 4 ? 2 : 4,
								)
							}
						>
							{t("playback.singleQuadMode")}
						</button>
					</>
				) : null}
				{isCanonizer && autocanonizerMixEnabled ? (
					<>
						<button
							type="button"
							id="canonizer-mix-swap"
							className="custom-anchor-button"
							title="Swap Blue (top, straight) and Green (bottom, jumping) so the other song branches instead"
							onClick={() => swapAutocanonizerMixSongs(getAppContext())}
						>
							Flip Songs
						</button>
						<span className="viz-actions-divider" aria-hidden="true" />
						<button
							type="button"
							id="canonizer-quad-toggle"
							className={
								autocanonizerQuadMode
									? "custom-anchor-button is-active"
									: "custom-anchor-button"
							}
							aria-pressed={autocanonizerQuadMode}
							title="Enable 4-voice quad canon: Song 1 plays Blue + Green while Song 2 plays Pink (synced to Blue) + Gold"
							onClick={() =>
								setAutocanonizerQuadMode(
									getAppContext(),
									!autocanonizerQuadMode,
								)
							}
						>
							4-Voice
						</button>
						<span className="viz-actions-divider" aria-hidden="true" />
						{autocanonizerQuadMode ? (
							<div
								id="canonizer-quad-branch-group"
								className="canonizer-alignment-toggle"
								role="group"
								aria-label="Quad branch mode"
							>
								<button
									type="button"
									id="canonizer-quad-branch-synced"
									className={
										autocanonizerQuadBranchMode === "synced"
											? "custom-anchor-button is-active"
											: "custom-anchor-button"
									}
									aria-pressed={autocanonizerQuadBranchMode === "synced"}
									title="Synced: Gold mirrors Green's section jumps inside Song 2 (2 musical moments doubled across both covers)"
									onClick={() =>
										setAutocanonizerQuadBranchMode(getAppContext(), "synced")
									}
								>
									Synced
								</button>
								<button
									type="button"
									id="canonizer-quad-branch-independent"
									className={
										autocanonizerQuadBranchMode === "independent"
											? "custom-anchor-button is-active"
											: "custom-anchor-button"
									}
									aria-pressed={autocanonizerQuadBranchMode === "independent"}
									title="Independent: Green follows Song 1's own canon while Gold follows Song 2's own canon (up to 3 simultaneous parts)"
									onClick={() =>
										setAutocanonizerQuadBranchMode(
											getAppContext(),
											"independent",
										)
									}
								>
									Independent
								</button>
							</div>
						) : (
							<div
								id="canonizer-mix-alignment-group"
								className="canonizer-alignment-toggle"
								role="group"
								aria-label="Mix alignment mode"
							>
								<button
									type="button"
									id="canonizer-alignment-cover-sync"
									className={
										autocanonizerMixAlignment === "cover-sync"
											? "custom-anchor-button is-active"
											: "custom-anchor-button"
									}
									aria-pressed={autocanonizerMixAlignment === "cover-sync"}
									title="Maps Song 1's canon jumps onto matching sections of Song 2 using multi-section cover-sync alignment; unique sections play solo"
									onClick={() =>
										setAutocanonizerMixAlignment(getAppContext(), "cover-sync")
									}
								>
									Cover Sync
								</button>
								<button
									type="button"
									id="canonizer-alignment-section-fold"
									className={
										autocanonizerMixAlignment === "section-fold"
											? "custom-anchor-button is-active"
											: "custom-anchor-button"
									}
									aria-pressed={autocanonizerMixAlignment === "section-fold"}
									title="Matches each section of Song 1 directly to the closest non-unison section of Song 2 by audio similarity"
									onClick={() =>
										setAutocanonizerMixAlignment(
											getAppContext(),
											"section-fold",
										)
									}
								>
									Section Fold
								</button>
							</div>
						)}
					</>
				) : null}
			</div>
			<div className="viz-controls">
				<label className="viz-select-group" htmlFor="viz-select">
					<span className="viz-select-wrap">
						<select
							id="viz-select"
							className="viz-select"
							aria-label={t("playback.visualization")}
							disabled={vizSelectDisabled}
							value={String(activeVizIndex)}
							onChange={(event) => {
								const idx = Number(event.target.value);
								if (Number.isFinite(idx)) {
									// Report the label, not the index: reordering the label list
									// would otherwise silently remap historical data.
									trackEvent("select_viz", {
										viz: VISUALIZATION_LABELS[idx] ?? String(idx),
									});
									setActiveVisualization(idx);
								}
							}}
						>
							{entries.map((entry) => (
								<option key={entry.index} value={String(entry.index)}>
									{entry.label}
								</option>
							))}
						</select>
						<span
							className="material-symbols-outlined viz-select-arrow"
							aria-hidden="true"
						>
							arrow_drop_down
						</span>
					</span>
				</label>
			</div>
			<label className="canonizer-finish">
				<input
					type="checkbox"
					id="canonizer-finish"
					checked={finishOutSong}
					onChange={(event) => {
						setFinishOutSong(event.target.checked);
						setCanonizerFinish(event.target.checked);
					}}
				/>
				<span>{t("playback.finishTrack")}</span>
			</label>
			<label className="wubmachine-loop">
				<input
					type="checkbox"
					id="wubmachine-loop"
					checked={loopTrack}
					onChange={(event) => {
						setLoopTrack(event.target.checked);
						setWubMachineLoop(event.target.checked);
					}}
				/>
				<span>{t("playback.loopTrack")}</span>
			</label>
			<label className="songsync-loop">
				<input
					type="checkbox"
					id="songsync-loop"
					checked={songSyncLoop}
					onChange={(event) =>
						setSongSyncLoop(getAppContext(), event.target.checked)
					}
				/>
				<span>{t("playback.loopTrack")}</span>
			</label>
		</>
	);
}
