import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

// The world map's lights are honest only if the screen feeds them honest
// inputs: this device's history only as recorded on a verified verdict, the
// calm tone rather than the raw state, and a connected route taken only
// from a moment the tunnel was verified. map-lights.test.ts pins what the
// function does with them; this pins that the screen gives it those.
describe("the main page feeds the map's lights", () => {
  it("records an attempt as a success only on a verified verdict", () => {
    expect(dashboard).toMatch(/recordAttempt\(\s*history,\s*networkId,\s*candidate\.routeId,\s*candidate\.protocol,\s*verdict === "connected",\s*\)/);
  });

  it("takes the connected place only from a verified tunnel, and never in gaming mode", () => {
    expect(dashboard).toContain(
      'if (!gaming && connectionState === "connected" && currentRoute) verifiedRouteRef.current = currentRoute;',
    );
    expect(dashboard).toContain("verified: gaming ? null : verifiedRouteRef.current,");
  });

  it("draws it under the calm tone the screen wears, and judges on this network", () => {
    expect(dashboard).toContain("tone: calmTone,");
    expect(dashboard).toContain("network: networkId,");
    expect(dashboard).toMatch(/const mapScene = mapLights\(\{\s*routes,\s*history,/);
  });

  it("gives the map no latency", () => {
    const call = dashboard.slice(dashboard.indexOf("const mapScene = mapLights({"), dashboard.indexOf("const mapPlaces"));
    expect(call).not.toMatch(/latenc/i);
  });
});
