import type { AppState, TabId } from "../context";
import { TOP_SONGS_LIMIT } from "../constants";
import type { Elements } from "../elements";
import { navigateToFaqSubtab, type FaqSubtabId } from "../tabs";
import type { FavoritesHandlers } from "./favorites";

type TabsDeps = {
  elements: Elements;
  state: AppState;
  favoritesHandlers: FavoritesHandlers;
  navigateToTabWithState: (
    tabId: TabId,
    options?: { replace?: boolean; youtubeId?: string | null },
  ) => void;
  onTopSongsTabChange?: (tabId: "top" | "trending" | "all-time" | "recent" | "favorites") => void;
  onFaqOpen?: () => void;
};

export type TabsHandlers = ReturnType<typeof createTabsHandlers>;

export function createTabsHandlers(deps: TabsDeps) {
  const {
    elements,
    state,
    favoritesHandlers,
    navigateToTabWithState,
    onFaqOpen,
  } = deps;

  function setTopSongsTab(tabId: "top" | "trending" | "all-time" | "recent" | "favorites") {
    state.topSongsTab = tabId;
    elements.topSongsTabs.forEach((button) => {
      button.classList.toggle("active", button.dataset.topSubtab === tabId);
    });
    elements.topSongsList.classList.toggle("hidden", tabId !== "top");
    elements.trendingSongsList.classList.toggle("hidden", tabId !== "trending");
    elements.allTimeSongsList.classList.toggle("hidden", tabId !== "all-time");
    elements.recentSongsList.classList.toggle("hidden", tabId !== "recent");
    elements.favoritesFilter.classList.toggle("hidden", tabId !== "favorites");
    elements.favoritesList.classList.toggle("hidden", tabId !== "favorites");
    elements.allTimeSortSelect.classList.toggle("hidden", tabId !== "all-time");
    if (tabId !== "all-time") {
      elements.allTimeLoadMoreContainer.classList.add("hidden");
    }
    elements.topListTitle.textContent =
      tabId === "all-time" ? "All Time" :
      tabId === "top"
        ? `Top ${TOP_SONGS_LIMIT}`
        : tabId === "trending"
          ? "Trending"
        : tabId === "recent"
          ? `Last ${TOP_SONGS_LIMIT} Played`
          : "Favorites";
    favoritesHandlers.closeFavoritesSyncMenu();
    favoritesHandlers.updateFavoritesSyncControls();
    deps.onTopSongsTabChange?.(tabId);
  }

  function setSearchTab(tabId: "search" | "upload") {
    state.searchTab = tabId;
    elements.searchSubtabButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.searchSubtab === tabId);
    });
    elements.searchPanel.classList.toggle("hidden", tabId !== "search");
    elements.uploadPanel.classList.toggle("hidden", tabId !== "upload");
    elements.searchPanelTitle.textContent =
      tabId === "search" ? "Search" : "Upload";
  }

  function setFaqTab(tabId: FaqSubtabId) {
    elements.faqSubtabButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.faqSubtab === tabId);
    });
    elements.faqPanel.classList.toggle("hidden", tabId !== "faq");
    elements.faqWhatsNewPanel.classList.toggle("hidden", tabId !== "whats-new");
    elements.faqPanelTitle.textContent = tabId === "faq" ? "FAQ" : "What's New";
  }

  function handleTopSongsTabClick(event: Event) {
    const button = event.currentTarget as HTMLButtonElement | null;
    const tabId = button?.dataset.topSubtab as
      | "top"
      | "trending"
      | "all-time"
      | "recent"
      | "favorites"
      | undefined;
    if (!tabId) {
      return;
    }
    setTopSongsTab(tabId);
  }

  function handleSearchSubtabClick(event: Event) {
    const button = event.currentTarget as HTMLButtonElement | null;
    const tabId = button?.dataset.searchSubtab as
      | "search"
      | "upload"
      | undefined;
    if (!tabId) {
      return;
    }
    setSearchTab(tabId);
  }

  function handleFaqSubtabClick(event: Event) {
    const button = event.currentTarget as HTMLButtonElement | null;
    const tabId = button?.dataset.faqSubtab as FaqSubtabId | undefined;
    if (!tabId) {
      return;
    }
    setFaqTab(tabId);
    navigateToFaqSubtab(tabId);
    onFaqOpen?.();
  }

  function handleTabClick(event: Event) {
    const button = event.currentTarget as HTMLButtonElement | null;
    const tabId = button?.dataset.tabButton as TabId | undefined;
    if (!tabId) {
      return;
    }
    if (tabId === "top") {
      setTopSongsTab("top");
    }
    if (tabId === "search") {
      setSearchTab("search");
    }
    if (tabId === "faq") {
      setFaqTab("faq");
    }
    navigateToTabWithState(tabId);
    if (tabId === "faq") {
      onFaqOpen?.();
    }
    elements.tuningModal.classList.add("hidden");
    elements.tuningModal.classList.remove("open");
    elements.infoModal.classList.add("hidden");
    elements.infoModal.classList.remove("open");
    elements.autocanonizerTuningModal.classList.add("hidden");
    elements.autocanonizerTuningModal.classList.remove("open");
  }

  return {
    setTopSongsTab,
    handleTopSongsTabClick,
    setSearchTab,
    handleSearchSubtabClick,
    setFaqTab,
    handleFaqSubtabClick,
    handleTabClick,
  };
}
