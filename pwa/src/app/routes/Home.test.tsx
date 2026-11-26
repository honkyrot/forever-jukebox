import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../i18n";
import { Home } from "./Home";
import {
  deleteFileHandle,
  getFileHandle,
  readFileFromHandle,
} from "@/core/infrastructure/cache/fileHandleStore";
import { computeFingerprint } from "@/shared/utils/fingerprint";

const appState = vi.hoisted(() => ({
  setFile: vi.fn(),
  mixQueue: [] as Array<{ id: string; title: string; fingerprint?: string | null }>,
  mixAddSticky: false,
  setMixAddSticky: vi.fn(),
  addToMixQueue: vi.fn(),
  addFilesToMixQueue: vi.fn(),
  clearMixQueue: vi.fn(),
}));
vi.mock("../state/AppState", () => ({ useAppState: () => appState }));

vi.mock("@/core/infrastructure/cache/analysisCache", () => ({
  deleteCachedAnalysis: vi.fn(async () => {}),
  listCachedAnalysisTracks: vi.fn(async () => [
    {
      fingerprint: "fp-1",
      title: "Song",
      artist: "Band",
      durationSeconds: 90,
      updatedAtEpochMs: null,
    },
  ]),
}));

vi.mock("@/core/infrastructure/cache/fileHandleStore", () => ({
  deleteFileHandle: vi.fn(async () => {}),
  getFileHandle: vi.fn(),
  readFileFromHandle: vi.fn(),
}));

vi.mock("@/shared/utils/fingerprint", () => ({
  computeFingerprint: vi.fn(),
}));

const song = new File([new Uint8Array([1])], "song.mp3");
const handle = { kind: "file", name: "song.mp3" } as FileSystemFileHandle;

async function renderHome() {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/listen" element={<div>Listen page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.findByRole("button", { name: /^Song — Band/ });
}

async function clickRow(row: HTMLElement) {
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Home cached tracks", () => {
  let inputClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    appState.setFile.mockReset();
    appState.mixQueue = [];
    appState.mixAddSticky = false;
    appState.setMixAddSticky.mockReset();
    appState.addToMixQueue.mockReset();
    appState.addFilesToMixQueue.mockReset();
    appState.clearMixQueue.mockReset();
    vi.mocked(getFileHandle).mockReset().mockResolvedValue(null);
    vi.mocked(readFileFromHandle).mockReset().mockResolvedValue(null);
    vi.mocked(deleteFileHandle).mockClear();
    vi.mocked(computeFingerprint).mockReset().mockResolvedValue("fp-1");
    inputClick = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    inputClick.mockRestore();
    Reflect.deleteProperty(navigator, "userActivation");
    cleanup();
  });

  it("plays a cached track straight from its stored file handle", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    vi.mocked(readFileFromHandle).mockResolvedValue(song);

    await clickRow(await renderHome());

    expect(getFileHandle).toHaveBeenCalledWith("fp-1");
    expect(appState.setFile).toHaveBeenCalledWith(song, handle);
    expect(screen.getByText("Listen page")).toBeTruthy();
    expect(inputClick).not.toHaveBeenCalled();
    expect(deleteFileHandle).not.toHaveBeenCalled();
  });

  it("ignores a second click while the first reopen is pending", async () => {
    let grantAccess: (file: File) => void = () => undefined;
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    vi.mocked(readFileFromHandle).mockReturnValue(
      new Promise((resolve) => {
        grantAccess = resolve;
      }),
    );
    const row = await renderHome();

    await clickRow(row);
    await clickRow(row);
    await act(async () => {
      grantAccess(song);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getFileHandle).toHaveBeenCalledTimes(1);
    expect(appState.setFile).toHaveBeenCalledTimes(1);
  });

  it("drops the row's handle when its file was edited since", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    vi.mocked(readFileFromHandle).mockResolvedValue(song);
    vi.mocked(computeFingerprint).mockResolvedValue("fp-edited");

    await clickRow(await renderHome());

    expect(deleteFileHandle).toHaveBeenCalledWith("fp-1");
    expect(appState.setFile).toHaveBeenCalledWith(song, handle);
  });

  it("asks for the file when its head can't be read for the fingerprint", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    vi.mocked(readFileFromHandle).mockResolvedValue(song);
    vi.mocked(computeFingerprint).mockRejectedValue(new DOMException("gone", "NotReadableError"));

    await clickRow(await renderHome());

    expect(appState.setFile).not.toHaveBeenCalled();
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it("clears the reopen notice once a file is chosen", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
      configurable: true,
    });
    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Home />
      </MemoryRouter>,
    );
    await clickRow(await screen.findByRole("button", { name: /^Song — Band/ }));
    expect(screen.queryByText(/Couldn't reopen that track's file/)).toBeTruthy();

    const dropInput = container.querySelector<HTMLInputElement>(".drop-zone input[type=file]")!;
    await act(async () => {
      fireEvent.change(dropInput, { target: { files: [song] } });
    });

    expect(appState.setFile).toHaveBeenCalledWith(song, null);
    expect(screen.queryByText(/Couldn't reopen that track's file/)).toBeNull();
  });

  it("explains instead of opening a picker the browser would block", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
      configurable: true,
    });

    await clickRow(await renderHome());

    expect(inputClick).not.toHaveBeenCalled();
    expect(screen.getByText(/Couldn't reopen that track's file/)).toBeTruthy();
  });

  it("asks for the file when no handle is stored", async () => {
    await clickRow(await renderHome());

    expect(readFileFromHandle).not.toHaveBeenCalled();
    expect(appState.setFile).not.toHaveBeenCalled();
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it("asks for the file when the stored handle can't be read", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);

    await clickRow(await renderHome());

    expect(readFileFromHandle).toHaveBeenCalledWith(handle);
    expect(appState.setFile).not.toHaveBeenCalled();
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it("queues a cached track when its + button is clicked", async () => {
    vi.mocked(getFileHandle).mockResolvedValue(handle);
    vi.mocked(readFileFromHandle).mockResolvedValue(song);
    await renderHome();

    const addBtn = screen.getByRole("button", { name: /^Add Song — Band/ });
    await act(async () => {
      fireEvent.click(addBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appState.addToMixQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        file: song,
        fileHandle: handle,
        fingerprint: "fp-1",
      }),
    );
  });

  it("forwards multi-file drops to addFilesToMixQueue and navigates to Listen", async () => {
    const songTwo = new File([new Uint8Array([2])], "song2.mp3");
    const { container } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/listen" element={<div>Listen page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /^Song — Band/ });

    fireEvent.drop(container.querySelector(".drop-zone")!, {
      dataTransfer: {
        files: [song, songTwo],
        items: [{ kind: "file" }, { kind: "file" }],
      },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appState.addFilesToMixQueue).toHaveBeenCalledWith(
      [
        { file: song, handle: null },
        { file: songTwo, handle: null },
      ],
      { activateFirst: true },
    );
    expect(screen.getByText("Listen page")).toBeTruthy();
  });

  it("displays the mix queue bar on Home and clears it when requested", async () => {
    appState.mixQueue = [
      { id: "fp-1", title: "Track One", fingerprint: "fp-1" },
      { id: "fp-2", title: "Track Two", fingerprint: "fp-2" },
    ];
    await renderHome();

    const queueBar = document.querySelector("#home-mix-queue");
    expect(queueBar?.textContent).toContain("Track One × Track Two");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(appState.clearMixQueue).toHaveBeenCalledTimes(1);
  });
});
