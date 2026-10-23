import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

// After an automatic protocol switch the screen holds the credential the
// session ended on. The idle PROTOCOL tile named it, and the location
// picker marked its route as the current one -- while Connect dialled the
// pin first. Both now name the route the SERVER tile names.
describe("the idle screen names what Connect dials", () => {
  it("the PROTOCOL tile reads displayedProtocol, not the credential the last session ended on", () => {
    expect(dashboard).toContain("displayedProtocol(connectionState, protocolUser, chosenRouteId, protocolUsers, routes, tunnelNamed)");
    expect(dashboard).not.toContain("customerProtocolLabel(protocolUser.protocol");
  });

  it("the location picker marks the route the SERVER tile names as current", () => {
    expect(dashboard).not.toContain("currentRouteId={protocolUser?.routeId}");
    // The same route, held through a brief gap with the chip's colour
    // (`heldListLook`), from the same `screenRouteId`.
    expect(dashboard).toContain("currentRouteId={listLook.routeId ?? undefined}");
    expect(dashboard).toContain("routeId: screenRouteId, settledRouteId: listSettledRef.current");
    expect(dashboard).toContain("if (settledNow) listSettledRef.current = screenRouteId;");
    expect(dashboard).toContain(
      "const screenRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed);",
    );
  });
});
