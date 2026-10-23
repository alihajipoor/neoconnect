import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

// The world map's lights are honest only if the screen feeds them honest
// inputs: this device's history only as recorded on a verified verdict, the
// calm tone rather than the raw state, a connected route taken only from a
// moment the tunnel was verified, and evidence only about the network the
// device is on now. map-lights.test.ts and map-network.test.ts pin what the
// functions do with them; this pins that the screen gives them those.
describe("the main page feeds the map's lights", () => {
  it("records an attempt as a success only on a verified verdict", () => {
    expect(dashboard).toMatch(/recordAttempt\(\s*history,\s*networkId,\s*candidate\.routeId,\s*candidate\.protocol,\s*verdict === "connected",\s*\)/);
  });

  it("takes the connected place only from a verified tunnel, never in gaming mode, and not once the tunnel has moved", () => {
    expect(dashboard).toContain(
      'if (!gaming && connectionState === "connected" && currentRoute) verifiedRouteRef.current = currentRoute;',
    );
    expect(dashboard).toMatch(
      /const verifiedShown =\s*gaming \|\| \(settledNow && verifiedRouteRef\.current\?\.id !== currentRoute\?\.id\) \? null : verifiedRouteRef\.current;/,
    );
    expect(dashboard).toContain("verified: verifiedShown,");
    // The place a tunnel is up on is never drawn hollow.
    expect(dashboard).toContain("up: gaming || !settledNow ? null : currentRoute,");
  });

  it("draws it under the calm tone the screen wears, and judges on the network the device is on now", () => {
    expect(dashboard).toContain("tone: calmTone,");
    expect(dashboard).toContain("const mapRoutes = tagsCurrent(netFresh) ? routes : withoutTags(routes);");
    expect(dashboard).toContain("network: mapNetwork(networkId, netFresh),");
    expect(dashboard).toMatch(/const mapScene = mapLights\(\{\s*routes: mapRoutes,\s*\.\.\.evidenceCtx,/);
  });

  it("notices a roam under a tunnel and with nothing up, and asks which network this is again", () => {
    expect(dashboard).toContain("const moved = tunnelWayOut(before, step, next.seen);");
    expect(dashboard).toContain('if (moved !== null) noteRoam(moved === "moved" ? "tunnelUp" : "later");');
    expect(dashboard).toContain("const step = idleWayOut(seen, now);");
    expect(dashboard).toContain('if (step.roamed) noteRoam("now");');
    // The route list's tags are dated by the network reading it was asked with.
    expect(dashboard).toContain("const tagsAt = currentNetwork()?.at ?? Date.now();");
  });

  it("gives the list the same evidence, so its filter agrees with the map", () => {
    expect(dashboard).toContain("for (const [key, evidence] of placesEvidence(mapRoutes, evidenceCtx)) if (evidence.look === \"live\") workedPlaces.add(key);");
    expect(dashboard).toContain("evidence={listEvidence}");
  });

  it("gives the map no latency", () => {
    const call = dashboard.slice(dashboard.indexOf("const mapScene = mapLights({"), dashboard.indexOf("const mapPlaces"));
    expect(call).not.toMatch(/latenc/i);
  });
});
