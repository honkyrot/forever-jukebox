import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "../../store";
import { VizBottomRight } from "./VizBottomRight";

const h = vi.hoisted(() => ({
  setAutocanonizerStreamPans: vi.fn(),
  setAutocanonizerSongGainPct: vi.fn(),
  setAutocanonizerQuadStreamPans: vi.fn(),
  setAutocanonizerQuadSongGainPct: vi.fn(),
  setMasterVolume: vi.fn(),
  toggleFullscreen: vi.fn(),
}));

vi.mock("../../playback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playback")>()),
  setAutocanonizerStreamPans: h.setAutocanonizerStreamPans,
  setAutocanonizerSongGainPct: h.setAutocanonizerSongGainPct,
  setAutocanonizerQuadStreamPans: h.setAutocanonizerQuadStreamPans,
  setAutocanonizerQuadSongGainPct: h.setAutocanonizerQuadSongGainPct,
  setMasterVolume: h.setMasterVolume,
}));
vi.mock("../../fullscreen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fullscreen")>()),
  toggleFullscreen: h.toggleFullscreen,
}));
vi.mock("../../runtime", () => ({
  getAppContext: vi.fn(() => ({})),
}));

describe("VizBottomRight", () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useAppStore.setState({
        playlist: { tracks: [], currentIndex: -1 },
        volumePct: 50,
        playMode: "jukebox",
        autocanonizerMainPan: 0,
        autocanonizerOtherPan: 0,
        autocanonizerPinkPan: 0,
        autocanonizerGoldPan: 0,
        autocanonizerMainGainPct: 100,
        autocanonizerOtherGainPct: 100,
        autocanonizerPinkGainPct: 100,
        autocanonizerGoldGainPct: 100,
        autocanonizerMixEnabled: false,
        autocanonizerQuadMode: false,
        autocanonizerMixTrackTitles: null,
        isFullscreen: false,
        playlistModalOpen: false,
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles the volume panel and applies volume changes", async () => {
    render(<VizBottomRight />);
    const panel = document.getElementById("volume-control-panel")!;
    expect(panel.classList.contains("is-hidden")).toBe(true);
    await userEvent.click(document.getElementById("volume-button")!);
    expect(panel.classList.contains("is-hidden")).toBe(false);
    const slider = document.getElementById("volume") as HTMLInputElement;
    // range inputs: fire a change directly
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(slider, "80");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setMasterVolume).toHaveBeenCalledWith(expect.anything(), 80);
    expect(document.getElementById("volume-val")?.textContent).toBe("80");
    // click-away closes
    await userEvent.click(document.body);
    expect(panel.classList.contains("is-hidden")).toBe(true);
  });

  it("reflects external volume sync from the store", () => {
    render(<VizBottomRight />);
    act(() => {
      useAppStore.setState({ volumePct: 25 });
    });
    expect(
      (document.getElementById("volume") as HTMLInputElement).value,
    ).toBe("25");
  });

  it("persists volume changes and shows the muted icon at zero", async () => {
    render(<VizBottomRight />);
    const icon = document.querySelector("#volume-button .volume-icon");
    expect(icon?.textContent).toBe("volume_up");
    await userEvent.click(document.getElementById("volume-button")!);
    const slider = document.getElementById("volume") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(slider, "0");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(localStorage.getItem("fj-volume")).toBe("0");
    expect(icon?.textContent).toBe("volume_off");
  });

  it("keeps volume as master volume in autocanonizer mode", async () => {
    act(() => {
      useAppStore.setState({ playMode: "autocanonizer" });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("volume-button")!);

    const slider = document.getElementById("volume") as HTMLInputElement;
    expect(slider).not.toBe(null);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(slider, "80");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(h.setMasterVolume).toHaveBeenCalledWith(expect.anything(), 80);
    expect(document.getElementById("volume-val")?.textContent).toBe("80");
  });

  it("shows and applies independent stream pans in autocanonizer mode", async () => {
    act(() => {
      useAppStore.setState({ playMode: "autocanonizer" });
    });
    render(<VizBottomRight />);

    expect(document.getElementById("autocanonizer-pan-button")).not.toBe(null);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    const slider = document.getElementById(
      "autocanonizer-main-pan",
    ) as HTMLInputElement;
    expect(slider.value).toBe("0");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(slider, "-40");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(h.setAutocanonizerStreamPans).toHaveBeenCalledWith(
      expect.anything(),
      -40,
      0,
    );
    expect(localStorage.getItem("audioBalance")).toBe(
      JSON.stringify({ blue: -40, green: 0, pink: 0, gold: 0 }),
    );
    expect(slider.value).toBe("-40");
    expect(
      (
        document.getElementById(
          "autocanonizer-other-pan",
        ) as HTMLInputElement
      ).value,
    ).toBe("0");
  });

  it("renders the fullscreen state and toggles it", async () => {
    render(<VizBottomRight />);
    const button = document.getElementById("fullscreen")!;
    expect(button.getAttribute("aria-label")).toBe("Fullscreen");
    expect(button.querySelector(".fullscreen-icon")?.textContent).toBe(
      "fullscreen",
    );
    await userEvent.click(button);
    expect(h.toggleFullscreen).toHaveBeenCalled();
    act(() => {
      useAppStore.setState({ isFullscreen: true });
    });
    expect(button.getAttribute("aria-label")).toBe("Exit Fullscreen");
    expect(button.querySelector(".fullscreen-icon")?.textContent).toBe(
      "fullscreen_exit",
    );
  });

  it("shows the playlist button only with tracks and opens the modal", async () => {
    render(<VizBottomRight />);
    const button = document.getElementById("playlist-open")!;
    expect(button.classList.contains("is-hidden")).toBe(true);
    act(() => {
      useAppStore.setState({
        playlist: {
          tracks: [
            {
              id: "a",
              sourceType: "youtube",
              title: "A",
              artist: "",
              duration: null,
            },
            {
              id: "b",
              sourceType: "youtube",
              title: "B",
              artist: "",
              duration: null,
            },
          ],
          currentIndex: 0,
        },
      });
    });
    expect(button.classList.contains("is-hidden")).toBe(false);
    expect(button.getAttribute("title")).toBe("Playlist (1/2)");
    await userEvent.click(button);
    expect(useAppStore.getState().playlistModalOpen).toBe(true);
  });

  it("shows per-song titles, gain sliders, and reset in dual autocanonizer mix mode", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: true,
        autocanonizerMixTrackTitles: ["Cover A", "Cover B"],
        autocanonizerMainPan: -25,
        autocanonizerOtherPan: 25,
        autocanonizerMainGainPct: 120,
        autocanonizerOtherGainPct: 80,
      });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    const panel = document.getElementById("autocanonizer-pan-control-panel")!;
    expect(panel.classList.contains("is-dual")).toBe(true);
    expect(panel.textContent).toContain("Cover A");
    expect(panel.textContent).toContain("Cover B");

    const mainGain = document.getElementById("autocanonizer-main-gain") as HTMLInputElement;
    const otherGain = document.getElementById("autocanonizer-other-gain") as HTMLInputElement;
    expect(mainGain.value).toBe("120");
    expect(otherGain.value).toBe("80");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(otherGain, "150");
      otherGain.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setAutocanonizerSongGainPct).toHaveBeenCalledWith(
      expect.anything(),
      "other",
      150,
    );

    const resetBtn = document.getElementById("autocanonizer-balance-reset")!;
    await userEvent.click(resetBtn);
    expect(h.setAutocanonizerStreamPans).toHaveBeenCalledWith(expect.anything(), 0, 0);
    expect(h.setAutocanonizerSongGainPct).toHaveBeenCalledWith(
      expect.anything(),
      "main",
      100,
    );
    expect(h.setAutocanonizerSongGainPct).toHaveBeenCalledWith(
      expect.anything(),
      "other",
      100,
    );
  });

  it("shows all four pan and gain sliders and resets all four in 4-voice quad mode", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: true,
        autocanonizerQuadMode: true,
        autocanonizerMixTrackTitles: ["Cover A", "Cover B"],
        autocanonizerMainPan: -20,
        autocanonizerOtherPan: 20,
        autocanonizerPinkPan: -30,
        autocanonizerGoldPan: 30,
        autocanonizerMainGainPct: 100,
        autocanonizerOtherGainPct: 90,
        autocanonizerPinkGainPct: 110,
        autocanonizerGoldGainPct: 85,
      });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    const panel = document.getElementById("autocanonizer-pan-control-panel")!;
    expect(panel.classList.contains("is-quad")).toBe(true);
    const pinkPan = document.getElementById("autocanonizer-pink-pan") as HTMLInputElement;
    const goldGain = document.getElementById("autocanonizer-gold-gain") as HTMLInputElement;
    expect(pinkPan.value).toBe("-30");
    expect(goldGain.value).toBe("85");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(pinkPan, "45");
      pinkPan.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setAutocanonizerQuadStreamPans).toHaveBeenCalledWith(
      expect.anything(),
      45,
      30,
    );
    expect(localStorage.getItem("audioBalance")).toBe(
      JSON.stringify({ blue: -20, green: 20, pink: 45, gold: 30 }),
    );

    await userEvent.click(document.getElementById("autocanonizer-balance-reset")!);
    expect(h.setAutocanonizerQuadStreamPans).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
    );
    expect(localStorage.getItem("audioBalance")).toBe(
      JSON.stringify({ blue: 0, green: 0, pink: 0, gold: 0 }),
    );
    expect(h.setAutocanonizerQuadSongGainPct).toHaveBeenCalledWith(
      expect.anything(),
      "pink",
      100,
    );
    expect(h.setAutocanonizerQuadSongGainPct).toHaveBeenCalledWith(
      expect.anything(),
      "gold",
      100,
    );
  });

  it("shows the Gold pan slider in single-song 3-Voice trio mode", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: false,
        autocanonizerTrioMode: true,
        autocanonizerMainPan: 0,
        autocanonizerOtherPan: -25,
        autocanonizerGoldPan: 35,
      });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    expect(document.getElementById("autocanonizer-pink-pan")).toBeNull();
    const goldPan = document.getElementById("autocanonizer-gold-pan") as HTMLInputElement;
    expect(goldPan).not.toBeNull();
    expect(goldPan.value).toBe("35");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(goldPan, "60");
      goldPan.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setAutocanonizerQuadStreamPans).toHaveBeenCalledWith(
      expect.anything(),
      0,
      60,
    );
  });

  it("shows both Gold and Pink pan sliders in single-song 4-Voice mode", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: false,
        autocanonizerSingleVoiceCount: 4,
        autocanonizerPinkPan: -15,
        autocanonizerGoldPan: 35,
      });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    const goldPan = document.getElementById("autocanonizer-gold-pan") as HTMLInputElement;
    const pinkPan = document.getElementById("autocanonizer-pink-pan") as HTMLInputElement;
    expect(goldPan.value).toBe("35");
    expect(pinkPan.value).toBe("-15");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(pinkPan, "-50");
      pinkPan.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setAutocanonizerQuadStreamPans).toHaveBeenCalledWith(
      expect.anything(),
      -50,
      35,
    );
  });

  it("snaps balance and volume sliders to step 5 with major and 25%/75% minor ticks", async () => {
    act(() => {
      useAppStore.setState({
        playMode: "autocanonizer",
        autocanonizerMixEnabled: true,
        autocanonizerQuadMode: true,
        autocanonizerMixTrackTitles: ["Cover A", "Cover B"],
      });
    });
    render(<VizBottomRight />);
    await userEvent.click(document.getElementById("autocanonizer-pan-button")!);

    const panSlider = document.getElementById("autocanonizer-main-pan") as HTMLInputElement;
    const gainSlider = document.getElementById("autocanonizer-main-gain") as HTMLInputElement;
    expect(panSlider.step).toBe("5");
    expect(gainSlider.step).toBe("5");

    const wrap = panSlider.closest(".pan-slider-wrap");
    expect(wrap).not.toBeNull();
    const majorTicks = wrap!.querySelectorAll(".pan-tick.is-major");
    const minorTicks = wrap!.querySelectorAll(".pan-tick.is-minor");
    expect(majorTicks).toHaveLength(3);
    expect(minorTicks).toHaveLength(2);
    expect((majorTicks[0] as HTMLElement).style.left).toBe("0%");
    expect((minorTicks[0] as HTMLElement).style.left).toBe("25%");
    expect((majorTicks[1] as HTMLElement).style.left).toBe("50%");
    expect((minorTicks[1] as HTMLElement).style.left).toBe("75%");
    expect((majorTicks[2] as HTMLElement).style.left).toBe("100%");
  });
});
