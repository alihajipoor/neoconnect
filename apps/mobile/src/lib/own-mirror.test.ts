import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The connected node's own mirror, on the phones.
 *
 * Measured on Windows on 2026-10-06 (Stealth to finland1, in the VM):
 * through a working tunnel every endpoint answered `/health/ip` with
 * finland1's address except finland1's own mirror, which answered the
 * VM's home address -- the client routes the node's address around the
 * tunnel so the tunnel can reach its server. The phones share the egress
 * check, `health_ip_v4` and these rules, so the same answer would do the
 * same here wherever the platform also keeps the server's address out
 * of the tunnel. Whether Android and iOS do is NOT measured; this is the
 * Windows finding run through the phones' code, with only the transport
 * stood in for (a model of that routing). Addresses are RFC 5737
 * stand-ins. */

let endpoints: string[] = [];
vi.mock("@shared/lib/api-endpoints", () => ({ apiEndpoints: async () => endpoints }));
vi.mock("@shared/lib/network-identity", () => ({ rememberNetwork: () => undefined }));
// No public-internet probe on the phones.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));

const { captureBaselineIp, setHealthIpTransport } = await import("@shared/lib/egress");
const { confirmEgress, nodeAddressesOf, pollEgress, pollState, rungOutcome } = await import("./tunnel-evidence");

const PHONE = "192.0.2.44";
const FINLAND = "203.0.113.41";
const GERMANY = "203.0.113.42";
const EDGE = "198.51.100.10";
const CDN = "https://api.example.test";
const FI_MIRROR = "https://fi1.example.test:2053/api";
const DE_MIRROR = "https://de1.example.test:2053/api";
const PEER: Record<string, string> = { [CDN]: EDGE, [FI_MIRROR]: FINLAND, [DE_MIRROR]: GERMANY };

/** The account's credentials: one per node. */
const USERS = [{ connection: { host: FINLAND } }, { connection: { host: GERMANY } }];
const FI = new Set([FINLAND]);

let tunnel: string | null = null;
let dead = false;
setHealthIpTransport(async (base) => {
  const peer = PEER[base];
  // The tunnel's own server is reached around it.
  const throughTunnel = tunnel !== null && peer !== tunnel;
  if (throughTunnel && dead) throw new Error("no answer");
  return { status: 200, body: { ip: throughTunnel ? tunnel : PHONE }, peer };
});

const quick = { intervalMs: 5, timeoutMs: 40 };

afterEach(() => {
  endpoints = [];
  tunnel = null;
  dead = false;
});

describe("(b) the connected node's mirror is the last endpoint that worked", () => {
  it("was the baseline, and a working tunnel read as not carrying", async () => {
    // The control. Our nodes' addresses are passed, as the dashboard
    // does, and do not help: this mirror reports the phone, not its node.
    endpoints = [FI_MIRROR, CDN];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS) });
    expect(baseline?.from).toBe(FI_MIRROR);
    tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict?.state).toBe("bypassingTunnel");
    expect(pollState("unverified", await pollEgress(baseline))).toBe("degraded");
  });

  it("is passed over, and the tunnel is proven on the rung and on every poll", async () => {
    endpoints = [FI_MIRROR, CDN];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI });
    expect(baseline).toEqual({ ip: PHONE, from: CDN, peer: EDGE });
    tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true, tunnelServer: FI });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: FINLAND });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("connected");
    expect(pollState("unverified", await pollEgress(baseline, FI))).toBe("connected");
  });

  it("is not trusted on the poll even when an older baseline did come from it", async () => {
    // The poll asks the baseline's endpoint first. With that endpoint on
    // the tunnel's server it walks the list instead, and can only say
    // nothing was compared -- never "NOT protected".
    endpoints = [FI_MIRROR, CDN];
    tunnel = FINLAND;
    const fromMirror = { ip: PHONE, from: FI_MIRROR, peer: FINLAND };
    expect(pollState("unverified", await pollEgress(fromMirror, FI))).toBe("unverified");
  });
});

describe("(a) the last rung reads another endpoint", () => {
  it("was left unconfirmed when the list had moved on", async () => {
    endpoints = [FI_MIRROR, CDN];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS) });
    endpoints = [CDN, FI_MIRROR];
    tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, quick);
    expect(verdict?.state).toBe("indeterminate");
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("unverified");
  });

  it("is proven, because the baseline never came from that mirror", async () => {
    endpoints = [FI_MIRROR, CDN];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI });
    endpoints = [CDN, FI_MIRROR];
    tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, tunnelServer: FI });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("connected");
  });
});

describe("a dead tunnel", () => {
  it("is not kept 'not confirmed' by the one mirror reached around it", async () => {
    endpoints = [FI_MIRROR, CDN];
    const baseline = { ip: PHONE, from: CDN, peer: EDGE };
    tunnel = FINLAND;
    dead = true;
    // As it was: the mirror's answer was a reading from another endpoint.
    expect((await pollEgress(baseline)).state).toBe("indeterminate");
    // Passed over, nothing at all answered.
    expect(pollState("unverified", await pollEgress(baseline, FI))).toBe("degraded");
  });
});

describe("the phone dashboard", () => {
  const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("names each rung's server to its baseline, its check and the health poll", () => {
    expect(source).toContain("const tunnelServer = await tunnelServerOf(candidate);");
    expect(source).toContain("captureBaselineIp({ nodeAddresses, tunnelServer })");
    expect(source).toMatch(/confirmEgress\(baseline, \{[^}]*tunnelServer,[^}]*\}\)/);
    expect(source).toContain("tunnelServerRef.current = tunnelServer;");
    expect(source).toContain("pollEgress(baselineIp, tunnelServerRef.current ?? undefined)");
  });

  it("takes the pass's first baseline again when it came from the first rung's server", () => {
    expect(source).toContain("pendingBaseline !== undefined && !fromTunnelServer(pendingBaseline, tunnelServer)");
  });
});
