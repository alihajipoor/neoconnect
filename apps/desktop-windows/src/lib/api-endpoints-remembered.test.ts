import { beforeEach, describe, expect, it, vi } from "vitest";

/** `rememberedEndpoint`, which a write walking addresses one at a time
 * reads before each step, to go next to an address another request has
 * just found (`followRemembered` in api.ts). */

/** The store, in memory. `pending` holds a write back from landing, as an
 * IPC write that has not finished yet would be. */
const files = new Map<string, Map<string, unknown>>();
const store = { failing: false, pending: false };
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    if (store.failing) throw new Error("store unavailable");
    let data = files.get(name);
    if (!data) {
      data = new Map<string, unknown>();
      files.set(name, data);
    }
    const kept = data;
    return {
      get: async (key: string) => kept.get(key),
      set: (key: string, value: unknown) =>
        store.pending ? new Promise<void>(() => undefined) : Promise.resolve(void kept.set(key, value)),
      save: async () => undefined,
    };
  },
}));

let endpoints: typeof import("./api-endpoints");

beforeEach(async () => {
  files.clear();
  store.failing = false;
  store.pending = false;
  // A fresh module is a fresh process.
  vi.resetModules();
  endpoints = await import("./api-endpoints");
});

describe("the remembered endpoint", () => {
  /** The store is written over IPC, and a walk reading it a moment after
   * another request remembered an address must not miss it. */
  it("is the one this process remembered, before the store has it", async () => {
    store.pending = true;
    void endpoints.rememberEndpoint("https://d.example/api");

    expect(await endpoints.rememberedEndpoint()).toBe("https://d.example/api");
  });

  it("is the store's copy in a process that has not remembered one", async () => {
    files.set("api-endpoints.json", new Map([["lastGood", "https://c.example/api"]]));

    expect(await endpoints.rememberedEndpoint()).toBe("https://c.example/api");
  });

  it("is unknown, not an error, when the store cannot be read", async () => {
    store.failing = true;

    await expect(endpoints.rememberedEndpoint()).resolves.toBeUndefined();
  });
});
