import type { Elements } from "../elements";
import type { TabId } from "../context";
import { formatErrorForDisplay } from "../errorDisplay";

export type TopSongItem = {
  id?: string;
  title?: string;
  artist?: string;
  source_id?: string;
  source_provider?: string;
  play_count?: number;
};

type TopSongsDeps = {
  elements: Elements;
  fetchTopSongs: (limit: number, sortBy?: string, offset?: number) => Promise<TopSongItem[]>;
  fetchTrendingSongs: () => Promise<TopSongItem[]>;
  fetchRecentSongs: (limit: number) => Promise<TopSongItem[]>;
  loadTrackBySourceId: (sourceId: string, sourceProvider?: string) => void;
  loadTrackById: (trackId: string) => void;
  loadTrackByJobId: (jobId: string) => void;
  navigateToTabWithState: (
    tabId: TabId,
    options?: { replace?: boolean; trackId?: string | null },
  ) => void;
  limit: number;
};

export type TopSongsHandlers = ReturnType<typeof createTopSongsHandlers>;

export function createTopSongsHandlers(deps: TopSongsDeps) {
  const {
    elements,
    fetchTopSongs,
    fetchTrendingSongs,
    fetchRecentSongs,
    loadTrackById,
    loadTrackByJobId,
    navigateToTabWithState,
    limit,
  } = deps;

  let allTimeOffset = 0;
  const ALL_TIME_LIMIT = 50;

  function isLikelyJobId(value: string) {
    return /^[a-f0-9]{32}$/.test(value);
  }

  async function renderSongList(options: {
    listEl: HTMLOListElement;
    fetchItems: () => Promise<TopSongItem[]>;
    loadingText: string;
    emptyText: string;
    errorPrefix: string;
    overrideLimit?: number;
    append?: boolean;
    onRendered?: (count: number) => void;
  }) {
    const { listEl, fetchItems, loadingText, emptyText, errorPrefix, overrideLimit, append, onRendered } = options;
    if (!append) {
      listEl.textContent = loadingText;
    } else {
      const loadingLi = document.createElement("li");
      loadingLi.textContent = "Loading more...";
      loadingLi.id = "loading-more-li";
      listEl.appendChild(loadingLi);
    }
    try {
      const items = await fetchItems();
      if (append) {
        const loadingLi = listEl.querySelector("#loading-more-li");
        if (loadingLi) loadingLi.remove();
      }
      if (!append && items.length === 0) {
        listEl.textContent = emptyText;
        onRendered?.(0);
        return;
      }
      if (!append) {
        listEl.innerHTML = "";
      }
      const displayLimit = overrideLimit ?? limit;
      const renderItems = append ? items : items.slice(0, displayLimit);
      for (const item of renderItems) {
        const title = typeof item.title === "string" ? item.title : "Untitled";
        const artist = typeof item.artist === "string" ? item.artist : "";
        const sourceId = typeof item.source_id === "string" ? item.source_id : "";
        const jobId = typeof item.id === "string" ? item.id : "";
        const sourceProvider =
          typeof item.source_provider === "string" ? item.source_provider : "";
        const listenId =
          sourceProvider === "youtube" && sourceId
            ? sourceId
            : (jobId || sourceId);
        const li = document.createElement("li");
        
        const container = document.createElement("span");
        container.style.display = "flex";
        container.style.justifyContent = "space-between";
        container.style.alignItems = "center";
        container.style.width = "100%";

        const textSpan = document.createElement("span");
        
        if (listenId) {
          const link = document.createElement("a");
          link.href = `/listen/${encodeURIComponent(listenId)}`;
          link.textContent = artist ? `${title} — ${artist}` : title;
          link.dataset.trackId = listenId;
          if (sourceProvider) {
            link.dataset.sourceProvider = sourceProvider;
          }
          link.style.textDecoration = "none";
          link.addEventListener("click", handleTopSongClick);
          textSpan.appendChild(link);
        } else {
          textSpan.textContent = artist ? `${title} — ${artist}` : title;
        }

        container.appendChild(textSpan);

        if (typeof item.play_count === "number") {
          container.title = `${item.play_count} plays`;
        }

        li.appendChild(container);
        listEl.appendChild(li);
      }
      onRendered?.(renderItems.length);
    } catch (err) {
      if (!append) {
        listEl.textContent = `${errorPrefix} unavailable: ${formatErrorForDisplay(err)}`;
      }
      onRendered?.(0);
    }
  }

  function fetchTopSongsList() {
    return renderSongList({
      listEl: elements.topSongsList,
      fetchItems: () => fetchTopSongs(limit),
      loadingText: "Loading top songs…",
      emptyText: "No plays recorded yet.",
      errorPrefix: "Top songs",
    });
  }

  function fetchAllTimeSongsList(append: boolean = false) {
    if (!append) {
      allTimeOffset = 0;
    }
    const sortBy = elements.allTimeSortSelect.value;
    return renderSongList({
      listEl: elements.allTimeSongsList,
      fetchItems: () => fetchTopSongs(ALL_TIME_LIMIT, sortBy, allTimeOffset),
      loadingText: "Loading all time top songs…",
      emptyText: "No plays recorded yet.",
      errorPrefix: "All time songs",
      overrideLimit: ALL_TIME_LIMIT,
      append,
      onRendered: (count: number) => {
        if (!append && count === 0) {
          elements.allTimeLoadMoreContainer.classList.add("hidden");
        } else {
          elements.allTimeLoadMoreContainer.classList.toggle("hidden", count < ALL_TIME_LIMIT);
        }
      }
    });
  }

  function handleLoadMoreAllTime() {
    allTimeOffset += ALL_TIME_LIMIT;
    fetchAllTimeSongsList(true);
  }

  function fetchRecentSongsList() {
    return renderSongList({
      listEl: elements.recentSongsList,
      fetchItems: () => fetchRecentSongs(limit),
      loadingText: "Loading recent plays…",
      emptyText: "No recent plays yet.",
      errorPrefix: "Recent plays",
    });
  }

  function fetchTrendingSongsList() {
    return renderSongList({
      listEl: elements.trendingSongsList,
      fetchItems: () => fetchTrendingSongs(),
      loadingText: "Loading trending songs…",
      emptyText: "No trending songs yet.",
      errorPrefix: "Trending songs",
    });
  }


  function handleTopSongClick(event: Event) {
    event.preventDefault();
    const target = event.currentTarget as HTMLAnchorElement | null;
    const trackId = target?.dataset.trackId;
    if (!trackId) {
      return;
    }
    navigateToTabWithState("play", { trackId });
    if (isLikelyJobId(trackId)) {
      loadTrackByJobId(trackId);
      return;
    }
    loadTrackById(trackId);
  }

  return {
    fetchTopSongsList,
    fetchTrendingSongsList,
    fetchAllTimeSongsList,
    fetchRecentSongsList,
    handleLoadMoreAllTime,
  };
}