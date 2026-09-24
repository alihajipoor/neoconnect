import { describe, expect, it } from "vitest";

import { displayedRoute, displayedRouteId } from "./displayed-route";

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
