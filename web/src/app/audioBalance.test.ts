import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_BALANCE_STORAGE_KEY,
  resolveStoredAudioBalance,
  storeAudioBalance,
} from "./audioBalance";

function setLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  } as Storage;
  return store;
}

describe("autocanonizer audio balance preference", () => {
  beforeEach(() => {
    setLocalStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to centered balance when storage is empty", () => {
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: 0,
      otherPan: 0,
      pinkPan: 0,
      goldPan: 0,
    });
  });

  it("persists and reads clamped stream pans under the audioBalance key", () => {
    storeAudioBalance(-45, 70);
    expect(localStorage.getItem(AUDIO_BALANCE_STORAGE_KEY)).toBe(
      JSON.stringify({ blue: -45, green: 70, pink: 0, gold: 0 }),
    );
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: -45,
      otherPan: 70,
      pinkPan: 0,
      goldPan: 0,
    });

    storeAudioBalance(-150, 150, -120, 130);
    expect(localStorage.getItem(AUDIO_BALANCE_STORAGE_KEY)).toBe(
      JSON.stringify({ blue: -100, green: 100, pink: -100, gold: 100 }),
    );
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: -100,
      otherPan: 100,
      pinkPan: -100,
      goldPan: 100,
    });
  });

  it("reads legacy 2-voice entries and falls back non-numeric pink/gold fields to zero", () => {
    localStorage.setItem(
      AUDIO_BALANCE_STORAGE_KEY,
      JSON.stringify({ blue: -25, green: 40 }),
    );
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: -25,
      otherPan: 40,
      pinkPan: 0,
      goldPan: 0,
    });

    localStorage.setItem(
      AUDIO_BALANCE_STORAGE_KEY,
      JSON.stringify({ blue: 10, green: -10, pink: "left", gold: 65 }),
    );
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: 10,
      otherPan: -10,
      pinkPan: 0,
      goldPan: 65,
    });
  });

  it("ignores malformed or non-numeric stored values", () => {
    localStorage.setItem(AUDIO_BALANCE_STORAGE_KEY, "{not-json");
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: 0,
      otherPan: 0,
      pinkPan: 0,
      goldPan: 0,
    });

    localStorage.setItem(
      AUDIO_BALANCE_STORAGE_KEY,
      JSON.stringify({ blue: "left", green: 25, pink: 10, gold: 20 }),
    );
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: 0,
      otherPan: 0,
      pinkPan: 0,
      goldPan: 0,
    });
  });

  it("falls back to centered balance when storage is unavailable", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => storeAudioBalance(-50, 50, -30, 30)).not.toThrow();
    expect(resolveStoredAudioBalance()).toEqual({
      mainPan: 0,
      otherPan: 0,
      pinkPan: 0,
      goldPan: 0,
    });
  });
});
