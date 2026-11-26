import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/app/i18n";
import { DropZone } from "./DropZone";

const song = new File([new Uint8Array([1, 2, 3])], "song.mp3", { type: "audio/mpeg" });

function fakeHandle(file: File) {
  return { kind: "file", name: file.name, getFile: async () => file } as unknown as FileSystemFileHandle;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DropZone", () => {
  afterEach(() => {
    cleanup();
    delete (window as Partial<Window>).showOpenFilePicker;
  });

  it("opens the file input where the browser has no file picker API", () => {
    const onFile = vi.fn();
    const { container } = render(<DropZone onFile={onFile} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const inputClick = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(inputClick).toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [song] } });
    expect(onFile).toHaveBeenCalledWith(song, null);
  });

  it("hands over the picked file with its handle", async () => {
    const onFile = vi.fn();
    const handle = fakeHandle(song);
    window.showOpenFilePicker = vi.fn(async () => [handle]);
    render(<DropZone onFile={onFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await settle();

    expect(window.showOpenFilePicker).toHaveBeenCalledWith({
      types: [{ accept: { "audio/*": expect.arrayContaining([".mp3", ".flac"]) } }],
    });
    expect(onFile).toHaveBeenCalledWith(song, handle);
  });

  it("does nothing when the picker is cancelled", async () => {
    const onFile = vi.fn();
    window.showOpenFilePicker = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const { container } = render(<DropZone onFile={onFile} />);
    const inputClick = vi.spyOn(
      container.querySelector<HTMLInputElement>("input[type=file]")!,
      "click",
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await settle();

    expect(onFile).not.toHaveBeenCalled();
    expect(inputClick).not.toHaveBeenCalled();
  });

  it("passes a dropped file's handle when the browser offers one", async () => {
    const onFile = vi.fn();
    const handle = fakeHandle(song);
    const { container } = render(<DropZone onFile={onFile} />);

    fireEvent.drop(container.querySelector(".drop-zone")!, {
      dataTransfer: {
        files: [song],
        items: [{ kind: "file", getAsFileSystemHandle: async () => handle }],
      },
    });
    await settle();

    expect(onFile).toHaveBeenCalledWith(song, handle);
  });

  it("passes a dropped file without a handle elsewhere", () => {
    const onFile = vi.fn();
    const { container } = render(<DropZone onFile={onFile} />);

    fireEvent.drop(container.querySelector(".drop-zone")!, {
      dataTransfer: { files: [song], items: [{ kind: "file" }] },
    });

    expect(onFile).toHaveBeenCalledWith(song, null);
  });

  it("forwards multiple dropped and picked files when multiple mode is enabled", async () => {
    const songTwo = new File([new Uint8Array([4, 5, 6])], "song2.mp3", {
      type: "audio/mpeg",
    });
    const onFiles = vi.fn();
    const { container } = render(
      <DropZone onFile={vi.fn()} onFiles={onFiles} multiple={true} />,
    );
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input.multiple).toBe(true);

    fireEvent.drop(container.querySelector(".drop-zone")!, {
      dataTransfer: {
        files: [song, songTwo],
        items: [{ kind: "file" }, { kind: "file" }],
      },
    });
    await settle();

    expect(onFiles).toHaveBeenCalledWith([
      { file: song, handle: null },
      { file: songTwo, handle: null },
    ]);
  });
});
