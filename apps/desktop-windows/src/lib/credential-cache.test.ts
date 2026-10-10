import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolUser, RouteOption, Subscription } from "./types";

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

const { cachedRoutesFor, clearSnapshot, loadSnapshot, saveSnapshot } = await import("./credential-cache");

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

describe("the server list, when only its request fails", () => {
  const plan = { id: "sub-1", planId: "plan-1", status: "ACTIVE" } as Subscription;
  const germany = { id: "route-1", name: "Germany" } as RouteOption;
  const finland = { id: "route-2", name: "Finland" } as RouteOption;

  it("is the one cached for this plan", async () => {
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [germany, finland] });
    // The plan as this load fetched it: the same subscription, with
    // whatever else about it has moved on since.
    await expect(cachedRoutesFor({ ...plan, dataUsedBytes: "1024" })).resolves.toEqual([germany, finland]);
  });

  it("is nothing for another subscription, or for this one on another plan", async () => {
    // Changing plans is a new subscription, and the old plan's servers
    // are not this one's to offer.
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [germany] });
    await expect(cachedRoutesFor({ ...plan, id: "sub-2" })).resolves.toEqual([]);
    await expect(cachedRoutesFor({ ...plan, planId: "plan-2" })).resolves.toEqual([]);
  });

  it("is nothing when there is no cache, or the cache has no plan", async () => {
    await expect(cachedRoutesFor(plan)).resolves.toEqual([]);
    await saveSnapshot({ subscription: null, protocolUsers: [credential], routes: [germany] });
    await expect(cachedRoutesFor(plan)).resolves.toEqual([]);
  });

  it("is what both clients' screens show and cache in its place, never an empty list", async () => {
    // What the screens did: a load whose list did not answer cached an
    // empty one beside the fresh credentials, and the next start with
    // Neoxify out of reach had no servers to show. Run through the store,
    // the way the screen's two steps run.
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [germany, finland] });
    const kept = await cachedRoutesFor(plan);
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: kept });
    expect((await loadSnapshot())?.routes).toEqual([germany, finland]);

    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const asked = screen.indexOf('const routesResult = await getAvailableRoutes(sub.id, routeList.trace("routes"));');
      const write = screen.indexOf("void saveSnapshot(", asked);
      expect(asked, path).toBeGreaterThan(screen.indexOf("async function load"));
      const load = screen.slice(asked, write);
      // Answered: the answer. Not: this plan's cached list, on screen only
      // when there is one, so a failed request blanks nothing.
      const answered = load.indexOf("if (routesResult.ok) {");
      const failed = load.indexOf("} else {", answered);
      expect(answered, path).toBeGreaterThan(0);
      expect(failed, path).toBeGreaterThan(answered);
      expect(load.slice(answered, failed), path).toContain("currentRoutes = routesResult.data;");
      const fallback = load.slice(failed);
      expect(fallback, path).toContain("currentRoutes = await cachedRoutesFor(sub);");
      expect(fallback, path).toContain("if (currentRoutes.length > 0) setRoutes(currentRoutes);");
      // And that is the list the snapshot is written with.
      const written = screen.slice(write, screen.indexOf(");", write));
      expect(written, path).toContain("routes: currentRoutes,");
      expect(written, path).not.toContain("routes: []");
    }
  });
});
