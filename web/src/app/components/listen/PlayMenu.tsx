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
import {
  BPM_MULTIPLIER_OPTIONS,
  estimateReanalyzedBpm,
  getPendingReanalyze,
  performReanalyze,
  type BpmMultiplier,
  type PendingReanalyze,
} from "../../reanalyze-job";
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

/**
 * Modal for server-side 0.5x / 1x / 2x BPM reanalysis and optional admin locking.
 */
function ReanalyzeBpmModal({
  pending,
  adminMode,
  onClosed,
}: {
  pending: PendingReanalyze | null;
  adminMode: boolean;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.reanalyzeModalOpen);
  const [multiplier, setMultiplier] = useState<BpmMultiplier>(1);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setMultiplier(pending?.currentMultiplier ?? 1);
      setLocked(pending?.bpmLocked ?? false);
    }
  }, [open, pending]);

  const close = () => {
    if (busy) {
      return;
    }
    useAppStore.setState({ reanalyzeModalOpen: false });
    onClosed();
  };

  const isLockedForUser = !adminMode && locked;
  const multiplierChanged = pending ? multiplier !== pending.currentMultiplier : false;
  const lockChanged = adminMode && pending ? locked !== pending.bpmLocked : false;
  const canSubmit = !busy && !isLockedForUser && (multiplierChanged || lockChanged);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !pending) {
      return;
    }
    const current = getPendingReanalyze();
    if (current?.jobId !== pending.jobId) {
      useAppStore.setState({ reanalyzeModalOpen: false });
      onClosed();
      return;
    }
    setBusy(true);
    let ok = false;
    try {
      ok = await performReanalyze(getAppContext(), current, {
        bpmMultiplier: multiplierChanged ? multiplier : undefined,
        bpmLocked: lockChanged ? locked : undefined,
      });
    } finally {
      setBusy(false);
    }
    if (ok) {
      useAppStore.setState({ reanalyzeModalOpen: false });
      onClosed();
    }
  };

  const currentBpmText =
    pending?.currentTempoBpm !== null && pending?.currentTempoBpm !== undefined
      ? t("reanalyze.currentBpmValue", {
          bpm: Math.round(pending.currentTempoBpm),
          multiplier: `${pending.currentMultiplier}x`,
        })
      : `${pending?.currentMultiplier ?? 1}x`;

  return (
    <Modal
      id="reanalyze-bpm-modal"
      open={open}
      onClose={close}
      panelClassName="reanalyze-bpm-panel"
    >
      <ModalHeader
        title={t("reanalyze.title")}
        closeId="reanalyze-bpm-close"
        onClose={close}
      />
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="modal-body reanalyze-bpm-body">
          <p className="hint reanalyze-bpm-description">
            {t("reanalyze.description")}
          </p>
          <div className="reanalyze-bpm-current">
            <span>{t("reanalyze.currentBpmLabel")}</span>
            <strong id="reanalyze-current-bpm">{currentBpmText}</strong>
          </div>
          {isLockedForUser ? (
            <p id="reanalyze-locked-notice" className="reanalyze-locked-notice">
              {t("reanalyze.lockedNotice")}
            </p>
          ) : null}
          <div
            className="reanalyze-bpm-options"
            role="radiogroup"
            aria-label={t("reanalyze.multiplierLabel")}
          >
            {BPM_MULTIPLIER_OPTIONS.map((option) => {
              const estimated = estimateReanalyzedBpm(
                pending?.currentTempoBpm ?? null,
                pending?.currentMultiplier ?? 1,
                option,
              );
              const labelKey =
                option === 0.5
                  ? "reanalyze.halfBpm"
                  : option === 2
                    ? "reanalyze.doubleBpm"
                    : "reanalyze.originalBpm";
              return (
                <label key={option} className="reanalyze-bpm-option">
                  <input
                    id={`reanalyze-multiplier-${String(option).replace(".", "_")}`}
                    type="radio"
                    name="reanalyze-bpm-multiplier"
                    value={String(option)}
                    checked={multiplier === option}
                    disabled={busy || isLockedForUser}
                    onChange={() => setMultiplier(option)}
                  />
                  <span>{t(labelKey)}</span>
                  {estimated !== null ? (
                    <span className="hint reanalyze-bpm-estimate">
                      {t("reanalyze.estimatedBpm", { bpm: estimated })}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
          {adminMode ? (
            <label className="reanalyze-bpm-lock">
              <input
                id="reanalyze-bpm-lock"
                type="checkbox"
                checked={locked}
                disabled={busy}
                onChange={(event) => setLocked(event.target.checked)}
              />
              <span>{t("reanalyze.adminLockLabel")}</span>
            </label>
          ) : null}
        </div>
        <div className="modal-footer">
          <button
            id="reanalyze-bpm-cancel"
            type="button"
            disabled={busy}
            onClick={close}
          >
            {t("common.cancel")}
          </button>
          <button
            id="reanalyze-bpm-submit"
            className={busy ? "is-loading" : undefined}
            type="submit"
            disabled={!canSubmit}
            aria-busy={busy}
          >
            {!multiplierChanged && lockChanged
              ? t("reanalyze.saveLock")
              : t("reanalyze.submit")}
          </button>
        </div>
      </form>
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
  const reanalyzeAdminOnly = useAppStore((s) =>
    Boolean(s.appConfig?.reanalyze_admin_only),
  );
  const trackBpmMultiplier = useAppStore((s) => s.trackBpmMultiplier);
  const trackBpmLocked = useAppStore((s) => s.trackBpmLocked);
  const multiTrackEnabled = useAppStore((s) => s.multiTrackEnabled);
  const autocanonizerMixEnabled = useAppStore((s) => s.autocanonizerMixEnabled);
  const songSyncEnabled = useAppStore((s) => s.songSyncEnabled);
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
  const [pendingReanalyze, setPendingReanalyze] =
    useState<PendingReanalyze | null>(null);
  const [reportJobId, setReportJobId] = useState<string | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const reanalyzeButtonRef = useRef<HTMLButtonElement | null>(null);
  const reportButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);

  const hidden = !(audioLoaded && analysisLoaded) || audioModePreparing || loadingShown;
  // Tuning exposes mode-specific controls across Jukebox, Autocanonizer, and Song Sync;
  // Track Info describes the Jukebox branch graph.
  const hideTuning = playMode === "wubmachine";
  const hideTrackInfo = playMode !== "jukebox";
  const adminMode = isAdminMode();
  const hideReanalyze =
    !lastJobId ||
    multiTrackEnabled ||
    autocanonizerMixEnabled ||
    songSyncEnabled ||
    (reanalyzeAdminOnly && !adminMode);
  const reanalyzeTitle = trackBpmLocked
    ? t("reanalyze.buttonLockedTitle")
    : trackBpmMultiplier !== 1
      ? t("reanalyze.buttonActiveTitle", {
          multiplier: `${trackBpmMultiplier}x`,
        })
      : t("reanalyze.buttonTitle");
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

  const handleReanalyzeClick = () => {
    const pending = getPendingReanalyze();
    if (!pending) {
      return;
    }
    setPendingReanalyze(pending);
    useAppStore.setState({ reanalyzeModalOpen: true });
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
            id="reanalyze-bpm"
            ref={reanalyzeButtonRef}
            className={
              hideReanalyze
                ? "reanalyze-toggle hidden"
                : trackBpmLocked
                  ? "reanalyze-toggle is-locked"
                  : trackBpmMultiplier !== 1
                    ? "reanalyze-toggle is-scaled"
                    : "reanalyze-toggle"
            }
            aria-label={reanalyzeTitle}
            title={reanalyzeTitle}
            onClick={handleReanalyzeClick}
          >
            <span
              className="material-symbols-outlined reanalyze-icon"
              aria-hidden="true"
            >
              speed
            </span>
          </button>
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
            className={hideTuning ? "tune-toggle is-hidden" : "tune-toggle"}
            disabled={hideTuning}
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
            className={hideTrackInfo ? "info-toggle is-hidden" : "info-toggle"}
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
      <ReanalyzeBpmModal
        pending={pendingReanalyze}
        adminMode={adminMode}
        onClosed={() => {
          setPendingReanalyze(null);
          reanalyzeButtonRef.current?.focus();
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
