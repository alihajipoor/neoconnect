import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, unknown>();
let failOpen = false;
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    failOpen
      ? Promise.reject(new Error("store unavailable"))
      : Promise.resolve({
          get: (key: string) => Promise.resolve(saved.get(key)),
          set: (key: string, value: unknown) => {
            saved.set(key, value);
            return Promise.resolve();
          },
          save: () => Promise.resolve(),
        }),
}));

import { appPrefs, DEFAULT_PREFS, readPrefs } from "./app-prefs";

beforeEach(() => {
  saved.clear();
  failOpen = false;
  appPrefs.resetForTests();
});

describe("the device's preferences", () => {
  it("start from the owner's defaults: nothing connects or blocks unless asked, notifications on", () => {
    expect(DEFAULT_PREFS).toEqual({ autoConnect: false, notifications: true, blockWhileReconnecting: false });
    expect(appPrefs.current()).toEqual(DEFAULT_PREFS);
    expect(appPrefs.loaded()).toBe(false);
  });

  it("read only booleans: anything else on disk is the default, never on", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs("on")).toEqual(DEFAULT_PREFS);
    expect(readPrefs({ autoConnect: "yes", blockWhileReconnecting: 1, notifications: false })).toEqual({
      autoConnect: false,
      notifications: false,
      blockWhileReconnecting: false,
    });
    expect(readPrefs({ autoConnect: true, blockWhileReconnecting: true })).toEqual({
      autoConnect: true,
      notifications: true,
      blockWhileReconnecting: true,
    });
  });

  it("load what was saved, once per run, and tell whoever listens", async () => {
    saved.set("prefs", { autoConnect: true, notifications: false, blockWhileReconnecting: true });
    const heard = vi.fn();
    appPrefs.subscribe(heard);
    const first = appPrefs.load();
    const second = appPrefs.load();
    expect(await first).toEqual({ autoConnect: true, notifications: false, blockWhileReconnecting: true });
    expect(await second).toBe(await first);
    expect(appPrefs.loaded()).toBe(true);
    expect(heard).toHaveBeenCalled();
  });

  it("save a change at once here and on disk", async () => {
    await appPrefs.load();
    await appPrefs.set("blockWhileReconnecting", true);
    expect(appPrefs.current().blockWhileReconnecting).toBe(true);
    expect(saved.get("prefs")).toEqual({ autoConnect: false, notifications: true, blockWhileReconnecting: true });
  });

  it("keep a change made while the store was still being read", async () => {
    saved.set("prefs", { autoConnect: true, notifications: true, blockWhileReconnecting: false });
    const loading = appPrefs.load();
    await appPrefs.set("autoConnect", false);
    await loading;
    expect(appPrefs.current().autoConnect).toBe(false);
  });

  it("are the defaults when the store cannot be opened, and still change for this run", async () => {
    failOpen = true;
    expect(await appPrefs.load()).toEqual(DEFAULT_PREFS);
    await appPrefs.set("notifications", false);
    expect(appPrefs.current().notifications).toBe(false);
  });
});
