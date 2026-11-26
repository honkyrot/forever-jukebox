import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { isAdminMode } from "../../admin";
import { reportTrack, type TrackReportReason } from "../../api";
import { isFavoriteTuningDrifted } from "../../favorite-drift";
import { findCurrentFavorite } from "../../favorites";
import { formatPlaybackTitle } from "../../format";
import { useMarquee } from "../../hooks/useMarquee";
import { openInfo, openTuning } from "../../playback";
import { getAppContext } from "../../runtime";
import { useAppStore } from "../../store";
import {
  getPendingDelete,
  performDelete,
  type PendingDelete,
} from "../../delete-job";
import {
  getPendingRename,
  performRename,
  type PendingRename,
} from "../../rename-job";
import { toggleFavorite } from "../../favorites-actions";
import { copyShortUrl } from "../../playback-ui";
import { showToast } from "../../ui";
import { Modal, ModalHeader } from "../Modal";
import { useTranslation } from "react-i18next";

function DeleteConfirmModal({
  pending,
  onClosed,
}: {
  pending: PendingDelete | null;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.deleteConfirmOpen);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  const close = () => {
    if (busy) {
      return;
    }
    useAppStore.setState({ deleteConfirmOpen: false });
    onClosed();
  };

  const confirm = async () => {
    if (busy || !pending) {
      return;
    }
    // `pending` was frozen at modal-open; if the active track changed
    // underneath us (e.g. autocanonizer playlist auto-advance) the frozen job
    // no longer matches the current session. Re-read and bail rather than
    // delete the right job but reset/navigate the wrong session.
    const current = getPendingDelete();
    if (current?.jobId !== pending.jobId) {
      useAppStore.setState({ deleteConfirmOpen: false });
      onClosed();
      return;
    }
    setBusy(true);
    try {
      await performDelete(current);
    } finally {
      setBusy(false);
      useAppStore.setState({ deleteConfirmOpen: false });
      onClosed();
    }
  };

  return (
    <Modal
      id="delete-confirm-modal"
      open={open}
      onClose={close}
      panelClassName="delete-confirm-panel"
    >
      <div className="modal-header">
        <h2 id="delete-confirm-title">{t("delete.trackQuestion")}</h2>
      </div>
      <div className="modal-footer">
        <button
          id="delete-confirm-cancel"
          type="button"
          ref={cancelRef}
          disabled={busy}
          onClick={close}
        >
          {t("common.cancel")}
        </button>
        <button
          id="delete-confirm-delete"
          className={busy ? "danger-button is-loading" : "danger-button"}
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void confirm()}
        >
          {t("common.delete")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Admin modal for overriding a track's stored title and artist.
 */
function RenameTrackModal({
  pending,
  onClosed,
}: {
  pending: PendingRename | null;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.renameModalOpen);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [busy, setBusy] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(pending?.title ?? "");
      setArtist(pending?.artist ?? "");
      titleInputRef.current?.focus();
    }
  }, [open, pending]);

  const close = () => {
    if (busy) {
      return;
    }
    useAppStore.setState({ renameModalOpen: false });
    onClosed();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (busy || !pending || !trimmedTitle) {
      return;
    }
    // Re-read live job state to bail out if another track loaded underneath the modal.
    const current = getPendingRename();
    if (current?.jobId !== pending.jobId) {
      useAppStore.setState({ renameModalOpen: false });
      onClosed();
      return;
    }
    setBusy(true);
    let ok = false;
    try {
      ok = await performRename(current, {
        title: trimmedTitle,
        artist: artist.trim(),
      });
    } finally {
      setBusy(false);
    }
    if (ok) {
      useAppStore.setState({ renameModalOpen: false });
      onClosed();
    }
  };

  return (
    <Modal
      id="rename-track-modal"
      open={open}
      onClose={close}
      panelClassName="rename-track-panel"
    >
      <ModalHeader
        title={t("rename.title")}
        closeId="rename-track-close"
        onClose={close}
      />
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="modal-body rename-track-fields">
          <label className="rename-track-field">
            <span>{t("rename.titleLabel")}</span>
            <input
              id="rename-track-title"
              ref={titleInputRef}
              className="search-input"
              type="text"
              autoComplete="off"
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="rename-track-field">
            <span>{t("rename.artistLabel")}</span>
            <input
              id="rename-track-artist"
              className="search-input"
              type="text"
              autoComplete="off"
              value={artist}
              disabled={busy}
              onChange={(event) => setArtist(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button
            id="rename-track-cancel"
            type="button"
            disabled={busy}
            onClick={close}
          >
            {t("common.cancel")}
          </button>
          <button
            id="rename-track-submit"
            className={busy ? "is-loading" : undefined}
            type="submit"
            disabled={busy || !title.trim()}
            aria-busy={busy}
          >
            {t("rename.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const TRACK_REPORT_REASONS: TrackReportReason[] = [
  "wrong_track",
  "bad_audio",
  "other",
];

function ReportTrackModal({
  jobId,
  onClose,
}: {
  jobId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<TrackReportReason | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) {
      return;
    }
    setReason(null);
    onClose();
  };

  const submit = async () => {
    if (busy || !jobId || !reason) {
      return;
    }
    setBusy(true);
    try {
      await reportTrack(jobId, reason);
      showToast(t("report.reported"), { icon: "flag" });
    } catch {
      showToast(t("report.failed"), { tone: "error" });
    } finally {
      setBusy(false);
      setReason(null);
      onClose();
    }
  };

  return (
    <Modal
      id="report-track-modal"
      open={jobId !== null}
      onClose={close}
      panelClassName="report-track-panel"
    >
      <ModalHeader
        title={t("report.title")}
        closeId="report-track-close"
        onClose={close}
      />
      <div className="modal-body report-reasons" role="radiogroup">
        {TRACK_REPORT_REASONS.map((value) => (
          <label key={value} className="report-reason">
            <input
              type="radio"
              name="report-reason"
              value={value}
              checked={reason === value}
              disabled={busy}
              onChange={() => setReason(value)}
            />
            <span>{t(`report.reasons.${value}`)}</span>
          </label>
        ))}
      </div>
      <div className="modal-footer">
        <button
          id="report-track-cancel"
          type="button"
          disabled={busy}
          onClick={close}
        >
          {t("common.cancel")}
        </button>
        <button
          id="report-track-submit"
          className={busy ? "danger-button is-loading" : "danger-button"}
          type="button"
          disabled={busy || !reason}
          aria-busy={busy}
          onClick={() => void submit()}
        >
          {t("report.button")}
        </button>
      </div>
    </Modal>
  );
}

export function PlayMenu() {
  const { t } = useTranslation();
  const audioLoaded = useAppStore((s) => s.audioLoaded);
  const analysisLoaded = useAppStore((s) => s.analysisLoaded);
  const audioModePreparing = useAppStore((s) => s.audioModePreparing);
  const loadingShown = useAppStore((s) => s.loadingShown);
  const playMode = useAppStore((s) => s.playMode);
  const audioMode = useAppStore((s) => s.jukeboxAudioMode);
  const trackTitle = useAppStore((s) => s.trackTitle);
  const trackArtist = useAppStore((s) => s.trackArtist);
  const bringItHomeMode = useAppStore((s) => s.bringItHomeMode);
  const deleteEligible = useAppStore((s) => s.deleteEligible);
  const favorites = useAppStore((s) => s.favorites);
  const lastTrackId = useAppStore((s) => s.lastTrackId);
  const lastJobId = useAppStore((s) => s.lastJobId);
  const allowTrackReports = useAppStore((s) =>
    Boolean(s.appConfig?.allow_track_reports),
  );
  const lastSourceId = useAppStore((s) => s.lastSourceId);
  const lastSourceProvider = useAppStore((s) => s.lastSourceProvider);
  const favoriteToggleBusy = useAppStore((s) => s.favoriteToggleBusy);
  const tuningParams = useAppStore((s) => s.tuningParams);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(
    null,
  );
  const [reportJobId, setReportJobId] = useState<string | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const reportButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);

  const hidden = !(audioLoaded && analysisLoaded) || audioModePreparing || loadingShown;
  // Tuning and track info describe the jukebox graph.
  const hideJukeboxTools = playMode !== "jukebox";
  const adminMode = isAdminMode();
  const displayTitle =
    trackTitle || trackArtist
      ? (() => {
          const withSuffix = formatPlaybackTitle(
            trackTitle ?? t("common.unknown"),
            playMode,
            audioMode,
          );
          return trackArtist ? `${withSuffix} — ${trackArtist}` : withSuffix;
        })()
      : "";
  useMarquee(titleRef, displayTitle);

  const currentFavorite = useMemo(
    () =>
      findCurrentFavorite(favorites, {
        lastTrackId,
        lastJobId,
        lastSourceId,
        lastSourceProvider,
      }),
    [favorites, lastTrackId, lastJobId, lastSourceId, lastSourceProvider],
  );
  const favoriteActive = Boolean(currentFavorite);
  const favoriteDrifted = useMemo(() => {
    // Bail before touching the runtime context so render is safe when the
    // app context is not initialized yet.
    if (!currentFavorite || !analysisLoaded) {
      return false;
    }
    return isFavoriteTuningDrifted({
      favorite: currentFavorite,
      ready: analysisLoaded,
      livePlayMode: playMode,
      liveTuningParams: tuningParams,
      defaults: getAppContext().defaultConfig,
    });
  }, [currentFavorite, analysisLoaded, playMode, tuningParams]);
  const favoriteToggleLabel = favoriteActive
    ? t("playback.removeFavorite")
    : t("playback.addFavorite");
  const favoriteLabel = favoriteDrifted
    ? t("playback.updateFavorite")
    : favoriteToggleLabel;
  const deleteLabel = adminMode
    ? t("delete.track")
    : t("delete.withinWindow");

  const handleDeleteClick = () => {
    const pending = getPendingDelete();
    if (!pending) {
      return;
    }
    setPendingDelete(pending);
    useAppStore.setState({ deleteConfirmOpen: true });
  };

  const handleRenameClick = () => {
    const pending = getPendingRename();
    if (!pending) {
      return;
    }
    setPendingRename(pending);
    useAppStore.setState({ renameModalOpen: true });
  };

  return (
    <>
      <div
        className={hidden ? "menu-bar hidden" : "menu-bar"}
        id="play-menu"
      >
        <div className="menu-left">
          <div className="play-title" id="play-title" ref={titleRef}></div>
          <span
            id="bring-home-label"
            className={
              playMode === "jukebox" && bringItHomeMode
                ? "bring-home-note"
                : "bring-home-note is-hidden"
            }
          >
            {t("playback.bringingHome")}
          </span>
        </div>
        <div className="menu-right">
          <button
            type="button"
            id="rename-job"
            ref={renameButtonRef}
            className={
              adminMode && lastJobId ? "rename-toggle" : "rename-toggle hidden"
            }
            aria-label={t("rename.track")}
            title={t("rename.track")}
            onClick={handleRenameClick}
          >
            <span
              className="material-symbols-outlined rename-icon"
              aria-hidden="true"
            >
              edit
            </span>
          </button>
          <button
            type="button"
            id="delete-job"
            ref={deleteButtonRef}
            className={
              deleteEligible || adminMode
                ? "delete-toggle"
                : "delete-toggle hidden"
            }
            aria-label={deleteLabel}
            title={deleteLabel}
            onClick={handleDeleteClick}
          >
            <span
              className="material-symbols-outlined delete-icon"
              aria-hidden="true"
            >
              delete
            </span>
          </button>
          <button
            type="button"
            id="report-track"
            ref={reportButtonRef}
            className={
              deleteEligible || adminMode || !lastJobId || !allowTrackReports
                ? "report-toggle hidden"
                : "report-toggle"
            }
            aria-label={t("report.title")}
            title={t("report.title")}
            onClick={() => setReportJobId(lastJobId)}
          >
            <span
              className="material-symbols-outlined report-icon"
              aria-hidden="true"
            >
              flag
            </span>
          </button>
          <button
            type="button"
            id="tuning"
            className={hideJukeboxTools ? "tune-toggle is-hidden" : "tune-toggle"}
            disabled={hideJukeboxTools}
            aria-label={t("playback.tune")}
            title={t("playback.tune")}
            onClick={() => openTuning(getAppContext())}
          >
            <span
              className="material-symbols-outlined tune-icon"
              aria-hidden="true"
            >
              tune
            </span>
          </button>
          <button
            type="button"
            id="track-info"
            className={hideJukeboxTools ? "info-toggle is-hidden" : "info-toggle"}
            aria-label={t("playback.info")}
            title={t("playback.info")}
            onClick={() => openInfo(getAppContext())}
          >
            <span
              className="material-symbols-outlined info-icon"
              aria-hidden="true"
            >
              info
            </span>
          </button>
          <button
            type="button"
            id="short-url"
            className="copy-toggle"
            aria-label={t("playback.copyUrl")}
            title={t("playback.copyUrl")}
            onClick={() => copyShortUrl()}
          >
            <span
              className="material-symbols-outlined copy-icon"
              aria-hidden="true"
            >
              share
            </span>
          </button>
          <button
            type="button"
            id="favorite-toggle"
            className={
              `favorite-toggle${favoriteActive ? " active" : ""}` +
              `${favoriteToggleBusy ? " is-loading" : ""}`
            }
            disabled={favoriteToggleBusy}
            aria-busy={favoriteToggleBusy}
            aria-label={favoriteLabel}
            title={favoriteLabel}
            onClick={() => toggleFavorite()}
          >
            <span
              className="material-symbols-outlined favorite-icon"
              aria-hidden="true"
            >
              star
            </span>
            {favoriteDrifted ? (
              <span className="favorite-dot" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      </div>
      <DeleteConfirmModal
        pending={pendingDelete}
        onClosed={() => {
          setPendingDelete(null);
          deleteButtonRef.current?.focus();
        }}
      />
      <RenameTrackModal
        pending={pendingRename}
        onClosed={() => {
          setPendingRename(null);
          renameButtonRef.current?.focus();
        }}
      />
      <ReportTrackModal
        jobId={reportJobId}
        onClose={() => {
          setReportJobId(null);
          reportButtonRef.current?.focus();
        }}
      />
    </>
  );
}
