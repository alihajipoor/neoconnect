import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The connected node's own mirror, on the phones.
 *
 * Measured on Windows on 2026-10-06 (Stealth to finland1, in the VM):
 * through a working tunnel every endpoint answered `/health/ip` with
 * finland1's address except finland1's own mirror, which answered the
 * VM's home address -- the Windows service routes the node's address
 * around the tunnel so the tunnel can reach its server.
 *
 * The phones do not, for most of what they run -- read from the source,
 * NOT measured on a device. Android's Xray is a VpnService routing
 * `0.0.0.0/0` into the tunnel with only xray-core's own sockets
 * `protect`ed, and this app's traffic deliberately inside
 * (NeoxifyTunService.kt); iOS claims the default route with a made-up
 * `tunnelRemoteAddress`, so nothing is excluded for the node
 * (PacketTunnelProvider.swift); WireGuard (GoBackend, and the same iOS
 * extension) protects its own socket and routes the rest. There the
 * app's request to the node's address goes through the tunnel, and the
 * node's mirror is as good a witness as any. IKEv2 is the system's own
 * client, whose routing is not ours to read: taken as "around", whose
 * mistake costs "not confirmed" rather than an accusation. Which is
 * which is `reachesServerAround` in the shared tunnel-server.ts; this
 * file builds every server through it.
 *
 * Only the transport is stood in for: a model of each routing and
 * nothing more. Addresses are RFC 5737 stand-ins. */

let endpoints: string[] = [];
vi.mock("@shared/lib/api-endpoints", () => ({ apiEndpoints: async () => endpoints }));
vi.mock("@shared/lib/network-identity", () => ({ rememberNetwork: () => undefined }));
// No public-internet probe on the phones.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));

const { captureBaselineIp, EGRESS_TIMEOUT_MS, setHealthIpTransport } = await import("@shared/lib/egress");
const { literalTunnelServer } = await import("@shared/lib/tunnel-server");
const { BASELINE_WALK_MS, confirmEgress, nodeAddressesOf, pollEgress, pollState, rungOutcome, takeBaseline } =
  await import("./tunnel-evidence");

const PHONE = "192.0.2.44";
const FINLAND = "203.0.113.41";
const GERMANY = "203.0.113.42";
const EDGE = "198.51.100.10";
const CDN = "https://api.example.test";
const CDN2 = "https://api2.example.test";
const CDN3 = "https://api3.example.test";
const FI_MIRROR = "https://fi1.example.test:2053/api";
const DE_MIRROR = "https://de1.example.test:2053/api";
const PEER: Record<string, string> = {
  [CDN]: EDGE,
  [CDN2]: EDGE,
  [CDN3]: EDGE,
  [FI_MIRROR]: FINLAND,
  [DE_MIRROR]: GERMANY,
};

/** The account's credentials: one per node. */
const USERS = [{ connection: { host: FINLAND } }, { connection: { host: GERMANY } }];
/** finland1 as each engine reaches it, decided by the real rule. */
const FI_IKEV2 = literalTunnelServer({ protocol: "IKEV2", connection: { host: FINLAND } }, "phone");
const FI_XRAY = literalTunnelServer({ protocol: "XRAY_VLESS_REALITY", connection: { host: FINLAND } }, "phone");
const FI_WIREGUARD = literalTunnelServer(
  { protocol: "WIREGUARD", connection: { host: FINLAND }, credentials: { endpoint: `${FINLAND}:51820` } },
  "phone",
);
/** How the branch under review treated every phone engine. */
const FI_AS_IF_AROUND = { addresses: [FINLAND], reachedAround: true };

const net = {
  /** The server the tunnel is dialled at, or null with none up. */
  tunnel: null as string | null,
  /** Where the tunnel's traffic leaves, when not the server itself: a
   * relay's exit. */
  exit: null as string | null,
  /** Whether the phone reaches the tunnel's own server around the tunnel. */
  around: false,
  dead: false,
  /** Endpoints the bare network refuses at once. */
  blockedBare: new Set<string>(),
  /** Endpoints the bare network black-holes until the request's timeout:
   * the panel hosts, filtered in Iran. */
  hangBare: new Set<string>(),
};
const asked: string[] = [];

setHealthIpTransport(async (base, timeoutMs) => {
  asked.push(base);
  const peer = PEER[base];
  const throughTunnel = net.tunnel !== null && !(peer === net.tunnel && net.around);
  if (throughTunnel && net.dead) throw new Error("no answer");
  if (!throughTunnel && net.hangBare.has(base)) {
    await new Promise((r) => setTimeout(r, timeoutMs));
    throw new Error("timed out");
  }
  if (!throughTunnel && net.blockedBare.has(base)) throw new Error("no answer");
  // Through the tunnel the request leaves from the exit -- which, for
  // the server's own mirror on a direct route, is that node handing on
  // our request from its own address.
  return { status: 200, body: { ip: throughTunnel ? (net.exit ?? net.tunnel) : PHONE }, peer };
});

const quick = { intervalMs: 5, timeoutMs: 40 };

afterEach(() => {
  vi.useRealTimers();
  endpoints = [];
  net.tunnel = null;
  net.exit = null;
  net.around = false;
  net.dead = false;
  net.blockedBare.clear();
  net.hangBare.clear();
  asked.length = 0;
});

describe("which engines are taken to reach their server which way", () => {
  it("through for Xray and WireGuard, around for IKEv2", () => {
    expect(FI_XRAY.reachedAround).toBe(false);
    expect(FI_WIREGUARD.reachedAround).toBe(false);
    expect(FI_IKEV2.reachedAround).toBe(true);
  });
});

describe("IKEv2, where the server is taken to be reached around the tunnel", () => {
  // The Windows finding, run through the phones' code: the mirror of the
  // node being connected to is the last endpoint that worked.

  it("was the baseline, and a working tunnel read as not carrying", async () => {
    // The control. Our nodes' addresses are passed, as the dashboard
    // does, and do not help: this mirror reports the phone, not its node.
    net.around = true;
    endpoints = [FI_MIRROR, CDN];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS) });
    expect(baseline?.from).toBe(FI_MIRROR);
    net.tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict?.state).toBe("bypassingTunnel");
    expect(pollState("unverified", await pollEgress(baseline))).toBe("degraded");
  });

  it("is passed over, and the tunnel is proven on the rung and on every poll", async () => {
    net.around = true;
    endpoints = [FI_MIRROR, CDN];
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_IKEV2 });
    expect(baseline).toEqual({ ip: PHONE, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true, tunnelServer: FI_IKEV2 });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: FINLAND });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("connected");
    expect(pollState("unverified", await pollEgress(baseline, FI_IKEV2))).toBe("connected");
  });

  it("is not trusted on the poll even when an older baseline did come from it", async () => {
    // The poll asks the baseline's endpoint first. With that endpoint on
    // the tunnel's server it walks the list instead, and can only say
    // nothing was compared -- never "NOT protected".
    net.around = true;
    endpoints = [FI_MIRROR, CDN];
    net.tunnel = FINLAND;
    const fromMirror = { ip: PHONE, from: FI_MIRROR, peer: FINLAND };
    expect(pollState("unverified", await pollEgress(fromMirror, FI_IKEV2))).toBe("unverified");
  });

  it("is proven on the last rung when the list has moved on, because the baseline never came from that mirror", async () => {
    net.around = true;
    endpoints = [FI_MIRROR, CDN];
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_IKEV2 });
    endpoints = [CDN, FI_MIRROR];
    net.tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, tunnelServer: FI_IKEV2 });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("connected");
  });

  it("does not keep a dead tunnel 'not confirmed' through the one mirror reached around it", async () => {
    net.around = true;
    endpoints = [FI_MIRROR, CDN];
    const baseline = { ip: PHONE, from: CDN, peer: EDGE };
    net.tunnel = FINLAND;
    net.dead = true;
    // As it was: the mirror's answer was a reading from another endpoint.
    expect((await pollEgress(baseline)).state).toBe("indeterminate");
    // Passed over, nothing at all answered.
    expect(pollState("unverified", await pollEgress(baseline, FI_IKEV2))).toBe("degraded");
  });
});

describe("Xray and WireGuard, where the server is reached through the tunnel", () => {
  // A shutdown in Iran: the panel hosts and every other mirror are
  // filtered on the bare line, and the only endpoint answering is the
  // mirror of the node the customer connects to -- the in-country relay,
  // say. Its answer before connecting is the phone; through the tunnel
  // it is the node, or a relay's exit.

  function shutdown() {
    net.blockedBare.add(CDN).add(DE_MIRROR);
    endpoints = [FI_MIRROR, CDN, DE_MIRROR];
  }

  it("lost its only proof when every engine was taken to route around", async () => {
    // The control: the branch under review passed over that mirror on
    // every phone engine. No baseline, so the rung could only land as
    // "Connected, not confirmed".
    shutdown();
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_AS_IF_AROUND });
    expect(baseline).toBeNull();
    net.tunnel = FINLAND;
    const verdict = await confirmEgress(baseline, { ...quick, tunnelServer: FI_AS_IF_AROUND });
    expect(rungOutcome(verdict!, { baselineTaken: false, isLast: true })).toBe("unverified");
  });

  it("keeps that mirror as the baseline and proves the tunnel through it", async () => {
    for (const server of [FI_XRAY, FI_WIREGUARD]) {
      shutdown();
      const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: server });
      expect(baseline).toEqual({ ip: PHONE, from: FI_MIRROR, peer: FINLAND });
      net.tunnel = FINLAND;
      // It names the very address it was fetched from, and is believed:
      // it is the baseline's own endpoint, on the tunnel's server, and
      // its baseline answer named the phone, not itself.
      const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true, tunnelServer: server });
      expect(verdict).toEqual({ state: "throughTunnel", exitIp: FINLAND });
      expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("connected");
      expect(pollState("unverified", await pollEgress(baseline, server))).toBe("connected");
      net.tunnel = null;
      net.blockedBare.clear();
    }
  });

  it("proves a relay through its entry's mirror, which sees the exit", async () => {
    shutdown();
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_XRAY });
    net.tunnel = FINLAND;
    net.exit = GERMANY;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true, tunnelServer: FI_XRAY });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: GERMANY });
  });

  it("still accuses a tunnel that carries nothing through that mirror", async () => {
    // Were the phone in fact to route the server around the tunnel --
    // the unmeasured half of this -- the mirror would answer the phone's
    // own address, and it is read as what it would be: not carrying.
    // Exactly what the phones did before any of this; the rule changes
    // nothing there.
    shutdown();
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_XRAY });
    net.tunnel = FINLAND;
    net.around = true;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true, tunnelServer: FI_XRAY });
    expect(verdict?.state).toBe("bypassingTunnel");
  });

  it("sees a dead tunnel", async () => {
    shutdown();
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_XRAY });
    net.tunnel = FINLAND;
    net.dead = true;
    expect(pollState("unverified", await pollEgress(baseline, FI_XRAY))).toBe("degraded");
  });
});

describe("the last rung on a network that filters the panel host", () => {
  // The baseline comes from what answers on the bare line -- another
  // node's mirror -- while through the tunnel the panel host at the head
  // of the list answers first.

  it("proves the tunnel through the baseline's own endpoint", async () => {
    net.blockedBare.add(CDN);
    endpoints = [CDN, DE_MIRROR];
    const baseline = await takeBaseline({ nodeAddresses: nodeAddressesOf(USERS), tunnelServer: FI_XRAY });
    expect(baseline?.from).toBe(DE_MIRROR);
    net.tunnel = FINLAND;
    asked.length = 0;
    const verdict = await confirmEgress(baseline, { ...quick, tunnelServer: FI_XRAY });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: FINLAND });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("connected");
    expect(asked[0]).toBe(DE_MIRROR);
  });
});

describe("a phone's baseline, within a ceiling", () => {
  // In Iran the panel hosts lead the list and hang until their timeout.
  // With the last-good mirror passed over -- an IKEv2 rung on its node --
  // the walk used to go on into them, six seconds each, with no ceiling.

  function iran() {
    net.around = true;
    net.hangBare.add(CDN).add(CDN2).add(CDN3);
    endpoints = [FI_MIRROR, CDN, CDN2, CDN3, DE_MIRROR];
  }

  it("walked the filtered hosts one after another, past any ceiling", async () => {
    // The control: the capture the dashboard used to make.
    vi.useFakeTimers();
    iran();
    let result: unknown = "pending";
    void captureBaselineIp({ nodeAddresses: [], tunnelServer: FI_IKEV2 }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(BASELINE_WALK_MS + 100);
    expect(result).toBe("pending");
    // Three whole timeouts later it reached the mirror.
    await vi.advanceTimersByTimeAsync(EGRESS_TIMEOUT_MS);
    expect(result).toEqual({ ip: PHONE, from: DE_MIRROR, peer: GERMANY });
  });

  it("reaches the next working mirror in a few seconds", async () => {
    vi.useFakeTimers();
    iran();
    let result: unknown = "pending";
    void takeBaseline({ nodeAddresses: [], tunnelServer: FI_IKEV2 }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(3_500);
    expect(result).toEqual({ ip: PHONE, from: DE_MIRROR, peer: GERMANY });
  });

  it("ends with nothing by its ceiling when nothing answers", async () => {
    vi.useFakeTimers();
    const list = Array.from({ length: 20 }, (_, i) => `https://n${i}.example.test/api`);
    for (const base of list) net.hangBare.add(base);
    endpoints = list;
    let result: unknown = "pending";
    void takeBaseline({ nodeAddresses: [] }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(BASELINE_WALK_MS + 50);
    expect(result).toBeNull();
    expect(BASELINE_WALK_MS).toBe(2 * EGRESS_TIMEOUT_MS);
  });
});

describe("the phone dashboard", () => {
  const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("names each rung's server, as this platform reaches it, to its baseline, its check and the health poll", () => {
    expect(source).toContain('tunnelServer = await tunnelServerOf(candidate, "phone");');
    expect(source).toContain("await takeBaseline({ nodeAddresses, tunnelServer })");
    expect(source).toMatch(/confirmEgress\(baseline, \{[^}]*tunnelServer,[^}]*\}\)/);
    expect(source).toContain("tunnelServerRef.current = tunnelServer;");
    expect(source).toContain("pollEgress(baselineIp, tunnelServerRef.current ?? undefined)");
  });

  it("takes the pass's first baseline again only when it came from a server reached around the tunnel", () => {
    expect(source).toContain("baseline = askedAroundTunnel(pendingBaseline, tunnelServer)");
  });

  it("resolves a later rung's server only once the last rung's tunnel is gone", () => {
    const later = source.slice(source.indexOf("const nothingUp = await waitForTeardown();"));
    expect(later.indexOf("const nothingUp = await waitForTeardown();")).toBe(0);
    expect(later.indexOf('tunnelServer = await tunnelServerOf(candidate, "phone");')).toBeGreaterThan(0);
  });

  it("takes every baseline within the ceiling", () => {
    // `takeBaseline` and nothing else: a bare capture has no ceiling.
    expect(source).not.toContain("captureBaselineIp(");
    expect(source.match(/await takeBaseline\(/g)?.length).toBe(4);
  });
});
