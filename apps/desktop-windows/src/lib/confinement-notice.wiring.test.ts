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
    const decidedAfterRead =
      dashboard.match(
        /setIpv6Blocked\(Boolean\(status\.ipv6Blocked\)\);\s*setIpv4NotConfined\(warnsUnconfined\(status, Boolean\(status\.splitTunnelActive\)\)\);/g,
      ) ?? [];
    expect(decidedAfterRead.length).toBe(reads.length);
  });

  it("keeps the headline from saying 'protected' over it", () => {
    expect(dashboard).toMatch(/headlineFor\(connectionState, \{[^}]*unconfined: ipv4NotConfined[^}]*\}\)/);
  });

  it("tells the endpoint order on every status read, so a confined session never asks its server's mirrors", () => {
    const reads = dashboard.match(/setIpv6Blocked\(Boolean\(status\.ipv6Blocked\)\);/g) ?? [];
    const told =
      dashboard.match(
        /setIpv4NotConfined\(warnsUnconfined\(status, Boolean\(status\.splitTunnelActive\)\)\);\s*setConfinedAround\(status\.ipv4Confined === true\);/g,
      ) ?? [];
    expect(told.length).toBe(reads.length);
    expect(dashboard).toContain('import { setConfinedAround } from "../lib/connected-mirrors";');
  });

  it("is read once a full-tunnel rung is up, before its egress check asks the order", () => {
    const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
    const connect = ladder.indexOf('await invoke("vpn_connect", {');
    const egress = ladder.indexOf("const egress = await confirmEgress(");
    const read = ladder.indexOf("setConfinedAround(status.ipv4Confined === true);", connect);
    expect(connect).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(connect);
    expect(read).toBeLessThan(egress);
  });

  it("is shown in words while the tunnel is up", () => {
    expect(dashboard).toContain('{isTunnelUp(connectionState) && ipv4NotConfined ? (');
    expect(dashboard).toContain("t(unconfinedKey)");
  });

  it("keeps the VPN mode's own line from contradicting it", () => {
    expect(dashboard).toContain(
      'isTunnelUp(connectionState) && ipv4NotConfined ? "dash.modeVpnHintNotConfined" : "dash.modeVpnHint"',
    );
  });

  it("takes its words from the tested rule on every status the screen reads", () => {
    const reads = dashboard.match(/setIpv4NotConfined\(warnsUnconfined\(status, Boolean\(status\.splitTunnelActive\)\)\);/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    const worded = dashboard.match(/setUnconfinedKey\(unconfinedLine\(status\)\);/g) ?? [];
    expect(worded.length).toBe(reads.length);
  });
});
