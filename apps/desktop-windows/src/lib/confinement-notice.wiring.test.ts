import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Windows dashboard's half of the IPv4-confinement warning, which the
 * pure tests in connection-evidence.test.ts cannot reach: the dashboard
 * needs a Tauri runtime and the helper service. What can be pinned is that
 * every status the screen reads decides the warning by the tested rule
 * (`warnsUnconfined`), that the headline is told, and that the line is
 * shown while the tunnel is up. Each assertion fails against the dashboard
 * before the service could say `ipv4Confined: false`. */

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

describe("the IPv4 confinement warning", () => {
  it("is decided by the tested rule from every status the screen reads", () => {
    const reads = dashboard.match(/setIpv6Blocked\(Boolean\(status\.ipv6Blocked\)\);/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    const decided =
      dashboard.match(/setIpv4NotConfined\(warnsUnconfined\(status, Boolean\(status\.splitTunnelActive\)\)\);/g) ?? [];
    expect(decided.length).toBe(reads.length);
  });

  it("keeps the headline from saying 'protected' over it", () => {
    expect(dashboard).toMatch(/headlineFor\(connectionState, \{[^}]*unconfined: ipv4NotConfined[^}]*\}\)/);
  });

  it("is shown in words while the tunnel is up", () => {
    expect(dashboard).toContain('{isTunnelUp(connectionState) && ipv4NotConfined ? (');
    expect(dashboard).toContain('t("dash.ipv4NotConfined")');
  });
});
