import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { useAppStore } from "../../store";
import { VizContainer } from "./VizContainer";

const h = vi.hoisted(() => ({
  attachViz: vi.fn(),
  jukebox: {
    getCount: vi.fn(() => 6),
    resizeNow: vi.fn(),
    resizeActive: vi.fn(),
  },
  autocanonizer: { resizeNow: vi.fn() },
}));

vi.mock("../../runtime", () => ({
  attachViz: h.attachViz,
  getAppContext: vi.fn(() => ({
    jukebox: h.jukebox,
    autocanonizer: h.autocanonizer,
  })),
}));

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("VizContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useAppStore.setState({
        audioLoaded: false,
        analysisLoaded: false,
        audioModePreparing: false,
        playMode: "jukebox",
        branchStats: null,
        playlist: { tracks: [], currentIndex: -1 },
        volumePct: 50,
        isFullscreen: false,
        bpmBarEnabled: true,
        bpmBarStyle: "pulse",
        isPaused: false,
        bpmBarTimeSignatureMode: "auto",
        bpmBarNumerator: 4,
        bpmBarDenominator: 4,
        bpmBarBeatOffset: 0,
        multiTrackEnabled: false,
        coverSyncEnabled: false,
        timeSignatureBranchingEnabled: false,
        timeSignatureBranchMode: "overwrite",
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        timeSignatureTrackOffsets: [],
        timeSignatureSimilarityRestrictEnabled: false,
        timeSignatureSimilarityNumerator: 4,
        timeSignatureSimilarityDenominator: 4,
        jukeboxAudioMode: "off",
        metronomeBeatsPerBar: null,
        metronomeBeatOffset: 0,
        metronomeDetectedBeatsPerBar: 4,
        vizStatsPulseId: 0,
        vizStatsPulseBeatIndex: null,
        vizStatsPulseBeat: null,
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands the panel and layer nodes to attachViz under StrictMode", () => {
    render(
      <StrictMode>
        <VizContainer />
      </StrictMode>,
    );
    expect(h.attachViz).toHaveBeenCalled();
    const nodes = h.attachViz.mock.calls[0][0];
    expect(nodes.vizPanel.id).toBe("viz-panel");
    expect(nodes.vizLayer.id).toBe("viz-layer");
    expect(nodes.canonizerLayer.id).toBe("canonizer-layer");
    // every (re-)attach passes the SAME nodes — the layers never remount
    for (const call of h.attachViz.mock.calls) {
      expect(call[0].vizLayer).toBe(nodes.vizLayer);
      expect(call[0].canonizerLayer).toBe(nodes.canonizerLayer);
    }
  });

  it("keeps the layer nodes identical across state-driven re-renders", () => {
    render(<VizContainer />);
    const layer = document.getElementById("viz-layer");
    const canonizer = document.getElementById("canonizer-layer");
    act(() => {
      useAppStore.setState({
        audioLoaded: true,
        analysisLoaded: true,
        playMode: "autocanonizer",
      });
    });
    expect(document.getElementById("viz-layer")).toBe(layer);
    expect(document.getElementById("canonizer-layer")).toBe(canonizer);
    expect(
      document.getElementById("jukebox-viz")?.classList.contains("is-canonizer"),
    ).toBe(true);
    expect(
      document.getElementById("viz-panel")?.classList.contains("hidden"),
    ).toBe(false);
  });

  it("hides the panel until loaded and resizes on reveal", () => {
    render(<VizContainer />);
    expect(
      document.getElementById("viz-panel")?.classList.contains("hidden"),
    ).toBe(true);
    act(() => {
      useAppStore.setState({ audioLoaded: true, analysisLoaded: true });
    });
    expect(
      document.getElementById("viz-panel")?.classList.contains("hidden"),
    ).toBe(false);
    expect(h.jukebox.resizeActive).toHaveBeenCalled();
  });

  it("observes the panel with ResizeObserver and resizes both controllers", () => {
    StubResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const { unmount } = render(<VizContainer />);

    // An effect remount (StrictMode-style) can create then disconnect an
    // earlier observer; the last one is the live subscription.
    expect(StubResizeObserver.instances.length).toBeGreaterThanOrEqual(1);
    const observer =
      StubResizeObserver.instances[StubResizeObserver.instances.length - 1];
    expect(observer.observe).toHaveBeenCalledWith(
      document.getElementById("viz-panel"),
    );

    act(() => observer.trigger());
    expect(h.jukebox.resizeNow).toHaveBeenCalled();
    expect(h.autocanonizer.resizeNow).toHaveBeenCalled();

    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("falls back to the window resize listener without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<VizContainer />);

    expect(addSpy).toHaveBeenCalledWith("resize", expect.any(Function));

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(h.jukebox.resizeNow).toHaveBeenCalled();
    expect(h.autocanonizer.resizeNow).toHaveBeenCalled();

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("pulses #viz-stats solidly when time signatures are inactive and pulses 1/2/3/4 segments when active", () => {
    render(<VizContainer />);
    const vizStats = document.getElementById("viz-stats");
    expect(vizStats).not.toBeNull();
    expect(document.getElementById("bpm-bar-segments")).toBeNull();

    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 1,
        vizStatsPulseBeatIndex: 0,
      });
    });
    expect(vizStats?.classList.contains("pulse")).toBe(true);

    // Enable 4/4 similarity restriction in multi-track mode -> splits into 4 segments.
    act(() => {
      useAppStore.setState({
        multiTrackEnabled: true,
        timeSignatureSimilarityRestrictEnabled: true,
        timeSignatureSimilarityNumerator: 4,
        timeSignatureSimilarityDenominator: 4,
        vizStatsPulseId: 2,
        vizStatsPulseBeatIndex: 0,
        vizStatsPulseBeat: { which: 0, localWhich: 0, trackIndex: 0 },
      });
    });

    const segmentsContainer = document.getElementById("bpm-bar-segments");
    expect(segmentsContainer).not.toBeNull();
    const segments = segmentsContainer?.querySelectorAll(".bpm-bar-segment");
    expect(segments).toHaveLength(4);
    expect(vizStats?.classList.contains("pulse")).toBe(false);
    expect(segments?.[0]?.classList.contains("is-pulsing")).toBe(true);
    expect(segments?.[1]?.classList.contains("is-pulsing")).toBe(false);

    // Beat 2 (index 1) pulses segment 2.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 3,
        vizStatsPulseBeatIndex: 1,
        vizStatsPulseBeat: { which: 1, localWhich: 1, trackIndex: 0 },
      });
    });
    expect(segments?.[1]?.classList.contains("is-pulsing")).toBe(true);

    // Custom 4/2 mode switches to 8 segments even outside multi-track.
    act(() => {
      useAppStore.setState({
        multiTrackEnabled: false,
        bpmBarTimeSignatureMode: "custom",
        bpmBarNumerator: 4,
        bpmBarDenominator: 2,
        vizStatsPulseId: 4,
        vizStatsPulseBeatIndex: 7,
        vizStatsPulseBeat: { which: 7 },
      });
    });
    const customSegments = document.querySelectorAll(
      "#bpm-bar-segments .bpm-bar-segment",
    );
    expect(customSegments).toHaveLength(8);
    expect(customSegments[7]?.classList.contains("is-pulsing")).toBe(true);
  });

  it("animates a smooth progress bar across single beats and time-signature measures", () => {
    act(() => {
      useAppStore.setState({
        bpmBarEnabled: true,
        bpmBarStyle: "smooth",
        bpmBarTimeSignatureMode: "off",
      });
    });

    render(<VizContainer />);
    const vizStats = document.getElementById("viz-stats");
    const smoothBar = document.getElementById("bpm-bar-smooth");
    const smoothFill = document.getElementById("bpm-bar-smooth-fill");
    expect(smoothBar).not.toBeNull();
    expect(smoothFill).not.toBeNull();
    expect(document.getElementById("bpm-bar-segments")).toBeNull();
    expect(document.getElementById("bpm-bar-smooth-ticks")).toBeNull();
    expect(smoothFill?.classList.contains("is-animating")).toBe(false);

    // Single-beat progress when no time signature is active.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 1,
        vizStatsPulseBeatIndex: 0,
        vizStatsPulseBeat: { which: 0, start: 0, duration: 0.4 },
      });
    });
    expect(vizStats?.classList.contains("pulse")).toBe(false);
    expect(smoothFill?.classList.contains("is-animating")).toBe(true);
    expect(smoothFill?.classList.contains("is-downbeat")).toBe(false);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-from")).toBe("0");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("1");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-duration")).toBe(
      "400ms",
    );

    // Custom 4/4 measure: beat 1 fills 0 -> 0.25 with downbeat styling.
    act(() => {
      useAppStore.setState({
        bpmBarTimeSignatureMode: "custom",
        bpmBarNumerator: 4,
        bpmBarDenominator: 4,
        vizStatsPulseId: 2,
        vizStatsPulseBeatIndex: 0,
        vizStatsPulseBeat: { which: 0, start: 0, duration: 0.5 },
      });
    });
    expect(document.getElementById("bpm-bar-segments")).toBeNull();
    const ticks = document.querySelectorAll(
      "#bpm-bar-smooth-ticks .bpm-bar-smooth-tick",
    );
    expect(ticks).toHaveLength(3);
    expect((ticks[0] as HTMLElement).style.left).toBe("25%");
    expect((ticks[1] as HTMLElement).style.left).toBe("50%");
    expect((ticks[2] as HTMLElement).style.left).toBe("75%");
    expect(smoothFill?.classList.contains("is-animating")).toBe(true);
    expect(smoothFill?.classList.contains("is-downbeat")).toBe(true);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-from")).toBe("0");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("0.25");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-duration")).toBe(
      "500ms",
    );

    // Beat 2 fills 0.25 -> 0.5 without downbeat styling.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 3,
        vizStatsPulseBeatIndex: 1,
        vizStatsPulseBeat: { which: 1, start: 0.5, duration: 0.5 },
      });
    });
    expect(smoothFill?.classList.contains("is-downbeat")).toBe(false);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-from")).toBe("0.25");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("0.5");

    // Pausing freezes the animation without resetting it.
    act(() => {
      useAppStore.setState({ isPaused: true });
    });
    expect(smoothBar?.classList.contains("is-paused")).toBe(true);
    expect(smoothFill?.classList.contains("is-animating")).toBe(true);

    // Stopping clears pulse ID and resets the smooth fill.
    act(() => {
      useAppStore.setState({
        isPaused: false,
        vizStatsPulseId: 0,
        vizStatsPulseBeatIndex: null,
        vizStatsPulseBeat: null,
      });
    });
    expect(smoothBar?.classList.contains("is-paused")).toBe(false);
    expect(smoothFill?.classList.contains("is-animating")).toBe(false);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("");
  });

  it("combines smooth progress with pulse flashes in smooth-pulse mode", () => {
    act(() => {
      useAppStore.setState({
        bpmBarEnabled: true,
        bpmBarStyle: "smooth-pulse",
        bpmBarTimeSignatureMode: "off",
      });
    });

    render(<VizContainer />);
    const vizStats = document.getElementById("viz-stats");
    const smoothFill = document.getElementById("bpm-bar-smooth-fill");
    expect(smoothFill).not.toBeNull();
    expect(document.getElementById("bpm-bar-segments")).toBeNull();

    // Bare reset pulses (no beat index or beat) should not animate or pulse.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 1,
        vizStatsPulseBeatIndex: null,
        vizStatsPulseBeat: null,
      });
    });
    expect(vizStats?.classList.contains("pulse")).toBe(false);
    expect(smoothFill?.classList.contains("is-animating")).toBe(false);

    // Real beat hit triggers both smooth fill and #viz-stats.pulse when unsegmented.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 2,
        vizStatsPulseBeatIndex: 0,
        vizStatsPulseBeat: { which: 0, start: 0, duration: 0.5 },
      });
    });
    expect(vizStats?.classList.contains("pulse")).toBe(true);
    expect(smoothFill?.classList.contains("is-animating")).toBe(true);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-from")).toBe("0");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("1");

    // In 4/4 mode, renders overlay segments + ticks and pulses the active segment.
    act(() => {
      useAppStore.setState({
        bpmBarTimeSignatureMode: "custom",
        bpmBarNumerator: 4,
        bpmBarDenominator: 4,
        vizStatsPulseId: 3,
        vizStatsPulseBeatIndex: 0,
        vizStatsPulseBeat: { which: 0, start: 0, duration: 0.5 },
      });
    });
    const segmentsContainer = document.getElementById("bpm-bar-segments");
    expect(segmentsContainer?.classList.contains("is-overlay")).toBe(true);
    const segments = segmentsContainer?.querySelectorAll(".bpm-bar-segment");
    expect(segments).toHaveLength(4);
    expect(
      document.querySelectorAll("#bpm-bar-smooth-ticks .bpm-bar-smooth-tick"),
    ).toHaveLength(3);
    expect(vizStats?.classList.contains("pulse")).toBe(false);
    expect(segments?.[0]?.classList.contains("is-pulsing")).toBe(true);
    expect(smoothFill?.classList.contains("is-animating")).toBe(true);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("0.25");

    // Beat 2 advances smooth fill and pulses segment 2.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 4,
        vizStatsPulseBeatIndex: 1,
        vizStatsPulseBeat: { which: 1, start: 0.5, duration: 0.5 },
      });
    });
    expect(segments?.[1]?.classList.contains("is-pulsing")).toBe(true);
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-from")).toBe("0.25");
    expect(smoothFill?.style.getPropertyValue("--bpm-bar-to")).toBe("0.5");

    // Stopping clears both smooth fill and segment pulse classes.
    act(() => {
      useAppStore.setState({
        vizStatsPulseId: 0,
        vizStatsPulseBeatIndex: null,
        vizStatsPulseBeat: null,
      });
    });
    expect(smoothFill?.classList.contains("is-animating")).toBe(false);
    expect(segments?.[0]?.classList.contains("is-pulsing")).toBe(false);
    expect(segments?.[1]?.classList.contains("is-pulsing")).toBe(false);
  });
});
