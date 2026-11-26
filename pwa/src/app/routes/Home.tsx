import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CachedAnalysisTrack,
  deleteCachedAnalysis,
  listCachedAnalysisTracks,
} from "@/core/infrastructure/cache/analysisCache";
import {
  deleteFileHandle,
  getFileHandle,
  readFileFromHandle,
  setFileHandle,
} from "@/core/infrastructure/cache/fileHandleStore";
import { computeFingerprint } from "@/shared/utils/fingerprint";
import { formatDuration } from "@forever-jukebox/shared/ui/format";
import {
  DropZone,
  useAudioFilePicker,
  type AudioFileEntry,
} from "@/ui/components/DropZone";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { createLocalMixTrackFromFile } from "../state/mixQueue";
import { useAppState } from "../state/AppState";
import { useTranslation } from "react-i18next";

export function Home() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const appState = useAppState();
  const { setFile } = appState;
  const mixQueue = appState.mixQueue ?? [];
  const mixAddSticky = Boolean(appState.mixAddSticky);
  const setMixAddSticky = appState.setMixAddSticky;
  const addToMixQueue = appState.addToMixQueue;
  const addFilesToMixQueue = appState.addFilesToMixQueue;
  const clearMixQueue = appState.clearMixQueue;

  const [cachedTracks, setCachedTracks] = useState<CachedAnalysisTrack[]>([]);
  const [isLoadingCachedTracks, setIsLoadingCachedTracks] = useState(false);
  const [deletingFingerprint, setDeletingFingerprint] = useState<string | null>(null);
  const [cachedTrackError, setCachedTrackError] = useState<string | null>(null);
  const [reopenFailed, setReopenFailed] = useState(false);
  const isReopeningRef = useRef(false);
  const pendingAddTargetRef = useRef<CachedAnalysisTrack | null>(null);

  const handleFile = useCallback(
    (file: File, handle: FileSystemFileHandle | null) => {
      setReopenFailed(false);
      if (pendingAddTargetRef.current && addToMixQueue) {
        const target = pendingAddTargetRef.current;
        pendingAddTargetRef.current = null;
        if (handle) {
          setFileHandle(target.fingerprint, handle).catch((err: unknown) => {
            console.warn(`File handle save failed: ${String(err)}`);
          });
        }
        addToMixQueue(
          createLocalMixTrackFromFile(file, handle, {
            fingerprint: target.fingerprint,
            title: target.title,
            artist: target.artist,
            durationSeconds: target.durationSeconds,
          }),
        );
        return;
      }
      setMixAddSticky?.(false);
      setFile(file, handle);
      navigate("/listen");
    },
    [addToMixQueue, navigate, setFile, setMixAddSticky],
  );

  const handleFiles = useCallback(
    (entries: AudioFileEntry[]) => {
      setReopenFailed(false);
      pendingAddTargetRef.current = null;
      setMixAddSticky?.(false);
      if (entries.length === 1) {
        setFile(entries[0].file, entries[0].handle);
        navigate("/listen");
        return;
      }
      if (addFilesToMixQueue) {
        addFilesToMixQueue(entries, { activateFirst: true });
      } else if (entries[0]) {
        setFile(entries[0].file, entries[0].handle);
      }
      navigate("/listen");
    },
    [addFilesToMixQueue, navigate, setFile, setMixAddSticky],
  );

  const { open: openCachedTrackPicker, input: cachedTrackPickerInput } =
    useAudioFilePicker(handleFile);

  // Reopens the track's file through its stored handle; without one, or when
  // the browser can't reach the file, asks the user to pick it.
  const reopenCachedTrack = useCallback(
    async (
      track: CachedAnalysisTrack,
      action: "open" | "queue",
    ) => {
      setReopenFailed(false);
      const handle = await getFileHandle(track.fingerprint).catch(() => null);
      const file = handle ? await readFileFromHandle(handle) : null;
      // Reading the file's head can still fail if it moved since getFile().
      const fileFingerprint = file
        ? await computeFingerprint(file).catch(() => null)
        : null;
      if (handle && file && fileFingerprint) {
        // An edited file fingerprints differently, so this row's handle no
        // longer leads back to its analysis; the file plays as a new track.
        if (fileFingerprint !== track.fingerprint) {
          deleteFileHandle(track.fingerprint).catch((err: unknown) => {
            console.warn(`File handle delete failed: ${String(err)}`);
          });
        }
        if (action === "queue" && addToMixQueue) {
          addToMixQueue(
            createLocalMixTrackFromFile(file, handle, {
              fingerprint:
                fileFingerprint === track.fingerprint
                  ? track.fingerprint
                  : fileFingerprint,
              title: track.title,
              artist: track.artist,
              durationSeconds: track.durationSeconds,
            }),
          );
          return;
        }
        pendingAddTargetRef.current = null;
        handleFile(file, handle);
        return;
      }
      // A permission prompt can outlast the click's user activation, which
      // the picker needs to open.
      if (navigator.userActivation?.isActive === false) {
        setReopenFailed(true);
        return;
      }
      pendingAddTargetRef.current = action === "queue" ? track : null;
      await openCachedTrackPicker();
    },
    [addToMixQueue, handleFile, openCachedTrackPicker],
  );

  const handleOpenCachedTrack = useCallback(
    async (track: CachedAnalysisTrack) => {
      // Ignores clicks while a reopen is still waiting on storage, a permission
      // prompt or the picker.
      if (isReopeningRef.current) {
        return;
      }
      isReopeningRef.current = true;
      try {
        await reopenCachedTrack(track, "open");
      } finally {
        isReopeningRef.current = false;
      }
    },
    [reopenCachedTrack],
  );

  const handleQueueCachedTrack = useCallback(
    async (track: CachedAnalysisTrack) => {
      if (isReopeningRef.current) {
        return;
      }
      isReopeningRef.current = true;
      try {
        await reopenCachedTrack(track, "queue");
      } finally {
        isReopeningRef.current = false;
      }
    },
    [reopenCachedTrack],
  );

  const refreshCachedTracks = useCallback(async () => {
    setIsLoadingCachedTracks(true);
    setCachedTrackError(null);
    try {
      const tracks = await listCachedAnalysisTracks();
      setCachedTracks(tracks);
    } catch {
      setCachedTrackError(t("home.loadFailed"));
      setCachedTracks([]);
    } finally {
      setIsLoadingCachedTracks(false);
    }
  }, [t]);

  useEffect(() => {
    if (location.pathname !== "/") {
      return;
    }
    refreshCachedTracks().catch((err) => {
      console.warn(`Failed to refresh cached tracks: ${String(err)}`);
    });
  }, [location.pathname, refreshCachedTracks]);

  const onDeleteCachedTrack = useCallback(async (fingerprint: string) => {
    setDeletingFingerprint(fingerprint);
    setCachedTrackError(null);
    try {
      await deleteCachedAnalysis(fingerprint);
      setCachedTracks((prev) => prev.filter((track) => track.fingerprint !== fingerprint));
    } catch {
      setCachedTrackError(t("home.deleteFailed"));
    } finally {
      setDeletingFingerprint((current) => (current === fingerprint ? null : current));
    }
  }, [t]);

  const handleDeleteCachedTrack = useCallback(
    (fingerprint: string) => {
      onDeleteCachedTrack(fingerprint).catch((err) => {
        console.warn(`Failed to delete cached analysis: ${String(err)}`);
      });
    },
    [onDeleteCachedTrack],
  );

  return (
    <section className="panel home-panel">
      <DropZone multiple onFile={handleFile} onFiles={handleFiles} />
      {mixQueue.length > 0 ? (
        <div className="home-mix-queue" id="home-mix-queue">
          <div className="home-mix-queue__info">
            <span className="home-mix-queue__count">
              {t("mixQueue.summary", { count: mixQueue.length })}
            </span>
            <span className="home-mix-queue__names">
              {mixQueue.map((item) => item.title).join(" × ")}
            </span>
          </div>
          <div className="home-mix-queue__actions">
            <button
              type="button"
              className="tab-btn"
              onClick={() => {
                setMixAddSticky?.(false);
                navigate("/listen");
              }}
            >
              {t("mixQueue.openListen")}
            </button>
            {clearMixQueue ? (
              <button
                type="button"
                className="tab-btn"
                onClick={() => clearMixQueue()}
              >
                {t("mixQueue.clear")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className={`cached-tracks ${mixAddSticky ? "is-add-sticky" : ""}`}>
        <h2 className="cached-tracks__title">
          <span>{t("home.cachedAnalysis")}</span>
          <span className="cached-tracks__title-hint">
            {mixAddSticky ? t("mixQueue.pickSongsHint") : t("home.cachedHint")}
          </span>
        </h2>
        {reopenFailed ? <p>{t("home.reopenFailed")}</p> : null}
        {isLoadingCachedTracks ? <p>{t("home.loadingCached")}</p> : null}
        {!isLoadingCachedTracks && cachedTrackError ? (
          <p>{cachedTrackError}</p>
        ) : null}
        {!isLoadingCachedTracks && !cachedTrackError && cachedTracks.length === 0 ? (
          <p>{t("home.noCached")}</p>
        ) : null}
        {!isLoadingCachedTracks && !cachedTrackError && cachedTracks.length > 0 ? (
          <ul className="cached-tracks__list">
            {cachedTracks.map((track) => {
              const title =
                track.title ??
                t("home.cachedTrack", {
                  id: track.fingerprint.slice(0, 8),
                });
              const label = track.artist
                ? `${title} — ${track.artist}`
                : title;
              const details = track.durationSeconds
                ? formatDuration(Math.round(track.durationSeconds))
                : null;
              const isDeleting = deletingFingerprint === track.fingerprint;
              const isQueued = mixQueue.some(
                (item) =>
                  item.fingerprint === track.fingerprint ||
                  item.id === track.fingerprint,
              );

              return (
                <li key={track.fingerprint} className="cached-tracks__item">
                  <button
                    className="cached-tracks__content"
                    type="button"
                    onClick={() => {
                      handleOpenCachedTrack(track).catch((err) => {
                        console.warn(`Failed to open cached track: ${String(err)}`);
                      });
                    }}
                  >
                    <span className="cached-tracks__name" title={label}>
                      {label}
                    </span>
                    {details ? (
                      <span className="cached-tracks__meta">{details}</span>
                    ) : null}
                  </button>
                  {typeof addToMixQueue === "function" ? (
                    <button
                      className={`cached-tracks__add ${isQueued ? "is-queued" : ""}`}
                      type="button"
                      onClick={() => {
                        handleQueueCachedTrack(track).catch((err) => {
                          console.warn(`Failed to queue cached track: ${String(err)}`);
                        });
                      }}
                      aria-label={t("mixQueue.addNamed", { label })}
                      title={
                        isQueued
                          ? t("mixQueue.alreadyQueued")
                          : t("mixQueue.addTitle")
                      }
                    >
                      {isQueued ? "✓" : "+"}
                    </button>
                  ) : null}
                  <button
                    className="cached-tracks__delete"
                    type="button"
                    onClick={() => handleDeleteCachedTrack(track.fingerprint)}
                    disabled={isDeleting}
                    aria-label={t("home.deleteNamed", { label })}
                    title={t("home.deleteTitle")}
                  >
                    <SymbolIcon className="cached-tracks__delete-icon" name="close" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {cachedTrackPickerInput}
    </section>
  );
}
