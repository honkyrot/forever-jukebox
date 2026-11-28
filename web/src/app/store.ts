import type { LoadingStepId, LoadingTask } from "@forever-jukebox/shared/ui/LoadingProgress";
import { create, type StateCreator } from "zustand";
import type { ToastQueueItem } from "@forever-jukebox/shared/ui/toastQueue";
import {
  readStoredVisualPreferences,
  type AnchorEditState,
  type VisualPreferences,
} from "@forever-jukebox/shared/viz/JukeboxViz";
import {
  resolveStoredBranchLookaheadCount,
  resolveStoredBranchLookaheadEnabled,
} from "./branchLookahead";
import {
  resolveStoredBpmBarDenominator,
  resolveStoredBpmBarNumerator,
  resolveStoredBpmBarStyle,
  resolveStoredBpmBarTimeSignatureMode,
  type BpmBarPulseBeat,
  type BpmBarStyle,
  type BpmBarTimeSignatureMode,
} from "./bpmBarTimeSignature";
import type { BpmTrend } from "./liveBpm";
import i18n from "./i18n";
import type { SpotifySearchItem, YoutubeSearchItem } from "./api";
import type { AppState, SleepTimerState, TabId } from "./context";
import type { FavoritesDisplaySort } from "./favorites";
import type { ThemeName } from "./themeConfig";
import type { NormalizedLyrics } from "@forever-jukebox/shared/lyrics";
import type { MaterialSymbolIconName } from "./material-icons";
import type { LyricsStatus } from "./lyrics";
import { DEFAULT_VISUALIZATION_INDEX } from "./constants";
import { emptyPlaylist } from "./playlist";
import { buildSearchParams, pathForTab, pathForTrack } from "./tabs";
import {
  DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
  DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  DEFAULT_TIME_SIGNATURE_NUMERATOR,
} from "@forever-jukebox/shared";
import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_METRONOME_VOLUME_PCT,
} from "@forever-jukebox/shared/audio/MetronomeOverlayService";
import { getTuningParamsStringFromUrl } from "./tuning";

type FooterCredit = {
  hostedByName: string | null;
  hostedByUrl: string | null;
};

export type ToastState = {
  message: string;
  icon?: MaterialSymbolIconName;
  tone: "default" | "error";
};

type ToastItem = ToastQueueItem<ToastState>;

type BranchStatsState = {
  title: LocalizedText;
  startText: string;
  endText: string;
  deltaText: string;
  startBeatText: string;
  endBeatText: string;
  beatDeltaText: string;
  direction: LocalizedText;
  similarityText: string;
  deleteDisabled: boolean;
};

type TrackInfoState = {
  durationText: string;
  totalBeats: number;
  branchCount: number;
  deletedCount: number;
};

type NavigationRequest = {
  id: number;
  to: string;
  replace?: boolean;
};

// Persistent store text is kept as a thunk so it re-translates when the
// language changes; components evaluate it on render.
export type LocalizedText = () => string;

// The active step of a load or mode render; null when nothing is loading.
export type LoadingState = {
  task: LoadingTask;
  activeId: LoadingStepId;
  progress: number | null;
  message?: LocalizedText;
};

export type SearchResultsState =
  | { kind: "message"; text: LocalizedText }
  | { kind: "spotify"; items: SpotifySearchItem[] }
  | {
      kind: "youtube";
      items: Array<{ item: YoutubeSearchItem; name: string; artist: string }>;
    };

export type TopSongsListTabId = "top" | "trending" | "recent";

export type TopSongsItem = {
  id?: string;
  title?: string;
  artist?: string;
  source_id?: string;
  source_provider?: string;
  play_count?: number;
};

export type TopSongsListState =
  | { kind: "message"; text: LocalizedText }
  | { kind: "loaded"; items: TopSongsItem[] };

export const DEFAULT_SEARCH_HINT: LocalizedText = () =>
  i18n.t("search.hintStep1");
export const DEFAULT_SEARCH_RESULTS: SearchResultsState = {
  kind: "message",
  text: () => i18n.t("search.resultsEmpty"),
};

function createDefaultTopSongsLists(): Record<
  TopSongsListTabId,
  TopSongsListState
> {
  return {
    top: { kind: "message", text: () => i18n.t("topTracks.loadingTop") },
    trending: {
      kind: "message",
      text: () => i18n.t("topTracks.loadingTrending"),
    },
    recent: { kind: "message", text: () => i18n.t("topTracks.loadingRecent") },
  };
}

// Shell/panel UI state that has no AppState counterpart.
type ShellSlice = {
  theme: ThemeName;
  navigationRequest: NavigationRequest | null;
  isPlayTabPulsing: boolean;
  vizStatsPulseId: number;
  vizStatsPulseBeatIndex: number | null;
  vizStatsPulseBeat: BpmBarPulseBeat | null;
  footerCredit: FooterCredit | null;
  toasts: ToastItem[];
  searchQuery: string;
  searchHint: LocalizedText;
  searchResults: SearchResultsState;
  topSongsLists: Record<TopSongsListTabId, TopSongsListState>;
  topSongsLoadedTabs: TopSongsListTabId[];
  topSongsInFlightTabs: TopSongsListTabId[];
  favoritesSort: FavoritesDisplaySort;
  // Listen-panel modal/menu state. Open flags live here so the imperative
  // flows (openExtras hotkey, playlist buttons, resetForNewTrack) can drive
  // the React modals.
  tuningModalOpen: boolean;
  tuningModalTab: "tuning" | "extras";
  infoModalOpen: boolean;
  settingsModalOpen: boolean;
  feedbackModalOpen: boolean;
  playlistModalOpen: boolean;
  deleteConfirmOpen: boolean;
  renameModalOpen: boolean;
  reanalyzeModalOpen: boolean;
  trackInfo: TrackInfoState;
  favoriteToggleBusy: boolean;
  volumePct: number;
  isFullscreen: boolean;
  analysisStatusText: LocalizedText;
  loadingStep: LoadingState | null;
  // True while the loading steps play out on screen.
  loadingShown: boolean;
  listenTimeText: string;
  jukeboxCurrentSeconds: number;
  beatsPlayedText: string;
  branchChanceText: string;
  trackTempoBpm: number | null;
  bpmText: string;
  bpmTrend: BpmTrend;
  bpmBarEnabled: boolean;
  bpmBarStyle: BpmBarStyle;
  bpmBarTimeSignatureMode: BpmBarTimeSignatureMode;
  bpmBarNumerator: number;
  bpmBarDenominator: number;
  bpmBarBeatOffset: number;
  visualPreferences: VisualPreferences;
  branchLookaheadEnabled: boolean;
  branchLookaheadCount: number;
  playlistLoadBusy: boolean;
  branchStats: BranchStatsState | null;
  // Non-null while the custom anchor editor is open on the viz.
  customAnchorEdit: AnchorEditState | null;
  lyricsKaraokeEnabled: boolean;
  lyricsPanelOpen: boolean;
  lyricsRomanizationEnabled: boolean;
  lyricsStatus: LyricsStatus;
  lyricsData: NormalizedLyrics | null;
  lyricsJobId: string | null;
  lyricsOffsetSec: number;
};

type Actions = {
  setActiveTab: (tab: TabId) => void;
  setTheme: (theme: ThemeName) => void;
  setPlayTabPulsing: (pulsing: boolean) => void;
  setFooterCredit: (credit: FooterCredit | null) => void;
  // Navigation requests are applied to browser history by <NavigationDriver>
  // after the caller's synchronous URL writes.
  navigateToTabWithState: (
    tabId: TabId,
    options?: {
      replace?: boolean;
      trackId?: string | null;
      tuningParams?: string | null;
    },
  ) => void;
  navigateToTrackWithState: (
    trackId: string,
    options?: {
      replace?: boolean;
      tuningParams?: string | null;
      playMode?: AppState["playMode"];
    },
  ) => void;
  selectTab: (tabId: TabId) => void;
  goHome: () => void;
  setTopSongsListState: (
    tabId: TopSongsListTabId,
    listState: TopSongsListState,
  ) => void;
  setTopSongsTabLoaded: (tabId: TopSongsListTabId, loaded: boolean) => void;
  setTopSongsTabInFlight: (
    tabId: TopSongsListTabId,
    inFlight: boolean,
  ) => void;
  resetTopSongsCache: () => void;
};

export type AppStoreState = AppState & ShellSlice & Actions;

type Slice<T> = StateCreator<AppStoreState, [], [], T>;

// Tabs whose own subtab selection resets to its default when navigated to,
// kept as a table so adding a tab's reset is a data edit, not another branch.
const SUBTAB_RESETS: Partial<Record<TabId, Partial<AppStoreState>>> = {
  top: { topSongsTab: "top" },
  search: { searchTab: "search" },
};

// The store is flat (zustand slices pattern); slices group state by domain
// (ui / playback / track / tuning / library / config).

const createUiSlice: Slice<
  Pick<
    AppStoreState,
    | "activeTabId"
    | "topSongsTab"
    | "searchTab"
    | "activeVizIndex"
    | "selectedEdge"
    | "theme"
    | "navigationRequest"
    | "isPlayTabPulsing"
    | "vizStatsPulseId"
    | "vizStatsPulseBeatIndex"
    | "vizStatsPulseBeat"
    | "footerCredit"
    | "toasts"
    | "searchQuery"
    | "searchHint"
    | "searchResults"
    | "topSongsLists"
    | "topSongsLoadedTabs"
    | "topSongsInFlightTabs"
    | "favoritesSort"
    | "tuningModalOpen"
    | "tuningModalTab"
    | "infoModalOpen"
    | "settingsModalOpen"
    | "feedbackModalOpen"
    | "playlistModalOpen"
    | "deleteConfirmOpen"
    | "renameModalOpen"
    | "reanalyzeModalOpen"
    | "trackInfo"
    | "favoriteToggleBusy"
    | "volumePct"
    | "isFullscreen"
    | "analysisStatusText"
    | "loadingStep"
    | "loadingShown"
    | "listenTimeText"
    | "jukeboxCurrentSeconds"
    | "beatsPlayedText"
    | "branchChanceText"
    | "trackTempoBpm"
    | "bpmText"
    | "bpmTrend"
    | "bpmBarEnabled"
    | "bpmBarStyle"
    | "bpmBarTimeSignatureMode"
    | "bpmBarNumerator"
    | "bpmBarDenominator"
    | "bpmBarBeatOffset"
    | "visualPreferences"
    | "branchLookaheadEnabled"
    | "branchLookaheadCount"
    | "playlistLoadBusy"
    | "branchStats"
    | "customAnchorEdit"
    | "lyricsKaraokeEnabled"
    | "lyricsPanelOpen"
    | "lyricsRomanizationEnabled"
    | "lyricsStatus"
    | "lyricsData"
    | "lyricsJobId"
    | "lyricsOffsetSec"
  > &
    Actions
> = (set, get) => {
  const queueNavigation = (to: string, replace?: boolean) => {
    const id = (get().navigationRequest?.id ?? 0) + 1;
    set({ navigationRequest: { id, to, replace } });
  };

  const updateTabList = (
    current: TopSongsListTabId[],
    tabId: TopSongsListTabId,
    included: boolean,
  ) => {
    if (included) {
      return current.includes(tabId) ? current : [...current, tabId];
    }
    return current.filter((currentTabId) => currentTabId !== tabId);
  };

  return {
    activeTabId: "top",
    topSongsTab: "top",
    searchTab: "search",
    activeVizIndex: DEFAULT_VISUALIZATION_INDEX,
    selectedEdge: null,
    theme: "dark",
    navigationRequest: null,
    isPlayTabPulsing: false,
    vizStatsPulseId: 0,
    vizStatsPulseBeatIndex: null,
    vizStatsPulseBeat: null,
    footerCredit: null,
    toasts: [],
    searchQuery: "",
    searchHint: DEFAULT_SEARCH_HINT,
    searchResults: DEFAULT_SEARCH_RESULTS,
    topSongsLists: createDefaultTopSongsLists(),
    topSongsLoadedTabs: [],
    topSongsInFlightTabs: [],
    favoritesSort: { key: "title", direction: "asc" },
    tuningModalOpen: false,
    tuningModalTab: "tuning",
    infoModalOpen: false,
    settingsModalOpen: false,
    feedbackModalOpen: false,
    playlistModalOpen: false,
    deleteConfirmOpen: false,
    renameModalOpen: false,
    reanalyzeModalOpen: false,
    trackInfo: {
      durationText: "00:00:00",
      totalBeats: 0,
      branchCount: 0,
      deletedCount: 0,
    },
    favoriteToggleBusy: false,
    volumePct: 100,
    isFullscreen: false,
    analysisStatusText: () => i18n.t("status.noTrack"),
    loadingStep: null,
    loadingShown: false,
    listenTimeText: "00:00:00",
    jukeboxCurrentSeconds: 0,
    beatsPlayedText: "0",
    branchChanceText: "0%",
    trackTempoBpm: null,
    bpmText: "--",
    bpmTrend: null,
    bpmBarEnabled:
      typeof localStorage === "undefined" ||
      localStorage.getItem("bpmBarEnabled") !== "false",
    bpmBarStyle: resolveStoredBpmBarStyle(),
    bpmBarTimeSignatureMode: resolveStoredBpmBarTimeSignatureMode(),
    bpmBarNumerator: resolveStoredBpmBarNumerator(),
    bpmBarDenominator: resolveStoredBpmBarDenominator(),
    bpmBarBeatOffset: 0,
    visualPreferences: readStoredVisualPreferences(),
    branchLookaheadEnabled: resolveStoredBranchLookaheadEnabled(),
    branchLookaheadCount: resolveStoredBranchLookaheadCount(),
    playlistLoadBusy: false,
    branchStats: null,
    customAnchorEdit: null,
    lyricsKaraokeEnabled: false,
    lyricsPanelOpen: false,
    lyricsRomanizationEnabled: false,
    lyricsStatus: "idle",
    lyricsData: null,
    lyricsJobId: null,
    lyricsOffsetSec: 0,
    setActiveTab: (activeTabId) =>
      set((state) => ({
        activeTabId,
        tuningModalOpen: activeTabId === "play" ? state.tuningModalOpen : false,
        infoModalOpen: activeTabId === "play" ? state.infoModalOpen : false,
      })),
    setTheme: (theme) => set({ theme }),
    setPlayTabPulsing: (isPlayTabPulsing) => set({ isPlayTabPulsing }),
    setFooterCredit: (footerCredit) => set({ footerCredit }),
    navigateToTabWithState: (tabId, options) => {
      get().setActiveTab(tabId);
      const state = get();
      const trackId =
        options && "trackId" in options ? options.trackId : getCurrentTrackId();
      const tuningParams =
        options && "tuningParams" in options
          ? options.tuningParams
          : (state.tuningParams ?? getTuningParamsStringFromUrl());
      const path = pathForTab(tabId, trackId);
      const search =
        tabId === "play" ? buildSearchParams(tuningParams, state.playMode) : "";
      queueNavigation(`${path}${search}`, options?.replace);
    },
    navigateToTrackWithState: (trackId, options) => {
      const state = get();
      queueNavigation(
        pathForTrack(
          trackId,
          options && "tuningParams" in options
            ? options.tuningParams
            : state.tuningParams,
          options?.playMode ?? state.playMode,
        ),
        options?.replace,
      );
    },
    selectTab: (tabId) => {
      const reset = SUBTAB_RESETS[tabId];
      if (reset) {
        set(reset);
      }
      get().navigateToTabWithState(tabId);
    },
    goHome: () => get().navigateToTabWithState("top"),
    setTopSongsListState: (tabId, listState) =>
      set((state) => ({
        topSongsLists: {
          ...state.topSongsLists,
          [tabId]: listState,
        },
      })),
    setTopSongsTabLoaded: (tabId, loaded) =>
      set((state) => ({
        topSongsLoadedTabs: updateTabList(
          state.topSongsLoadedTabs,
          tabId,
          loaded,
        ),
      })),
    setTopSongsTabInFlight: (tabId, inFlight) =>
      set((state) => ({
        topSongsInFlightTabs: updateTabList(
          state.topSongsInFlightTabs,
          tabId,
          inFlight,
        ),
      })),
    resetTopSongsCache: () =>
      set({
        topSongsLists: createDefaultTopSongsLists(),
        topSongsLoadedTabs: [],
        topSongsInFlightTabs: [],
      }),
  };
};

const defaultSleepTimer: SleepTimerState = {
  configuredDurationMs: null,
  endTimeMs: null,
  remainingMs: 0,
};

const createPlaybackSlice: Slice<
  Pick<
    AppStoreState,
    | "isRunning"
    | "isPaused"
    | "playMode"
    | "playTimerMs"
    | "lastPlayStamp"
    | "lastBeatIndex"
    | "autocanonizerMainSeconds"
    | "autocanonizerOtherSeconds"
    | "autocanonizerPinkSeconds"
    | "autocanonizerGoldSeconds"
    | "autocanonizerMainPan"
    | "autocanonizerOtherPan"
    | "autocanonizerPinkPan"
    | "autocanonizerGoldPan"
    | "autocanonizerMainGainPct"
    | "autocanonizerOtherGainPct"
    | "autocanonizerPinkGainPct"
    | "autocanonizerGoldGainPct"
    | "autocanonizerMixEnabled"
    | "autocanonizerMixAlignment"
    | "autocanonizerQuadMode"
    | "autocanonizerQuadBranchMode"
    | "autocanonizerTrioMode"
    | "autocanonizerSingleVoiceCount"
    | "autocanonizerMixTrackTitles"
    | "autocanonizerOtherDurationSec"
    | "wubMachineSeconds"
    | "wubMachineDurationSec"
    | "vizData"
    | "shiftBranching"
    | "freezeBeat"
    | "bringItHomeMode"
    | "jukeboxAudioMode"
    | "audioIntensity"
    | "metronomeEnabled"
    | "metronomeVolumePct"
    | "metronomeDetectedBeatsPerBar"
    | "audioModePreparing"
    | "audioModeRenderToken"
    | "sleepTimer"
  >
> = () => ({
  isRunning: false,
  isPaused: false,
  playMode: "jukebox",
  playTimerMs: 0,
  lastPlayStamp: null,
  lastBeatIndex: null,
  autocanonizerMainSeconds: 0,
  autocanonizerOtherSeconds: 0,
  autocanonizerPinkSeconds: 0,
  autocanonizerGoldSeconds: 0,
  autocanonizerMainPan: 0,
  autocanonizerOtherPan: 0,
  autocanonizerPinkPan: 0,
  autocanonizerGoldPan: 0,
  autocanonizerMainGainPct: 100,
  autocanonizerOtherGainPct: 100,
  autocanonizerPinkGainPct: 100,
  autocanonizerGoldGainPct: 100,
  autocanonizerMixEnabled: false,
  autocanonizerMixAlignment: "cover-sync",
  autocanonizerQuadMode: false,
  autocanonizerQuadBranchMode: "synced",
  autocanonizerTrioMode: false,
  autocanonizerSingleVoiceCount: 2,
  autocanonizerMixTrackTitles: null,
  autocanonizerOtherDurationSec: null,
  wubMachineSeconds: 0,
  wubMachineDurationSec: 0,
  vizData: null,
  shiftBranching: false,
  freezeBeat: false,
  bringItHomeMode: false,
  jukeboxAudioMode: "off",
  audioIntensity: 100,
  metronomeEnabled: false,
  metronomeVolumePct: DEFAULT_METRONOME_VOLUME_PCT,
  metronomeDetectedBeatsPerBar: DEFAULT_BEATS_PER_BAR,
  audioModePreparing: false,
  audioModeRenderToken: 0,
  sleepTimer: defaultSleepTimer,
});

const createTrackSlice: Slice<
  Pick<
    AppStoreState,
    | "audioLoaded"
    | "analysisLoaded"
    | "audioLoadInFlight"
    | "analysisPollInFlight"
    | "lastJobId"
    | "lastTrackId"
    | "lastSourceId"
    | "lastSourceProvider"
    | "trackTitle"
    | "trackArtist"
    | "trackDurationSec"
    | "trackBpmMultiplier"
    | "trackBpmLocked"
    | "lastPlayCountedJobId"
    | "deleteEligible"
    | "deleteEligibilityJobId"
  >
> = () => ({
  audioLoaded: false,
  analysisLoaded: false,
  audioLoadInFlight: false,
  analysisPollInFlight: false,
  lastJobId: null,
  lastTrackId: null,
  lastSourceId: null,
  lastSourceProvider: null,
  trackTitle: null,
  trackArtist: null,
  trackDurationSec: null,
  trackBpmMultiplier: 1,
  trackBpmLocked: false,
  lastPlayCountedJobId: null,
  deleteEligible: false,
  deleteEligibilityJobId: null,
});

const createTuningSlice: Slice<
  Pick<
    AppStoreState,
    | "tuningParams"
    | "deletedEdgeIds"
    | "highlightAnchorBranch"
    | "branchStatsEnabled"
    | "customAnchorEnabled"
    | "multiTrackEnabled"
    | "crossTrackOnly"
    | "coverSyncEnabled"
    | "timeSignatureBranchingEnabled"
    | "timeSignatureBranchMode"
    | "timeSignatureNumerator"
    | "timeSignatureDenominator"
    | "timeSignatureTrackOffsets"
    | "timeSignatureSimilarityRestrictEnabled"
    | "timeSignatureSimilarityNumerator"
    | "timeSignatureSimilarityDenominator"
    | "tempoSyncEnabled"
    | "normalizeVolumeEnabled"
    | "postMixNormalizeVolumeEnabled"
    | "mixTrackGainsPct"
    | "songSyncEnabled"
    | "songSyncLoop"
    | "songSyncTempoSyncEnabled"
    | "songSyncNormalizeVolumeEnabled"
    | "songSyncMasterTrackIndex"
    | "songSyncTracks"
    | "songSyncTrackSeconds"
    | "playlistAddSticky"
  >
> = () => ({
  tuningParams: null,
  deletedEdgeIds: [],
  highlightAnchorBranch: false,
  branchStatsEnabled: false,
  customAnchorEnabled: false,
  multiTrackEnabled: false,
  crossTrackOnly: true,
  coverSyncEnabled: false,
  timeSignatureBranchingEnabled: false,
  timeSignatureBranchMode: DEFAULT_TIME_SIGNATURE_BRANCH_MODE,
  timeSignatureNumerator: DEFAULT_TIME_SIGNATURE_NUMERATOR,
  timeSignatureDenominator: DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  timeSignatureTrackOffsets: [],
  timeSignatureSimilarityRestrictEnabled: false,
  timeSignatureSimilarityNumerator: DEFAULT_TIME_SIGNATURE_NUMERATOR,
  timeSignatureSimilarityDenominator: DEFAULT_TIME_SIGNATURE_DENOMINATOR,
  tempoSyncEnabled: true,
  normalizeVolumeEnabled: true,
  postMixNormalizeVolumeEnabled: false,
  mixTrackGainsPct: [],
  songSyncEnabled: false,
  songSyncLoop: false,
  songSyncTempoSyncEnabled: true,
  songSyncNormalizeVolumeEnabled: true,
  songSyncMasterTrackIndex: 0,
  songSyncTracks: [],
  songSyncTrackSeconds: [],
  playlistAddSticky: false,
});

const createLibrarySlice: Slice<
  Pick<
    AppStoreState,
    | "favorites"
    | "playlist"
    | "favoritesSyncCode"
    | "pendingAutoFavoriteId"
  >
> = () => ({
  favorites: [],
  playlist: emptyPlaylist(),
  favoritesSyncCode: null,
  pendingAutoFavoriteId: null,
});

const createConfigSlice: Slice<Pick<AppStoreState, "appConfig">> = () => ({
  appConfig: null,
});

export const useAppStore = create<AppStoreState>()((...args) => ({
  ...createUiSlice(...args),
  ...createPlaybackSlice(...args),
  ...createTrackSlice(...args),
  ...createTuningSlice(...args),
  ...createLibrarySlice(...args),
  ...createConfigSlice(...args),
}));

// The id of the track currently in context: the loaded track id, falling back
// to the analysis job id. Single source of truth for navigation/URL state and
// the imperative flows that need "what's playing now".
export function getCurrentTrackId(): string | null {
  const state = useAppStore.getState();
  return state.lastTrackId ?? state.lastJobId;
}
