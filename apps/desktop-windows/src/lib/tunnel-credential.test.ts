import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * Seen on the VM (0.9.51, and again on the redesign): connected to
 * Singapore on Stealth -- the exit the Singapore node, the service
 * reporting XRAY_VLESS_REALITY -- then Settings and back, and the screen
 * named the UK and "Stealth Web". The UK on Stealth Web was the pin; the
 * ladder had walked past it to Singapore.
 *
 * The Dashboard unmounts while Settings is open, and the credential the
 * tunnel was on was the screen's own state. The screen mounted on return
 * picked the pin's credential as every load does, adopted the service's
 * "connected", and the tiles' rule for a live tunnel -- name the settled
 * route -- read the pin as the settled route.
 *
 * The screen needs a Tauri runtime, a helper service and a network, so
 * the remount is played here through the same functions it calls, and
 * its wiring is pinned by source in dashboard-remount.test.ts.
 * ------------------------------------------------------------------ */

/** The store's files, kept for the life of the test file as the store
 * module keeps its handle: cleared between tests, never replaced. */
const files = new Map<string, Map<string, unknown>>();
const fileNamed = (name: string) => {
  let data = files.get(name);
  if (!data) {
    data = new Map<string, unknown>();
    files.set(name, data);
  }
  return data;
};
const store = { failing: false };
const unavailable = () => {
  if (store.failing) throw new Error("store unavailable");
};
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    unavailable();
    const kept = fileNamed(name);
    return {
      get: async (key: string) => (unavailable(), kept.get(key)),
      set: async (key: string, value: unknown) => (unavailable(), void kept.set(key, value)),
      delete: async (key: string) => (unavailable(), void kept.delete(key)),
      save: async () => unavailable(),
    };
  },
}));

const { credentialOnTunnel, tunnelCredential } = await import("./tunnel-credential");
const { displayedProtocol, displayedRoute, routeNameable } = await import("./displayed-route");

/** Lets a fire-and-forget write land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ukWeb = {
  id: "pu-uk-web",
  routeId: "uk-web",
  protocol: "XRAY_VLESS_TLS" as const,
  connection: { transport: "WS" },
};
const sgStealth = {
  id: "pu-sg-reality",
  routeId: "sg-reality",
  protocol: "XRAY_VLESS_REALITY" as const,
  connection: {},
};
const deStealth = {
  id: "pu-de-reality",
  routeId: "de-reality",
  protocol: "XRAY_VLESS_REALITY" as const,
  connection: {},
};
const held = [ukWeb, sgStealth, deStealth];
const routes = [
  { id: "uk-web", label: "UK", protocol: "XRAY_VLESS_TLS" as const, transport: "WS" },
  { id: "sg-reality", label: "Singapore", protocol: "XRAY_VLESS_REALITY" as const },
  { id: "de-reality", label: "Germany", protocol: "XRAY_VLESS_REALITY" as const },
];
const pin = ukWeb.routeId;

/** What a Dashboard's load puts on screen: the pin's credential, or the
 * first (`loadScreen`, `showCached`). */
const loadedCredential = (users: readonly (typeof ukWeb | typeof sgStealth)[]) =>
  users.find((u) => u.routeId === pin) ?? users[0] ?? null;

beforeEach(() => {
  for (const data of files.values()) data.clear();
  store.failing = false;
  tunnelCredential.reset();
});

afterEach(() => {
  tunnelCredential.reset();
});

describe("a Dashboard mounted over a tunnel the ladder moved off the pin", () => {
  it("names the route the tunnel is on, not the pin, once back from Settings", async () => {
    // The pass: the pin first, refused; Singapore on Stealth next, landed.
    tunnelCredential.dialling(ukWeb);
    tunnelCredential.dialling(sgStealth);
    // Settings opened and closed: a new screen, which loads the pin's
    // credential and asks the service.
    let shown = loadedCredential(held);
    expect(shown?.routeId).toBe("uk-web");
    const status = { connected: true, protocol: "XRAY_VLESS_REALITY" };
    const on = credentialOnTunnel(await tunnelCredential.last(), status.protocol, held);
    if (on !== null) shown = on;

    const known = on !== null;
    expect(displayedRoute(routes, "connected", shown?.routeId, pin, shown?.routeId, known)?.label).toBe("Singapore");
    expect(displayedProtocol("connected", shown, pin, held, routes, known)).toEqual({ protocol: "XRAY_VLESS_REALITY" });
  });

  it("is what the screen without the dial named -- the pin, on the wrong protocol", () => {
    // The same remount with nothing kept beyond the screen: the 0.9.51
    // result, kept here so the difference stays visible.
    const shown = loadedCredential(held);
    expect(displayedRoute(routes, "connected", shown?.routeId, pin, shown?.routeId)?.label).toBe("UK");
    expect(displayedProtocol("connected", shown, pin, held, routes)).toEqual({
      protocol: "XRAY_VLESS_TLS",
      transport: "WS",
    });
  });

  it("names no route over a tunnel adopted without a name, and the route once a read of the service names it", async () => {
    // The pass landed on Singapore; Settings and back. The load puts the
    // pin on screen, and with it no name for a tunnel (`showLoadedCredential`).
    await tunnelCredential.dialling(ukWeb);
    await tunnelCredential.dialling(sgStealth);
    let shown = loadedCredential(held);
    let known = false;
    // Its own read of the service timed out: "unknown", where the tiles
    // describe the next connect, as on any screen with nothing up.
    expect(displayedRoute(routes, "unknown", shown?.routeId, pin, shown?.routeId, known)?.label).toBe("UK");
    // Whatever then puts "connected" on screen without naming the tunnel
    // names it as nothing -- not the UK on Stealth Web.
    expect(displayedRoute(routes, "connected", shown?.routeId, pin, shown?.routeId, known)).toBeNull();
    expect(displayedProtocol("connected", shown, pin, held, routes, known)).toBeNull();
    // The recheck of "unknown", eight seconds on, reads "connected" and
    // names it from the last dial, as adoption does (`syncNamingTunnel`).
    const on = credentialOnTunnel(await tunnelCredential.last(), "XRAY_VLESS_REALITY", held);
    if (on !== null) shown = on;
    known = on !== null;
    expect(displayedRoute(routes, "connected", shown?.routeId, pin, shown?.routeId, known)?.label).toBe("Singapore");
    expect(displayedProtocol("connected", shown, pin, held, routes, known)).toEqual({ protocol: "XRAY_VLESS_REALITY" });
  });

  it("uses the credential as the screen now holds it, by id", async () => {
    await tunnelCredential.dialling(sgStealth);
    const refreshed = { ...sgStealth, connection: { serverName: "renewed" } };
    expect(credentialOnTunnel(await tunnelCredential.last(), "XRAY_VLESS_REALITY", [ukWeb, refreshed])).toBe(refreshed);
  });
});

describe("a fresh app over a tunnel the service kept up", () => {
  it("names the last dial, which outlives the process", async () => {
    tunnelCredential.dialling(sgStealth);
    await settle();
    // The window closed and opened again: nothing in memory.
    tunnelCredential.reset();
    expect(credentialOnTunnel(await tunnelCredential.last(), "XRAY_VLESS_REALITY", held)).toBe(sgStealth);
  });

  it("names nothing when nothing was ever recorded", async () => {
    expect(await tunnelCredential.last()).toBeNull();
    expect(credentialOnTunnel(null, "XRAY_VLESS_REALITY", held)).toBeNull();
  });

  it("names nothing, and does not throw, when the record cannot be read or written", async () => {
    store.failing = true;
    expect(() => tunnelCredential.dialling(sgStealth)).not.toThrow();
    await settle();
    tunnelCredential.reset();
    expect(await tunnelCredential.last()).toBeNull();
  });

  it("ignores a stored record of the wrong shape", async () => {
    fileNamed("failover.json").set("tunnelDial", { id: 7 });
    expect(await tunnelCredential.last()).toBeNull();
  });
});

describe("credentialOnTunnel", () => {
  it("names nothing when the service runs another protocol than the last dial", () => {
    // Not that dial's tunnel, whatever it is: no route is named for it.
    expect(credentialOnTunnel({ id: sgStealth.id, protocol: sgStealth.protocol }, "XRAY_VLESS_TLS", held)).toBeNull();
  });

  it("names nothing when the dialled credential is not one this screen holds", () => {
    // Another account's, from before a sign-out, or one withdrawn since.
    expect(credentialOnTunnel({ id: "pu-elsewhere", protocol: "XRAY_VLESS_REALITY" }, "XRAY_VLESS_REALITY", held)).toBeNull();
  });

  it("trusts the dial when the service names no protocol", () => {
    expect(credentialOnTunnel({ id: deStealth.id, protocol: deStealth.protocol }, null, held)).toBe(deStealth);
  });

  it("tells two routes on one protocol apart by the dial, never by the protocol", () => {
    expect(credentialOnTunnel({ id: deStealth.id, protocol: deStealth.protocol }, "XRAY_VLESS_REALITY", held)).toBe(
      deStealth,
    );
  });
});

describe("a tunnel the screen cannot name", () => {
  it.each(["connected", "verifying", "unverified", "degraded"] as const)(
    "names no server and no protocol in %s, rather than the pin",
    (state) => {
      const shown = loadedCredential(held);
      expect(displayedRoute(routes, state, shown?.routeId, pin, shown?.routeId, false)).toBeNull();
      expect(displayedProtocol(state, shown, pin, held, routes, false)).toBeNull();
    },
  );

  it.each(["connected", "verifying", "unverified", "degraded"] as const)(
    "is a route the phone, which reads its credential directly, does not name in %s",
    (state) => {
      expect(routeNameable(state, false)).toBe(false);
      expect(routeNameable(state, true)).toBe(true);
    },
  );

  it.each(["disconnected", "connecting", "disconnecting", "unknown"] as const)(
    "goes back to naming the next connect in %s",
    (state) => {
      const shown = loadedCredential(held);
      expect(displayedRoute(routes, state, shown?.routeId, pin, shown?.routeId, false)?.label).toBe("UK");
      expect(displayedProtocol(state, shown, pin, held, routes, false)).toEqual({
        protocol: "XRAY_VLESS_TLS",
        transport: "WS",
      });
      expect(routeNameable(state, false)).toBe(true);
    },
  );
});
