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

const {
  cachedRoutesFor,
  clearSnapshot,
  isSnapshotStale,
  loadSnapshot,
  maySaveSnapshot,
  NO_ROUTES_SHOWN,
  noteCredentialsShown,
  planOf,
  resetShownCredentialsForTests,
  routesForSnapshot,
  saveSnapshot,
  standInRoutes,
  takesRouteList,
  updateSnapshotProtocolUsers,
  updateSnapshotRoutes,
} = await import("./credential-cache");

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
      const guard = screen.lastIndexOf('if (sessionGeneration() !== sessionAtStart) return "answered";', write);
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
      // Answered: the answer, on screen unless a later load's answer is.
      // Not: this plan's list already held, on screen only when there is
      // one, so a failed request blanks nothing.
      const answered = load.indexOf("if (routesResult.ok) {");
      const failed = load.indexOf("} else {", answered);
      expect(answered, path).toBeGreaterThan(0);
      expect(failed, path).toBeGreaterThan(answered);
      expect(load.slice(answered, failed), path).toContain("currentRoutes = routesResult.data;");
      expect(load.slice(answered, failed), path).toContain("if (takesRouteList(routesShownRef.current, load)) {");
      const fallback = load.slice(failed);
      expect(fallback, path).toContain("const cachedRoutes = await cachedRoutesFor(sub);");
      expect(fallback, path).toContain("const standIn = standInRoutes(cachedRoutes, shown, planOf(sub), load);");
      expect(fallback, path).toContain("currentRoutes = routesForSnapshot(standIn, shown, planOf(sub), cachedRoutes);");
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
  const finland = { id: "route-2", name: "Finland" } as RouteOption;
  const PLAN = "sub-1:plan-1";
  const shown = (plan: string | null, load: number, routes: RouteOption[] = [], answered = false) => ({
    plan,
    load,
    routes,
    answered,
  });

  it("is the list cached for this plan, when the screen holds none of this plan's", () => {
    expect(standInRoutes([germany], shown(PLAN, 1), PLAN, 2)).toEqual([germany]);
    expect(standInRoutes([germany], NO_ROUTES_SHOWN, PLAN, 1)).toEqual([germany]);
    expect(standInRoutes([germany], shown("sub-1:plan-0", 1, [finland]), PLAN, 2)).toEqual([germany]);
  });

  /** An earlier load of this screen put this plan's list there, and its
   * write to the cache had not landed. Before: the older cached list
   * replaced it, on screen and in the snapshot. */
  it("is nothing over this plan's list already on screen, which is at least as new as the cache", () => {
    expect(standInRoutes([germany], shown(PLAN, 1, [finland], true), PLAN, 2)).toBeNull();
  });

  /** A failed request never blanks a list the customer can use. */
  it("leaves this plan's list on screen when nothing is cached", () => {
    expect(standInRoutes([], shown(PLAN, 1, [germany]), PLAN, 2)).toBeNull();
  });

  /** The plan changed and the new plan's list failed, with nothing cached
   * for it. Before: the old plan's servers stayed, and the phone's picker
   * -- which now opens on the dashboard's list -- offered them; a pick
   * asked the server for a route the plan does not have. */
  it("takes another plan's list off the screen when nothing is cached for this one", () => {
    expect(standInRoutes([], shown("sub-1:plan-0", 1, [germany]), PLAN, 2)).toEqual([]);
  });

  /** A server switch starts a load while the mount's is still waiting on
   * its list, and the switch's answers first. Before: the mount's then
   * failed, read the cache -- not yet holding the switch's list, which is
   * written without waiting -- and put the older list over the newer. */
  it("is nothing over a list a later load has put there", () => {
    expect(standInRoutes([germany], shown(PLAN, 3, [finland], true), PLAN, 2)).toBeNull();
    expect(standInRoutes([], shown("other", 3), PLAN, 2)).toBeNull();
  });

  it("names a plan by its subscription and the plan it is on", () => {
    expect(planOf({ id: "sub-1", planId: "plan-1" })).toBe(PLAN);
  });
});

describe("what a load writes into the snapshot when its list failed", () => {
  const germany = { id: "route-1", name: "Germany" } as RouteOption;
  const PLAN = "sub-1:plan-1";

  /** The screen kept this plan's list from an earlier load, and nothing
   * readable was cached for it -- the earlier load's write had failed, or
   * not landed. Before: the snapshot was written with no servers, and the
   * next start with Neoxify out of reach opened the picker on none. */
  it("is the list on screen for this plan, not the empty cache", () => {
    const onScreen = { plan: PLAN, load: 1, routes: [germany], answered: true };
    const standIn = standInRoutes([], onScreen, PLAN, 2);
    expect(standIn).toBeNull();
    expect(routesForSnapshot(standIn, onScreen, PLAN, [])).toEqual([germany]);
  });

  it("is what was put on screen in its place, when something was", () => {
    expect(routesForSnapshot([germany], NO_ROUTES_SHOWN, PLAN, [germany])).toEqual([germany]);
  });
});

describe("which load's list and snapshot stand", () => {
  const germany = { id: "route-1", name: "Germany" } as RouteOption;
  const PLAN = "sub-1:plan-1";

  /** The mount's route list was slow; a server switch's load answered and
   * wrote first. Before: the mount's list then replaced the newer one on
   * screen, and its snapshot -- pre-switch credentials -- was written over
   * the newer one with a fresh time. */
  it("is not an overtaken load's answer over a later load's answer", () => {
    expect(takesRouteList({ plan: PLAN, load: 2, routes: [germany], answered: true }, 1)).toBe(false);
    expect(maySaveSnapshot(2, 1)).toBe(false);
  });

  /** A later load fell back to the cache, which says nothing newer than an
   * earlier load's answer. Before: that load, which writes nothing, kept
   * the earlier one from writing its fresh credentials. */
  it("is an earlier load's answer over a later load's cached fallback", () => {
    expect(takesRouteList({ plan: PLAN, load: 2, routes: [germany], answered: false }, 1)).toBe(true);
    expect(maySaveSnapshot(0, 1)).toBe(true);
  });

  it("is a later load's, always", () => {
    expect(takesRouteList({ plan: PLAN, load: 1, routes: [germany], answered: true }, 2)).toBe(true);
    expect(maySaveSnapshot(1, 2)).toBe(true);
  });

  /** Read from the source, for both clients: the guard is on which load
   * last wrote, and is claimed by the load that writes. */
  it("is what both clients' screens do", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const write = screen.indexOf("void saveSnapshot(", screen.indexOf("const routesResult = await getAvailableRoutes("));
      const guard = screen.lastIndexOf("if (maySaveSnapshot(snapshotWriterRef.current, load)) {", write);
      expect(guard, path).toBeGreaterThan(write - 400);
      expect(screen.slice(guard, write), path).toContain("snapshotWriterRef.current = load;");
      expect(screen, path).not.toContain("if (routesShownRef.current.load <= load) {");
    }
  });
});

describe("a refresh's late answer", () => {
  const user = (serverName: string) =>
    ({ ...credential, connection: { privateKey: "secret", serverName } }) as unknown as ProtocolUser;
  const plan = { id: "sub-1", planId: "plan-1", status: "ACTIVE" } as Subscription;

  /** Two refreshes, each out of budget; the older one's answer lands
   * first. Before: compared with when the snapshot was saved, the newer
   * answer was then thrown away as superseded, and the older kept. */
  it("is ordered by when it was asked, not by when it landed", async () => {
    resetShownCredentialsForTests();
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [], askedAt: 0 });
    const t0 = Date.now();
    expect(await updateSnapshotProtocolUsers([user("first")], undefined, t0)).toBe("written");
    expect(await updateSnapshotProtocolUsers([user("second")], undefined, t0 + 7)).toBe("written");
    expect((await loadSnapshot())!.protocolUsers).toEqual([user("second")]);
    // And the older, landing last, is not written over the newer.
    expect(await updateSnapshotProtocolUsers([user("first")], undefined, t0)).toBe("superseded");
  });

  /** A newer answer was adopted and its write not awaited; an older late
   * answer then read the snapshot before that write landed. Before: it
   * passed, and was put on screen over the newer one. */
  it("is not taken over credentials already shown that were asked for later", async () => {
    resetShownCredentialsForTests();
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [], askedAt: 0 });
    const askedAt = Date.now();
    noteCredentialsShown(askedAt + 5);
    expect(await updateSnapshotProtocolUsers([user("older")], undefined, askedAt)).toBe("superseded");
    expect((await loadSnapshot())!.protocolUsers).toEqual([credential]);
  });

  /** Read from the source: both screens' loads say when theirs were asked
   * for, the moment they put them on screen. */
  it("is ordered against what both clients' loads put on screen", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const shown = screen.indexOf("setProtocolUsers(usersResult.data);");
      expect(shown, path).toBeGreaterThan(0);
      expect(screen.indexOf("noteCredentialsShown(askedAt);", shown), path).toBeGreaterThan(shown);
      expect(screen.indexOf("noteCredentialsShown(askedAt);", shown), path).toBeLessThan(
        screen.indexOf("await getAvailableRoutes(", shown),
      );
      expect(screen, path).toMatch(/askedAt,\s*\},\s*\(\) => sessionGeneration\(\) === sessionAtStart,/);
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

describe("the server list's own answer, written into the snapshot", () => {
  const plan = { id: "sub-1", planId: "plan-1", status: "ACTIVE" } as Subscription;
  const germany = { id: "route-1", name: "Germany" } as RouteOption;

  /** Before: the picker's list stayed in the picker, and the snapshot kept
   * no servers, so the next start with Neoxify out of reach had none. */
  it("replaces the cached list for the same plan", async () => {
    await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [] });
    expect(await updateSnapshotRoutes(plan, [germany])).toBe("written");
    expect((await loadSnapshot())!.routes).toEqual([germany]);
    expect((await loadSnapshot())!.protocolUsers).toEqual([credential]);
  });

  /** A route list says nothing about the credentials beside it. Before: the
   * picker's list rewrote a three-day-old snapshot as saved just now, and
   * for the next ten minutes Connect and the refresh on resume took its
   * credentials as fresh and asked nothing -- the server's REALITY SNI had
   * changed the day before -- and the offline banner said the plan had
   * been updated just now. */
  it("leaves the credentials as old as they were, and only an answer about them makes them fresh", async () => {
    const first = Date.parse("2026-10-07T09:00:00Z");
    const later = first + 3 * 24 * 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(first);
    try {
      await saveSnapshot({ subscription: plan, protocolUsers: [credential], routes: [] });
      clock.mockReturnValue(later);

      expect(await updateSnapshotRoutes(plan, [germany])).toBe("written");
      const adopted = (await loadSnapshot())!;
      expect(adopted.routes).toEqual([germany]);
      expect(adopted.savedAt).toBe(first);
      expect(adopted.askedAt).toBe(first);
      expect(isSnapshotStale(adopted, later)).toBe(true);

      // The credentials' own answer does.
      expect(await updateSnapshotProtocolUsers([credential])).toBe("written");
      const refreshed = (await loadSnapshot())!;
      expect(refreshed.savedAt).toBe(later);
      expect(refreshed.routes).toEqual([germany]);
      expect(isSnapshotStale(refreshed, later)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("is not written into another plan's snapshot, nor where nothing is cached", async () => {
    await expect(updateSnapshotRoutes(plan, [germany])).resolves.toBe("skipped");
    await saveSnapshot({ subscription: { ...plan, planId: "plan-0" }, protocolUsers: [credential], routes: [] });
    await expect(updateSnapshotRoutes(plan, [germany])).resolves.toBe("skipped");
    expect((await loadSnapshot())!.routes).toEqual([]);
  });
});
