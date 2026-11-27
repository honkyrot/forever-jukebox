import type { JukeboxEngine } from "@forever-jukebox/shared";
import type {
  BufferedAudioPlayer,
  JukeboxAudioMode,
} from "@forever-jukebox/shared/audio/BufferedAudioPlayer";
import type { Edge, TimeSignatureBranchMode } from "@forever-jukebox/shared/types";
import type { FavoriteTrack } from "./favorites";
import type { PlaylistState } from "./playlist";
import type { AppConfig } from "./api";
import type {
  AutocanonizerController,
  AutocanonizerMixAlignmentMode,
  AutocanonizerQuadBranchMode,
} from "@forever-jukebox/shared/autocanonizer/AutocanonizerController";
import type { SongSyncController } from "@forever-jukebox/shared/songsync/SongSyncController";
import type { WubMachineController } from "@forever-jukebox/shared/wubmachine/WubMachineController";
import type { JukeboxController } from "@forever-jukebox/shared/viz/JukeboxController";
import type { CowbellOverlayService } from "@forever-jukebox/shared/audio/CowbellOverlayService";
import type { MetronomeOverlayService } from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";

export type TabId = "top" | "search" | "play" | "faq";

export type SongSyncTrackUiState = {
  title: string;
  duration: number;
  tempo?: number;
  gainPct: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  beatOffset: number;
  color: string;
};

export type AppState = {
  activeTabId: TabId;
  activeVizIndex: number;
  playMode: PlayMode;
  topSongsTab:
    | "top"
    | "trending"
    | "all-time"
    | "recent"
    | "search"
    | "reported"
    | "favorites";
  searchTab: "search" | "upload";
  favorites: FavoriteTrack[];
  playlist: PlaylistState;
  favoritesSyncCode: string | null;
  playTimerMs: number;
  lastPlayStamp: number | null;
  lastBeatIndex: number | null;
  autocanonizerMainSeconds: number;
  autocanonizerOtherSeconds: number;
  autocanonizerPinkSeconds: number;
  autocanonizerGoldSeconds: number;
  autocanonizerMainPan: number;
  autocanonizerOtherPan: number;
  autocanonizerPinkPan: number;
  autocanonizerGoldPan: number;
  autocanonizerMainGainPct: number;
  autocanonizerOtherGainPct: number;
  autocanonizerPinkGainPct: number;
  autocanonizerGoldGainPct: number;
  autocanonizerMixEnabled: boolean;
  autocanonizerMixAlignment: AutocanonizerMixAlignmentMode;
  autocanonizerQuadMode: boolean;
  autocanonizerQuadBranchMode: AutocanonizerQuadBranchMode;
  autocanonizerMixTrackTitles: [string, string] | null;
  autocanonizerOtherDurationSec: number | null;
  wubMachineSeconds: number;
  wubMachineDurationSec: number;
  vizData: ReturnType<JukeboxEngine["getVisualizationData"]>;
  isRunning: boolean;
  isPaused: boolean;
  audioLoaded: boolean;
  analysisLoaded: boolean;
  audioLoadInFlight: boolean;
  analysisPollInFlight: boolean;
  lastJobId: string | null;
  lastTrackId: string | null;
  lastSourceId: string | null;
  lastSourceProvider: string | null;
  pendingAutoFavoriteId: string | null;
  lastPlayCountedJobId: string | null;
  shiftBranching: boolean;
  freezeBeat: boolean;
  bringItHomeMode: boolean;
  branchStatsEnabled: boolean;
  jukeboxAudioMode: JukeboxAudioMode;
  audioIntensity: number;
  metronomeEnabled: boolean;
  metronomeVolumePct: number;
  metronomeDetectedBeatsPerBar: number;
  audioModePreparing: boolean;
  audioModeRenderToken: number;
  selectedEdge: Edge | null;
  trackDurationSec: number | null;
  trackTitle: string | null;
  trackArtist: string | null;
  trackBpmMultiplier: number;
  trackBpmLocked: boolean;
  deleteEligible: boolean;
  deleteEligibilityJobId: string | null;
  appConfig: AppConfig | null;
  sleepTimer: SleepTimerState;
  tuningParams: string | null;
  deletedEdgeIds: number[];
  highlightAnchorBranch: boolean;
  customAnchorEnabled: boolean;
  multiTrackEnabled: boolean;
  crossTrackOnly: boolean;
  coverSyncEnabled: boolean;
  timeSignatureBranchingEnabled: boolean;
  timeSignatureBranchMode: TimeSignatureBranchMode;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  timeSignatureTrackOffsets: number[];
  timeSignatureSimilarityRestrictEnabled: boolean;
  timeSignatureSimilarityNumerator: number;
  timeSignatureSimilarityDenominator: number;
  tempoSyncEnabled: boolean;
  normalizeVolumeEnabled: boolean;
  postMixNormalizeVolumeEnabled: boolean;
  mixTrackGainsPct: number[];
  songSyncEnabled: boolean;
  songSyncLoop: boolean;
  songSyncTempoSyncEnabled: boolean;
  songSyncNormalizeVolumeEnabled: boolean;
  songSyncMasterTrackIndex: number;
  songSyncTracks: SongSyncTrackUiState[];
  songSyncTrackSeconds: Array<number | null>;
  playlistAddSticky: boolean;
};

export type SleepTimerState = {
  configuredDurationMs: number | null;
  endTimeMs: number | null;
  remainingMs: number;
};

export type AppContext = {
  engine: JukeboxEngine;
  player: BufferedAudioPlayer;
  autocanonizer: AutocanonizerController | null;
  songsync?: SongSyncController | null;
  wubmachine: WubMachineController | null;
  jukebox: JukeboxController | null;
  cowbellOverlay: CowbellOverlayService;
  metronomeOverlay: MetronomeOverlayService;
  defaultConfig: ReturnType<JukeboxEngine["getConfig"]>;
};

export type AttachedAppContext = AppContext & {
  autocanonizer: AutocanonizerController;
  songsync?: SongSyncController | null;
  wubmachine: WubMachineController;
  jukebox: JukeboxController;
};
