import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_KEY_STORAGE_KEY } from "../../admin";
import { useAppStore } from "../../store";
import { PlayMenu } from "./PlayMenu";

const h = vi.hoisted(() => ({
  getPendingDelete: vi.fn(),
  performDelete: vi.fn(),
  getPendingRename: vi.fn(),
  performRename: vi.fn(),
  getPendingReanalyze: vi.fn(),
  performReanalyze: vi.fn(),
  toggleFavorite: vi.fn(),
  copyShortUrl: vi.fn(),
  reportTrack: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../api", () => ({ reportTrack: h.reportTrack }));
vi.mock("../../ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ui")>()),
  showToast: h.showToast,
}));

vi.mock("../../delete-job", () => ({
  getPendingDelete: h.getPendingDelete,
  performDelete: h.performDelete,
}));
vi.mock("../../rename-job", () => ({
  getPendingRename: h.getPendingRename,
  performRename: h.performRename,
}));
vi.mock("../../reanalyze-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../reanalyze-job")>()),
  getPendingReanalyze: h.getPendingReanalyze,
  performReanalyze: h.performReanalyze,
}));
vi.mock("../../favorites-actions", () => ({ toggleFavorite: h.toggleFavorite }));
vi.mock("../../playback-ui", () => ({ copyShortUrl: h.copyShortUrl }));
vi.mock("../../playback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playback")>()),
  openTuning: vi.fn(),
  openInfo: vi.fn(),
}));
vi.mock("../../runtime", () => ({ getAppContext: vi.fn(() => ({})) }));

describe("PlayMenu", () => {
  beforeEach(() => {
    localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    h.getPendingDelete.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      adminKey: null,
    });
    h.performDelete.mockReset();
    h.performDelete.mockResolvedValue(undefined);
    h.getPendingRename.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      title: "Song",
      artist: "Artist",
      adminKey: "secret",
    });
    h.performRename.mockReset();
    h.performRename.mockResolvedValue(true);
    h.getPendingReanalyze.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      currentTempoBpm: 93,
      currentMultiplier: 1,
      bpmLocked: false,
      adminKey: null,
    });
    h.performReanalyze.mockReset();
    h.performReanalyze.mockResolvedValue(true);
    h.toggleFavorite.mockReset();
    h.copyShortUrl.mockReset();
    h.reportTrack.mockReset();
    h.reportTrack.mockResolvedValue(undefined);
    h.showToast.mockReset();
    act(() => {
      useAppStore.setState({
        audioLoaded: true,
        analysisLoaded: true,
        audioModePreparing: false,
        playMode: "jukebox",
        jukeboxAudioMode: "off",
        trackTitle: "Song",
        trackArtist: "Artist",
        bringItHomeMode: false,
        deleteEligible: false,
        deleteConfirmOpen: false,
        renameModalOpen: false,
        reanalyzeModalOpen: false,
        trackBpmMultiplier: 1,
        trackBpmLocked: false,
        multiTrackEnabled: false,
        autocanonizerMixEnabled: false,
        songSyncEnabled: false,
        favorites: [],
        favoriteToggleBusy: false,
        lastTrackId: "track1",
        lastJobId: "job1",
        lastSourceId: null,
        lastSourceProvider: null,
        appConfig: {
          allow_user_upload: false,
          allow_user_url: false,
          allow_track_reports: true,
        },
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the menu until a track is loaded", () => {
    act(() => {
      useAppStore.setState({ audioLoaded: false });
    });
    render(<PlayMenu />);
    expect(
      document.getElementById("play-menu")?.classList.contains("hidden"),
    ).toBe(true);
    act(() => {
      useAppStore.setState({ audioLoaded: true });
    });
    expect(
      document.getElementById("play-menu")?.classList.contains("hidden"),
    ).toBe(false);
  });

  it("derives the marquee title with audio-mode suffix", () => {
    act(() => {
      useAppStore.setState({ jukeboxAudioMode: "nightcore" });
    });
    render(<PlayMenu />);
    expect(document.getElementById("play-title")?.textContent).toBe(
      "Song (nightcore) — Artist",
    );
  });

  it("shows the bring-it-home note only in jukebox mode with the mode on", () => {
    render(<PlayMenu />);
    const label = document.getElementById("bring-home-label");
    expect(label?.classList.contains("is-hidden")).toBe(true);
    act(() => {
      useAppStore.setState({ bringItHomeMode: true });
    });
    expect(label?.classList.contains("is-hidden")).toBe(false);
  });

  it("keeps tuning visible in autocanonizer and songsync while hiding info button", () => {
    act(() => {
      useAppStore.setState({ playMode: "autocanonizer" });
    });
    render(<PlayMenu />);
    expect(
      document.getElementById("tuning")?.classList.contains("is-hidden"),
    ).toBe(false);
    expect(
      document.getElementById("track-info")?.classList.contains("is-hidden"),
    ).toBe(true);

    act(() => {
      useAppStore.setState({ playMode: "songsync" });
    });
    expect(
      document.getElementById("tuning")?.classList.contains("is-hidden"),
    ).toBe(false);
    expect(
      document.getElementById("track-info")?.classList.contains("is-hidden"),
    ).toBe(true);

    act(() => {
      useAppStore.setState({ playMode: "wubmachine" });
    });
    expect(
      document.getElementById("tuning")?.classList.contains("is-hidden"),
    ).toBe(true);
  });

  it("marks the favorite star active for the current track", () => {
    act(() => {
      useAppStore.setState({
        favorites: [
          {
            uniqueSongId: "track1",
            title: "Song",
            artist: "Artist",
            duration: null,
            sourceType: "youtube",
          },
        ],
      });
    });
    render(<PlayMenu />);
    const star = document.getElementById("favorite-toggle");
    expect(star?.classList.contains("active")).toBe(true);
    expect(star?.getAttribute("aria-label")).toBe("Remove from Favorites");
  });

  it("shows the delete button only when eligible or admin", () => {
    render(<PlayMenu />);
    const button = () => document.getElementById("delete-job");
    expect(button()?.classList.contains("hidden")).toBe(true);
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    expect(button()?.classList.contains("hidden")).toBe(false);
    expect(button()?.getAttribute("title")).toBe(
      "Delete within 30 minutes of creation",
    );
  });

  it("shows the report button only when the delete button is hidden", () => {
    render(<PlayMenu />);
    const button = () => document.getElementById("report-track");
    expect(button()?.classList.contains("hidden")).toBe(false);
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    expect(button()?.classList.contains("hidden")).toBe(true);
  });

  it("hides the report button when the server disallows reports", () => {
    act(() => {
      useAppStore.setState({ appConfig: null });
    });
    render(<PlayMenu />);
    const button = () => document.getElementById("report-track");
    expect(button()?.classList.contains("hidden")).toBe(true);
    act(() => {
      useAppStore.setState({
        appConfig: {
          allow_user_upload: false,
          allow_user_url: false,
          allow_track_reports: false,
        },
      });
    });
    expect(button()?.classList.contains("hidden")).toBe(true);
  });

  it("hides the report button in admin mode", () => {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);
    expect(
      document.getElementById("report-track")?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("reports the track with the chosen reason and closes the modal", async () => {
    const user = userEvent.setup();
    render(<PlayMenu />);
    const modal = () => document.getElementById("report-track-modal");
    const submit = () =>
      document.getElementById("report-track-submit") as HTMLButtonElement;

    await user.click(document.getElementById("report-track")!);
    expect(modal()?.classList.contains("open")).toBe(true);
    expect(submit().disabled).toBe(true);

    await user.click(
      document.querySelector<HTMLInputElement>(
        'input[name="report-reason"][value="bad_audio"]',
      )!,
    );
    expect(submit().disabled).toBe(false);
    await user.click(submit());

    expect(h.reportTrack).toHaveBeenCalledWith("job1", "bad_audio");
    await waitFor(() => {
      expect(modal()?.classList.contains("open")).toBe(false);
    });
    expect(h.showToast).toHaveBeenCalledWith("Track reported", {
      icon: "flag",
    });
  });

  it("opens the confirm modal and performs the delete", async () => {
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    render(<PlayMenu />);
    await userEvent.click(document.getElementById("delete-job")!);
    expect(useAppStore.getState().deleteConfirmOpen).toBe(true);
    await userEvent.click(document.getElementById("delete-confirm-delete")!);
    await waitFor(() => {
      expect(h.performDelete).toHaveBeenCalledWith({
        jobId: "job1",
        trackId: "track1",
        adminKey: null,
      });
      expect(useAppStore.getState().deleteConfirmOpen).toBe(false);
    });
  });

  it("bails out of delete when the job changes under the open modal", async () => {
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    render(<PlayMenu />);
    await userEvent.click(document.getElementById("delete-job")!);
    expect(useAppStore.getState().deleteConfirmOpen).toBe(true);

    // The track auto-advanced while the modal was open; the live pending job
    // no longer matches the snapshot frozen at modal-open.
    h.getPendingDelete.mockReturnValue({ jobId: "job2", trackId: "track2", adminKey: null });

    await userEvent.click(document.getElementById("delete-confirm-delete")!);
    await waitFor(() => {
      expect(useAppStore.getState().deleteConfirmOpen).toBe(false);
    });
    expect(h.performDelete).not.toHaveBeenCalled();
  });

  it("guards against double-clicking delete while a delete is in flight", async () => {
    let resolveDelete!: () => void;
    h.performDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    render(<PlayMenu />);
    await userEvent.click(document.getElementById("delete-job")!);
    const deleteButton = document.getElementById("delete-confirm-delete")!;

    await userEvent.click(deleteButton);
    // Second click while the first delete is still pending must be ignored.
    await userEvent.click(deleteButton);
    expect(h.performDelete).toHaveBeenCalledTimes(1);
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveDelete();
    });
    expect(useAppStore.getState().deleteConfirmOpen).toBe(false);
  });

  it("cancels the confirm modal with Escape", async () => {
    act(() => {
      useAppStore.setState({ deleteEligible: true });
    });
    render(<PlayMenu />);
    await userEvent.click(document.getElementById("delete-job")!);
    await userEvent.keyboard("{Escape}");
    expect(useAppStore.getState().deleteConfirmOpen).toBe(false);
    expect(h.performDelete).not.toHaveBeenCalled();
  });

  it("delegates copy link and favorite toggle", async () => {
    render(<PlayMenu />);
    await userEvent.click(document.getElementById("short-url")!);
    expect(h.copyShortUrl).toHaveBeenCalled();
    await userEvent.click(document.getElementById("favorite-toggle")!);
    expect(h.toggleFavorite).toHaveBeenCalled();
  });

  it("shows the rename button only in admin mode", () => {
    render(<PlayMenu />);
    expect(
      document.getElementById("rename-job")?.classList.contains("hidden"),
    ).toBe(true);

    cleanup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);
    expect(
      document.getElementById("rename-job")?.classList.contains("hidden"),
    ).toBe(false);
  });

  it("opens the rename modal prefilled, submits trimmed values, and closes on success", async () => {
    const user = userEvent.setup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);

    await user.click(document.getElementById("rename-job")!);
    expect(useAppStore.getState().renameModalOpen).toBe(true);

    const titleInput = document.getElementById(
      "rename-track-title",
    ) as HTMLInputElement;
    const artistInput = document.getElementById(
      "rename-track-artist",
    ) as HTMLInputElement;
    const submitButton = document.getElementById(
      "rename-track-submit",
    ) as HTMLButtonElement;

    expect(titleInput.value).toBe("Song");
    expect(artistInput.value).toBe("Artist");

    await user.clear(titleInput);
    expect(submitButton.disabled).toBe(true);
    await user.type(titleInput, "  Localized Song  ");
    await user.clear(artistInput);
    await user.type(artistInput, "  Localized Artist  ");
    expect(submitButton.disabled).toBe(false);

    await user.click(submitButton);

    await waitFor(() => {
      expect(h.performRename).toHaveBeenCalledWith(
        {
          jobId: "job1",
          trackId: "track1",
          title: "Song",
          artist: "Artist",
          adminKey: "secret",
        },
        { title: "Localized Song", artist: "Localized Artist" },
      );
      expect(useAppStore.getState().renameModalOpen).toBe(false);
    });
  });

  it("keeps the rename modal open when performRename fails", async () => {
    const user = userEvent.setup();
    h.performRename.mockResolvedValue(false);
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);

    await user.click(document.getElementById("rename-job")!);
    await user.click(document.getElementById("rename-track-submit")!);

    await waitFor(() => {
      expect(h.performRename).toHaveBeenCalledTimes(1);
    });
    expect(useAppStore.getState().renameModalOpen).toBe(true);
  });

  it("bails out of rename when the active job changes under the open modal", async () => {
    const user = userEvent.setup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);

    await user.click(document.getElementById("rename-job")!);
    expect(useAppStore.getState().renameModalOpen).toBe(true);

    h.getPendingRename.mockReturnValue({
      jobId: "job2",
      trackId: "track2",
      title: "Other",
      artist: "Other",
      adminKey: "secret",
    });

    await user.click(document.getElementById("rename-track-submit")!);
    await waitFor(() => {
      expect(useAppStore.getState().renameModalOpen).toBe(false);
    });
    expect(h.performRename).not.toHaveBeenCalled();
  });

  it("cancels the rename modal with Escape", async () => {
    const user = userEvent.setup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);

    await user.click(document.getElementById("rename-job")!);
    expect(useAppStore.getState().renameModalOpen).toBe(true);
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().renameModalOpen).toBe(false);
    expect(h.performRename).not.toHaveBeenCalled();
  });

  it("hides the reanalyze button when reanalyze_admin_only is enabled for non-admins or in mix modes", () => {
    render(<PlayMenu />);
    expect(
      document.getElementById("reanalyze-bpm")?.classList.contains("hidden"),
    ).toBe(false);

    act(() => {
      useAppStore.setState({
        appConfig: {
          allow_user_upload: false,
          allow_user_url: false,
          reanalyze_admin_only: true,
        },
      });
    });
    expect(
      document.getElementById("reanalyze-bpm")?.classList.contains("hidden"),
    ).toBe(true);

    cleanup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    render(<PlayMenu />);
    expect(
      document.getElementById("reanalyze-bpm")?.classList.contains("hidden"),
    ).toBe(false);

    act(() => {
      useAppStore.setState({ multiTrackEnabled: true });
    });
    expect(
      document.getElementById("reanalyze-bpm")?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("submits BPM reanalysis for 2x and prevents non-admin submit when locked", async () => {
    const user = userEvent.setup();
    render(<PlayMenu />);

    await user.click(document.getElementById("reanalyze-bpm")!);
    expect(useAppStore.getState().reanalyzeModalOpen).toBe(true);
    expect(document.getElementById("reanalyze-current-bpm")?.textContent).toBe(
      "93 BPM (1x)",
    );

    const submit = document.getElementById(
      "reanalyze-bpm-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.click(document.getElementById("reanalyze-multiplier-2")!);
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    await waitFor(() => {
      expect(h.performReanalyze).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ jobId: "job1", currentMultiplier: 1 }),
        { bpmMultiplier: 2, bpmLocked: undefined },
      );
      expect(useAppStore.getState().reanalyzeModalOpen).toBe(false);
    });

    // Non-admin sees locked notice and cannot select or submit.
    h.getPendingReanalyze.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      currentTempoBpm: 93,
      currentMultiplier: 1,
      bpmLocked: true,
      adminKey: null,
    });
    await user.click(document.getElementById("reanalyze-bpm")!);
    expect(document.getElementById("reanalyze-locked-notice")).not.toBeNull();
    expect(
      (document.getElementById("reanalyze-multiplier-2") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.getElementById("reanalyze-bpm-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("allows admins to toggle BPM lock only, bails on job switch, and closes on Escape", async () => {
    const user = userEvent.setup();
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, "secret");
    h.getPendingReanalyze.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      currentTempoBpm: 93,
      currentMultiplier: 1,
      bpmLocked: false,
      adminKey: "secret",
    });
    render(<PlayMenu />);

    await user.click(document.getElementById("reanalyze-bpm")!);
    await user.click(document.getElementById("reanalyze-bpm-lock")!);
    const submit = document.getElementById(
      "reanalyze-bpm-submit",
    ) as HTMLButtonElement;
    expect(submit.textContent).toBe("Save lock");
    await user.click(submit);

    await waitFor(() => {
      expect(h.performReanalyze).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ jobId: "job1", adminKey: "secret" }),
        { bpmMultiplier: undefined, bpmLocked: true },
      );
    });

    // Bailout when job changes underneath open modal.
    await user.click(document.getElementById("reanalyze-bpm")!);
    await user.click(document.getElementById("reanalyze-multiplier-0_5")!);
    h.getPendingReanalyze.mockReturnValue({
      jobId: "job2",
      trackId: "track2",
      currentTempoBpm: 120,
      currentMultiplier: 1,
      bpmLocked: false,
      adminKey: "secret",
    });
    await user.click(document.getElementById("reanalyze-bpm-submit")!);
    await waitFor(() => {
      expect(useAppStore.getState().reanalyzeModalOpen).toBe(false);
    });
    expect(h.performReanalyze).toHaveBeenCalledTimes(1);

    // Escape closes without submitting.
    h.getPendingReanalyze.mockReturnValue({
      jobId: "job1",
      trackId: "track1",
      currentTempoBpm: 93,
      currentMultiplier: 1,
      bpmLocked: false,
      adminKey: "secret",
    });
    await user.click(document.getElementById("reanalyze-bpm")!);
    expect(useAppStore.getState().reanalyzeModalOpen).toBe(true);
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().reanalyzeModalOpen).toBe(false);
  });
});
