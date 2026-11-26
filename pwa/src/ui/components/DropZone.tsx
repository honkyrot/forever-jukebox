import React from "react";
import { useTranslation } from "react-i18next";

// iOS WebKit maps the "audio/*" wildcard to a video UTI, greying out audio files in
// the Files picker, so list explicit MIME types + extensions (webkit.org/b/242110).
const AUDIO_FILE_ACCEPT =
  "audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/flac,audio/x-flac,audio/ogg,audio/opus,audio/webm,audio/aiff,audio/x-aiff,audio/x-ms-wma,audio/x-matroska,audio/amr,.mp3,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus,.webm,.weba,.aiff,.aif,.wma,.mka,.amr";

// The handle is null where the browser can't hand one out (no File System Access).
export type AudioFileHandler = (file: File, handle: FileSystemFileHandle | null) => void;
export type AudioFileEntry = {
  file: File;
  handle: FileSystemFileHandle | null;
};
export type AudioFilesHandler = (entries: AudioFileEntry[]) => void;

function pickerTypes(accept: string) {
  const extensions = accept.split(",").filter((entry) => entry.startsWith("."));
  return [{ accept: { "audio/*": extensions } }];
}

// Opens the File System Access picker where available, so the chosen file(s)
// come with handles; otherwise falls back to the returned hidden input.
export function useAudioFilePicker(
  onFile: AudioFileHandler,
  accept = AUDIO_FILE_ACCEPT,
  options?: {
    multiple?: boolean;
    onFiles?: AudioFilesHandler;
  },
) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const multiple = Boolean(options?.multiple);
  const onFiles = options?.onFiles;

  const dispatchEntries = React.useCallback(
    (entries: AudioFileEntry[]) => {
      if (entries.length === 0) {
        return;
      }
      if (entries.length > 1 && onFiles) {
        onFiles(entries);
        return;
      }
      if (multiple && onFiles) {
        onFiles(entries);
        return;
      }
      onFile(entries[0].file, entries[0].handle);
    },
    [multiple, onFile, onFiles],
  );

  const open = React.useCallback(async () => {
    if (!window.showOpenFilePicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const pickerOptions: OpenFilePickerOptions = {
        types: pickerTypes(accept),
        ...(multiple ? { multiple: true } : {}),
      };
      const handles = await window.showOpenFilePicker(pickerOptions);
      if (handles.length > 0) {
        const entries = await Promise.all(
          handles.map(async (handle) => ({
            file: await handle.getFile(),
            handle,
          })),
        );
        dispatchEntries(entries);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        inputRef.current?.click();
      }
    }
  }, [accept, dispatchEntries, multiple]);

  const input = (
    <input
      ref={inputRef}
      className="drop-zone__input"
      type="file"
      accept={accept}
      multiple={multiple}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) {
          dispatchEntries(files.map((file) => ({ file, handle: null })));
        }
        event.target.value = "";
      }}
    />
  );

  return { open, input };
}

type DropZoneProps = {
  onFile: AudioFileHandler;
  onFiles?: AudioFilesHandler;
  multiple?: boolean;
  accept?: string;
};

export function DropZone({
  onFile,
  onFiles,
  multiple = false,
  accept = AUDIO_FILE_ACCEPT,
}: DropZoneProps) {
  const { t } = useTranslation();
  const [active, setActive] = React.useState(false);
  const picker = useAudioFilePicker(onFile, accept, { multiple, onFiles });

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    const items = Array.from(event.dataTransfer.items ?? []).filter(
      (entry) => entry.kind === "file",
    );
    const hasHandleSupport = items.some(
      (entry) => typeof entry.getAsFileSystemHandle === "function",
    );
    if (!hasHandleSupport) {
      if (files.length > 1 && onFiles) {
        onFiles(files.map((file) => ({ file, handle: null })));
      } else {
        onFile(files[0], null);
      }
      return;
    }

    const targetFiles = multiple || onFiles ? files : [files[0]];
    Promise.all(
      targetFiles.map(async (file, index) => {
        const item = items[index];
        try {
          const handle = await item?.getAsFileSystemHandle?.();
          return {
            file,
            handle:
              handle?.kind === "file"
                ? (handle as FileSystemFileHandle)
                : null,
          };
        } catch {
          return { file, handle: null };
        }
      }),
    )
      .then((entries) => {
        if (entries.length > 1 && onFiles) {
          onFiles(entries);
        } else {
          onFile(entries[0].file, entries[0].handle);
        }
      })
      .catch(() => {
        if (targetFiles.length > 1 && onFiles) {
          onFiles(targetFiles.map((file) => ({ file, handle: null })));
        } else {
          onFile(targetFiles[0], null);
        }
      });
  };

  const onDrag = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActive(true);
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActive(false);
  };

  return (
    <div className={`drop-zone ${active ? "is-active" : ""}`} onDrop={onDrop} onDragOver={onDrag} onDragLeave={onDragLeave}>
      <div className="drop-zone__content">
        <p className="drop-zone__title">{t("home.dropFile")}</p>
        <p className="drop-zone__sub">{t("common.or")}</p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            void picker.open();
          }}
        >
          {t("home.chooseFile")}
        </button>
      </div>
      {picker.input}
    </div>
  );
}
