import type { AppContext } from "../context";
import type { Elements } from "../elements";
import type { AutocanonizerController } from "../../autocanonizer/AutocanonizerController";
import type { BufferedAudioPlayer } from "../../audio/BufferedAudioPlayer";
import { setAutoMarqueeText } from "../marquee";

type TuningDeps = {
  context: AppContext;
  elements: Elements;
  player: BufferedAudioPlayer;
  autocanonizer: AutocanonizerController;
  openTuning: (context: AppContext) => void;
  closeTuning: (context: AppContext) => void;
  openInfo: (context: AppContext) => void;
  closeInfo: (context: AppContext) => void;
  applyTuningChanges: (context: AppContext) => void;
  resetTuningDefaults: (context: AppContext) => void;
  toggleAutocanonizerTuning: (context: AppContext) => void;
  applyExtrasChanges: (context: AppContext) => {
    branchStatsChanged: boolean;
    audioModeChanged: boolean;
  };
  resetExtrasDefaults: (context: AppContext) => {
    branchStatsChanged: boolean;
    audioModeChanged: boolean;
  };
  syncExtrasUI: (context: AppContext) => void;
  syncTuningTabsUI: (context: AppContext) => void;
  setActiveTuningTab: (context: AppContext, tab: "tuning" | "extras") => void;
  getActiveTuningTab: (context: AppContext) => "tuning" | "extras";
};

export type TuningHandlers = ReturnType<typeof createTuningHandlers>;

export function createTuningHandlers(deps: TuningDeps) {
  const {
    context,
    elements,
    player,
    autocanonizer,
    openTuning,
    closeTuning,
    openInfo,
    closeInfo,
    applyTuningChanges,
    resetTuningDefaults,
    toggleAutocanonizerTuning,
    applyExtrasChanges,
    resetExtrasDefaults,
    syncExtrasUI,
    syncTuningTabsUI,
    setActiveTuningTab,
    getActiveTuningTab,
  } = deps;

  function syncTrackTitle() {
    const { state } = context;
    if (!state.trackTitle && !state.trackArtist) {
      return;
    }
    const baseTitle = state.trackTitle ?? "Unknown";
    const title =
      state.playMode === "autocanonizer"
        ? `${baseTitle} (autocanonized)`
        : state.jukeboxAudioMode !== "off"
          ? `${baseTitle} (${state.jukeboxAudioMode})`
          : baseTitle;
    const displayTitle = state.trackArtist ? `${title} — ${state.trackArtist}` : title;
    setAutoMarqueeText(elements.playTitle, displayTitle);
    setAutoMarqueeText(elements.vizNowPlayingEl, displayTitle);
  }

  function handleThresholdInput() {
    elements.thresholdVal.textContent = elements.thresholdInput.value;
  }

  function handleMinProbInput() {
    elements.minProbVal.textContent = `${elements.minProbInput.value}%`;
  }

  function handleMaxProbInput() {
    elements.maxProbVal.textContent = `${elements.maxProbInput.value}%`;
  }

  function handleRampInput() {
    elements.rampVal.textContent = `${elements.rampInput.value}%`;
  }

  function handleVolumeInput() {
    elements.volumeVal.textContent = elements.volumeInput.value;
    const volume = Number(elements.volumeInput.value) / 100;
    player.setVolume(volume);
    autocanonizer.setVolume(volume);
  }

  // audio streams fun!!!
  function handleBlueAudioBalanceChange() {
    context.state.audioBalance.blue = Number(elements.blueAudioBalanceInput.value);
    elements.blueAudioBalanceLabel.textContent = `${context.state.audioBalance.blue}`;
    autocanonizer.setBalance(context.state.audioBalance.blue, context.state.audioBalance.green);
  }

  function handleGreenAudioBalanceChange() {
    context.state.audioBalance.green = Number(elements.greenAudioBalanceInput.value);
    elements.greenAudioBalanceLabel.textContent = `${context.state.audioBalance.green}`;
    autocanonizer.setBalance(context.state.audioBalance.blue, context.state.audioBalance.green);
  }

  function handleOpenTuning() {
    openTuning(context);
  }

  function handleOpenInfo() {
    openInfo(context);
  }

  function handleCloseTuning() {
    closeTuning(context);
  }

  function handleCloseInfo() {
    closeInfo(context);
  }

  function handleAutocanonizerTuning() {
    toggleAutocanonizerTuning(context);
  }

  function handleTuningTabToggle() {
    const activeTab = getActiveTuningTab(context);
    setActiveTuningTab(context, activeTab === "tuning" ? "extras" : "tuning");
  }

  function syncInfoButton() {
    elements.infoButton.title = "Info";
    elements.infoButton.setAttribute("aria-label", "Info");
  }

  function syncTuneButton() {
    elements.tuningButton.title = "Tune";
    elements.tuningButton.setAttribute("aria-label", "Tune");
  }

  function syncCopyButton() {
    elements.shortUrlButton.title = "Copy URL";
    elements.shortUrlButton.setAttribute("aria-label", "Copy URL");
  }

  // function handleTuningModalClick(event: MouseEvent) {
    // if (event.target === elements.tuningModal) {
    //   closeTuning(context);
    // }
  // }

  // function handleInfoModalClick(event: MouseEvent) {
    // if (event.target === elements.infoModal) {
    //   closeInfo(context);
    // }
  // }

  function handleTuningApply() {
    // const activeTab = getActiveTuningTab(context);
    // if (activeTab === "extras") {
    //   const result = applyExtrasChanges(context);
    //   syncExtrasUI(context);
    //   syncTuningTabsUI(context);
    //   if (result.audioModeChanged) {
    //     syncTrackTitle();
    //   }
    //   closeTuning(context);
    //   return;
    // }
    applyTuningChanges(context);
    const result = applyExtrasChanges(context);
    syncExtrasUI(context);
    syncTuningTabsUI(context);
    if (result.audioModeChanged) {
      syncTrackTitle();
    }
  }

  function handleTuningReset() {
    // const activeTab = getActiveTuningTab(context);
    // if (activeTab === "extras") {
    //   const result = resetExtrasDefaults(context);
    //   syncExtrasUI(context);
    //   syncTuningTabsUI(context);
    //   if (result.audioModeChanged) {
    //     syncTrackTitle();
    //   }
    //   closeTuning(context);
    //   return;
    // }
    resetTuningDefaults(context);
    const result = resetExtrasDefaults(context);
    syncExtrasUI(context);
    syncTuningTabsUI(context);
    if (result.audioModeChanged) {
      syncTrackTitle();
    }
  }

  function handleVolumeButtonClick() {
    elements.volumeControlPanel.classList.toggle("is-hidden");
  }

  function handleVolumeDocumentClick(event: MouseEvent) {
    if (elements.volumeControlPanel.classList.contains("is-hidden")) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    const clickedInsidePanel = elements.volumeControlPanel.contains(target);
    const clickedVolumeButton = elements.volumeButton.contains(target);
    if (!clickedInsidePanel && !clickedVolumeButton) {
      elements.volumeControlPanel.classList.add("is-hidden");
    }
  }

  return {
    handleThresholdInput,
    handleMinProbInput,
    handleMaxProbInput,
    handleRampInput,
    handleVolumeInput,
    handleOpenTuning,
    handleOpenInfo,
    handleCloseTuning,
    handleCloseInfo,
    handleTuningTabToggle,
    syncInfoButton,
    syncTuneButton,
    syncCopyButton,
    // handleTuningModalClick,
    // handleInfoModalClick,
    handleTuningApply,
    handleTuningReset,
    // forks
    handleAutocanonizerTuning,
    handleBlueAudioBalanceChange,
    handleGreenAudioBalanceChange,
    handleVolumeButtonClick,
    handleVolumeDocumentClick,
  };
}
