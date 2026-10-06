import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolUser } from "./types";

/** The store, in memory. `load` resolves on a later tick, as the real
 * one does -- which is the window a sign-out lands in. */
const saved = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            get: (key: string) => Promise.resolve(saved.get(key)),
            set: (key: string, value: unknown) => {
              saved.set(key, value);
              return Promise.resolve();
            },
            delete: (key: string) => {
              saved.delete(key);
              return Promise.resolve();
            },
            save: () => Promise.resolve(),
          }),
        0,
      ),
    ),
}));

const { clearSnapshot, loadSnapshot, saveSnapshot } = await import("./credential-cache");

const credential = {
  id: "pu-1",
  routeId: "route-1",
  protocol: "WIREGUARD",
  connection: { privateKey: "secret" },
} as unknown as ProtocolUser;

afterEach(() => saved.clear());

describe("a snapshot written for a session that has ended", () => {
  it("is not written once the customer it belongs to has signed out", async () => {
    // The load was in flight when they signed out: its answer arrives
    // after the sign-out cleared the cache, and must not put the
    // signed-out customer's keys back on disk.
    let signedIn = true;
    await saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [] }, () => signedIn);
    // Sign-out: the session generation moves, then the cache is cleared.
    signedIn = false;
    await clearSnapshot();
    // The route list that was in flight answers now, and the load goes on
    // to write what it fetched before the sign-out.
    await saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [] }, () => signedIn);
    await expect(loadSnapshot()).resolves.toBeNull();
    // And a write that had already begun when the session ended asks at
    // the last moment, not only when it was called.
    signedIn = true;
    const write = saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [] }, () => signedIn);
    signedIn = false;
    await write;
    await expect(loadSnapshot()).resolves.toBeNull();
  });

  it("is written as before while the session is current, or with no question asked", async () => {
    await saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [] }, () => true);
    expect((await loadSnapshot())?.protocolUsers).toEqual([credential]);
    await clearSnapshot();
    await saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [] });
    expect((await loadSnapshot())?.protocolUsers).toEqual([credential]);
  });

  it("is guarded by the session generation in both clients' screens", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const write = screen.indexOf("void saveSnapshot(");
      const guard = screen.lastIndexOf("if (sessionGeneration() !== sessionAtStart) return;", write);
      expect(guard, path).toBeGreaterThan(screen.indexOf("async function loadAll("));
      expect(screen.slice(write, write + 400), path).toContain("() => sessionGeneration() === sessionAtStart");
    }
  });
});
