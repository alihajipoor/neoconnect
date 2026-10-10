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

const { cachedRoutesFor, clearSnapshot, loadSnapshot, planOf, saveSnapshot, standInRoutes } = await import(
  "./credential-cache"
);

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
      expect(fallback, path).toContain(
        "const standIn = standInRoutes(currentRoutes, routesShownRef.current, planOf(sub), load);",
      );
      expect(fallback, path).toContain("if (standIn !== null) {");
      expect(fallback, path).toContain("setRoutes(standIn);");
      // And that is the list the snapshot is written with.
      const written = screen.slice(write, screen.indexOf(");", write));
      expect(written, path).toContain("routes: currentRoutes,");
      expect(written, path).not.toContain("routes: []");
    }
  });
});

describe("what a load whose list failed puts on screen", () => {
  const germany = { id: "route-1", name: "Germany" } as RouteOption;
  const PLAN = "sub-1:plan-1";

  it("is the list cached for this plan, over whatever an earlier load showed", () => {
    expect(standInRoutes([germany], { plan: PLAN, load: 1 }, PLAN, 2)).toEqual([germany]);
    expect(standInRoutes([germany], { plan: null, load: 0 }, PLAN, 1)).toEqual([germany]);
  });

  /** A failed request never blanks a list the customer can use. */
  it("leaves this plan's list on screen when nothing is cached", () => {
    expect(standInRoutes([], { plan: PLAN, load: 1 }, PLAN, 2)).toBeNull();
  });

  /** The plan changed and the new plan's list failed, with nothing cached
   * for it. Before: the old plan's servers stayed, and the phone's picker
   * -- which now opens on the dashboard's list -- offered them; a pick
   * asked the server for a route the plan does not have. */
  it("takes another plan's list off the screen when nothing is cached for this one", () => {
    expect(standInRoutes([], { plan: "sub-1:plan-0", load: 1 }, PLAN, 2)).toEqual([]);
  });

  /** A server switch starts a load while the mount's is still waiting on
   * its list, and the switch's answers first. Before: the mount's then
   * failed, read the cache -- not yet holding the switch's list, which is
   * written without waiting -- and put the older list over the newer. */
  it("is nothing over a list a later load has put there", () => {
    expect(standInRoutes([germany], { plan: PLAN, load: 3 }, PLAN, 2)).toBeNull();
    expect(standInRoutes([], { plan: "other", load: 3 }, PLAN, 2)).toBeNull();
  });

  it("names a plan by its subscription and the plan it is on", () => {
    expect(planOf({ id: "sub-1", planId: "plan-1" })).toBe(PLAN);
  });

  it("is what both clients' screens do, and an overtaken load does not write the snapshot", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(screen, path).toContain("routesShownRef.current = { plan: planOf(sub), load };");
      const write = screen.indexOf("void saveSnapshot(", screen.indexOf("const routesResult = await getAvailableRoutes("));
      expect(screen.lastIndexOf("if (routesShownRef.current.load <= load) {", write), path).toBeGreaterThan(write - 400);
    }
  });
});

describe("a cached route list", () => {
  /** The tag is how the route did for people on the network the list was
   * fetched from. Before: a list cached on home Wi-Fi was shown on mobile
   * data with home Wi-Fi's "worked for most people on your network". */
  it("comes back without the tags of the network it was fetched on", async () => {
    const plan = { id: "sub-1", planId: "plan-1", status: "ACTIVE" } as Subscription;
    const tagged = {
      id: "route-1",
      name: "Germany",
      ispTag: { code: "worksOnYourIsp", customers: 6, outOf: 7, windowHours: 24 },
    } as unknown as RouteOption;
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [tagged] });

    const offline = (await loadSnapshot())!.routes;
    expect(offline).toEqual([{ id: "route-1", name: "Germany" }]);
    expect(offline[0]).not.toHaveProperty("ispTag");
    expect(await cachedRoutesFor(plan)).toEqual([{ id: "route-1", name: "Germany" }]);
  });
});
