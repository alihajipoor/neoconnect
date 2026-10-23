import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { displayedProtocol, displayedRoute, displayedRouteId, heldListLook } from "./displayed-route";

const routes = [
  { id: "de-germany", label: "Germany" },
  { id: "sg-singapore", label: "Singapore" },
  { id: "fr-france", label: "France" },
];

describe("displayedRouteId", () => {
  it("names the pin while nothing is up, because that is what a connect will dial", () => {
    expect(displayedRouteId("disconnected", null, "de-germany", "fr-france")).toBe("de-germany");
  });

  it("falls back to the provisioned route when nothing is pinned", () => {
    expect(displayedRouteId("disconnected", null, null, "fr-france")).toBe("fr-france");
  });

  // The 0.2.18 bug, in one line. The pin is Germany, the ladder settled
  // on Singapore, and the tile used to go on saying Germany.
  it("names where traffic actually goes once connected, not the pin", () => {
    expect(displayedRouteId("connected", "sg-singapore", "de-germany", "de-germany")).toBe("sg-singapore");
  });

  it.each(["connected", "verifying", "unverified", "degraded"] as const)(
    "prefers the settled route in %s, because an engine is up",
    (state) => {
      expect(displayedRouteId(state, "sg-singapore", "de-germany", null)).toBe("sg-singapore");
    },
  );

  it.each(["disconnected", "disconnecting", "connecting", "unknown"] as const)(
    "ignores a stale settled route in %s, where no engine is carrying traffic",
    (state) => {
      expect(displayedRouteId(state, "sg-singapore", "de-germany", null)).toBe("de-germany");
    },
  );

  it("keeps naming the pin while connected if nothing settled yet", () => {
    expect(displayedRouteId("connected", null, "de-germany", null)).toBe("de-germany");
  });

  it("returns null when there is nothing to name at all", () => {
    expect(displayedRouteId("disconnected", null, null, null)).toBeNull();
  });
});

describe("displayedRoute", () => {
  it("resolves the settled route against the list", () => {
    expect(displayedRoute(routes, "connected", "sg-singapore", "de-germany", null)?.label).toBe("Singapore");
  });

  it("falls back to the pin when the settled route left the catalogue mid-session", () => {
    expect(displayedRoute(routes, "connected", "xx-withdrawn", "de-germany", null)?.label).toBe("Germany");
  });

  it("is null when no candidate is in the list", () => {
    expect(displayedRoute(routes, "connected", "xx-a", "xx-b", "xx-c")).toBeNull();
  });
});

// After an automatic protocol switch the screen held the credential the
// session ended on, and the PROTOCOL tile went on naming it once the
// tunnel was down -- while Connect dialled the pin first. Seen on the VM:
// Shadowsocks pinned, the ladder settled on Stealth, and the idle screen
// read "Stealth" over a Connect that dialled Shadowsocks.
describe("displayedProtocol", () => {
  const shadowsocks = { routeId: "fi-ss", protocol: "SHADOWSOCKS" as const, connection: {} };
  const stealth = { routeId: "fi-reality", protocol: "XRAY_VLESS_REALITY" as const, connection: {} };
  const web = { routeId: "fi-ws", protocol: "XRAY_VLESS_TLS" as const, connection: { transport: "WS" } };
  const held = [shadowsocks, stealth, web];
  const catalogue = [
    { id: "fi-ss", protocol: "SHADOWSOCKS" as const },
    { id: "fi-reality", protocol: "XRAY_VLESS_REALITY" as const },
    { id: "fi-ws", protocol: "XRAY_VLESS_TLS" as const, transport: "WS" },
  ];

  it.each(["disconnected", "disconnecting", "connecting", "unknown"] as const)(
    "names the pin's protocol in %s, because that is what Connect dials first",
    (state) => {
      expect(displayedProtocol(state, stealth, "fi-ss", held, catalogue)).toEqual({ protocol: "SHADOWSOCKS" });
    },
  );

  it.each(["connected", "verifying", "unverified", "degraded"] as const)(
    "names the protocol the tunnel is on in %s, not the pin",
    (state) => {
      expect(displayedProtocol(state, stealth, "fi-ss", held, catalogue)).toEqual({ protocol: "XRAY_VLESS_REALITY" });
    },
  );

  it("keeps the transport, which names Stealth Web apart from Stealth HTTPS", () => {
    expect(displayedProtocol("disconnected", stealth, "fi-ws", held, catalogue)).toEqual({
      protocol: "XRAY_VLESS_TLS",
      transport: "WS",
    });
  });

  it("reads a pin the screen holds no credential for from the route list", () => {
    expect(displayedProtocol("disconnected", stealth, "fi-ws", [stealth], catalogue)).toEqual({
      protocol: "XRAY_VLESS_TLS",
      transport: "WS",
    });
  });

  it("names what the screen holds when nothing is pinned, or the pin is nowhere", () => {
    expect(displayedProtocol("disconnected", stealth, null, held, catalogue)).toEqual({ protocol: "XRAY_VLESS_REALITY" });
    expect(displayedProtocol("disconnected", stealth, "xx-gone", held, catalogue)).toEqual({
      protocol: "XRAY_VLESS_REALITY",
    });
    expect(displayedProtocol("disconnected", null, null, [], [])).toBeNull();
  });

  // The PROTOCOL tile and the SERVER tile describe one route: whatever
  // the SERVER tile names, the PROTOCOL tile names that route's protocol.
  it("agrees with the SERVER tile in every state", () => {
    for (const state of ["disconnected", "connecting", "verifying", "connected", "degraded"] as const) {
      const server = displayedRouteId(state, stealth.routeId, "fi-ss", stealth.routeId);
      const route = catalogue.find((r) => r.id === server);
      expect(displayedProtocol(state, stealth, "fi-ss", held, catalogue)?.protocol, state).toBe(route?.protocol);
    }
  });
});

describe("heldListLook: the list's row in use through a brief gap", () => {
  // Connected on Germany (the ladder settled there, nothing pinned or a pin
  // elsewhere), then a 4 s reconnect the hold covers, then connected again.
  const settled = "de-germany";

  it("keeps the row and its words while the look is held", () => {
    // reconnectHeld: the service says connecting; the chip still wears connected.
    expect(heldListLook({ state: "connecting", look: "connected", routeId: "fr-france", settledRouteId: settled })).toEqual({ state: "connected", routeId: settled });
    expect(heldListLook({ state: "disconnected", look: "connected", routeId: null, settledRouteId: settled })).toEqual({ state: "connected", routeId: settled });
    // A brief unverified gap keeps "Connected here", as the colour keeps cobalt.
    expect(heldListLook({ state: "unverified", look: "connected", routeId: settled, settledRouteId: settled }).state).toBe("connected");
  });

  it("says what the state says once the hold ends, or when nothing is held", () => {
    expect(heldListLook({ state: "disconnected", look: "disconnected", routeId: "fr-france", settledRouteId: settled })).toEqual({ state: "disconnected", routeId: "fr-france" });
    expect(heldListLook({ state: "connected", look: "connected", routeId: settled, settledRouteId: settled })).toEqual({ state: "connected", routeId: settled });
    // A press shows at once: the hold has already let go (look === state).
    expect(heldListLook({ state: "connecting", look: "connecting", routeId: "fr-france", settledRouteId: settled }).routeId).toBe("fr-france");
  });

  it("never names a tunnel it could not name, through the gap either", () => {
    expect(heldListLook({ state: "connecting", look: "connected", routeId: "fr-france", settledRouteId: null })).toEqual({ state: "connected", routeId: null });
  });

  it("is wired where the list is drawn, from the held look", () => {
    for (const rel of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src, rel).toContain("const listLook = heldListLook({ state: connectionState, look: orbState, routeId: screenRouteId, settledRouteId: listSettledRef.current });");
      expect(src, rel).toContain("if (settledNow) listSettledRef.current = screenRouteId;");
      expect(src, rel).toContain("currentRouteId={listLook.routeId ?? undefined}");
      expect(src, rel).toContain("lookState={listLook.state}");
    }
  });
});
