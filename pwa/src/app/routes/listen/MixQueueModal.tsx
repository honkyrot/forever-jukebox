import React from "react";
import { useModalKeyboard } from "@forever-jukebox/shared/ui/useModalKeyboard";
import type { PlayMode } from "@forever-jukebox/shared/constants/playback";
import { useTranslation } from "react-i18next";
import { SymbolIcon } from "@/ui/components/SymbolIcon";
import { useAudioFilePicker, type AudioFileEntry } from "@/ui/components/DropZone";
import type { LocalMixTrack } from "@/app/state/mixQueue";

/**
 * Modal for inspecting, reordering, adding local files to, and mixing from
 * the local mix queue in offline PWA mode.
 */
export function MixQueueModal({
  open,
  tracks,
  activeIndex,
  playMode,
  isMixActive,
  onSelectIndex,
  onMoveItem,
  onRemoveItem,
  onAddFiles,
  onClear,
  onToggleMix,
  onClose,
}: {
  open: boolean;
  tracks: readonly LocalMixTrack[];
  activeIndex: number;
  playMode: PlayMode;
  isMixActive: boolean;
  onSelectIndex: (index: number) => void;
  onMoveItem: (fromIndex: number, toIndex: number) => void;
  onRemoveItem: (index: number) => void;
  onAddFiles: (entries: AudioFileEntry[]) => void;
  onClear: () => void;
  onToggleMix: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = React.useRef<HTMLDivElement>(null);
  useModalKeyboard(panelRef, open, onClose);

  const picker = useAudioFilePicker(
    (file, handle) => onAddFiles([{ file, handle }]),
    undefined,
    { multiple: true, onFiles: onAddFiles },
  );

  if (!open) {
    return null;
  }

  const isCanonizer = playMode === "autocanonizer";
  const isEmpty = tracks.length === 0;
  const canReorder = tracks.length > 1;
  const showMixToggle =
    (playMode === "jukebox" || isCanonizer) &&
    (tracks.length >= 2 || isMixActive);

  return (
    <div
      id="playlist-modal"
      className="modal open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="playlist-modal-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
      />
      <div ref={panelRef} className="modal-panel playlist-panel">
        <div className="modal-header">
          <h2 id="playlist-modal-title">{t("mixQueue.title")}</h2>
          <button
            type="button"
            id="playlist-close"
            className="modal-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            <SymbolIcon className="modal-close-icon" name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div id="playlist-list" className="playlist-list-wrap">
            {isEmpty ? (
              t("mixQueue.none")
            ) : (
              <ol className="playlist-list">
                {tracks.map((track, index) => {
                  const isCurrent = index === activeIndex;
                  const title = track.title || t("common.untitled");
                  return (
                    <li
                      key={track.id}
                      className={
                        isCurrent ? "playlist-item is-current" : "playlist-item"
                      }
                    >
                      <div className="playlist-move-controls">
                        <button
                          type="button"
                          className="playlist-move-btn"
                          disabled={!canReorder || index === 0}
                          aria-label={t("mixQueue.moveUpNamed", { title })}
                          title={t("mixQueue.moveUp")}
                          onClick={() => onMoveItem(index, index - 1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="playlist-move-btn"
                          disabled={!canReorder || index === tracks.length - 1}
                          aria-label={t("mixQueue.moveDownNamed", { title })}
                          title={t("mixQueue.moveDown")}
                          onClick={() => onMoveItem(index, index + 1)}
                        >
                          ↓
                        </button>
                      </div>
                      <button
                        type="button"
                        className="playlist-select"
                        data-playlist-index={index}
                        disabled={isCurrent}
                        onClick={() => {
                          onSelectIndex(index);
                          onClose();
                        }}
                      >
                        <span className="playlist-item-title">{title}</span>
                        <span className="playlist-item-artist">
                          {track.artist || "\u00a0"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="playlist-remove"
                        data-playlist-index={index}
                        disabled={isCurrent}
                        aria-label={t("mixQueue.removeNamed", { title })}
                        title={t("mixQueue.removeNamed", { title })}
                        onClick={() => onRemoveItem(index)}
                      >
                        <SymbolIcon
                          className="playlist-remove-icon"
                          name="close"
                        />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button
            id="playlist-add-files"
            type="button"
            onClick={() => {
              void picker.open();
            }}
          >
            {t("mixQueue.addFiles")}
          </button>
          {showMixToggle ? (
            <button
              id="playlist-mix-toggle"
              type="button"
              onClick={() => {
                onClose();
                onToggleMix();
              }}
            >
              {isMixActive
                ? t("mix.unmixSongs")
                : isCanonizer
                  ? t("mix.mix2Songs")
                  : t("mix.mixSongs")}
            </button>
          ) : null}
          <button
            id="playlist-clear"
            type="button"
            disabled={tracks.length <= 1}
            onClick={onClear}
          >
            {t("mixQueue.clear")}
          </button>
        </div>
        {picker.input}
      </div>
    </div>
  );
}
