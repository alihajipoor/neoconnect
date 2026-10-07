import { afterEach, describe, expect, it, vi } from "vitest";

/** The tunnel's own server, as the egress check meets it.
 *
 * Measured on 2026-10-06, in the VM, on the 0.9.45 candidate, connected
 * on Stealth to finland1 with the tunnel verifiably carrying traffic:
 * `health_ip_v4` through the tunnel answered finland1's address from
 * every endpoint -- the panel and CDN hosts and the other nodes' mirrors
 * -- except finland1's own mirror, which answered the VM's home address.
 * The client routes the node's own address around the tunnel (the host
 * route that lets the tunnel reach its server), so a request to that
 * mirror never enters the tunnel. The dashboard said "Connected, not
 * confirmed" where 0.9.44 said "You're protected".
 *
 * The real `verifyEgress`, `confirmEgressWithin` and `captureBaselineIp`
 * run below; only the transport is stood in for, and it is a model of
 * that routing and nothing more: an endpoint on the tunnel's server is
 * answered from the customer's own line, every other one through the
 * tunnel. It reports the address it connected to, as `health_ip_v4`
 * now does. Addresses are RFC 5737 stand-ins (docs/node-address-hygiene.md). */

const endpoints = vi.fn<() => Promise<string[]>>();
vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));

/** `probe_ipv4_egress`, Windows' public-internet probe. Unset, it fails
 * like a command that is not registered -- the phones' case. */
const internet = vi.fn<() => Promise<boolean> | undefined>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) =>
    command === "probe_ipv4_egress"
      ? (internet() ?? Promise.reject(new Error("not registered")))
      : Promise.reject(new Error(`unexpected ${command}`)),
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));

const { captureBaselineIp, confirmEgressWithin, fromTunnelServer, setHealthIpTransport, verifyEgress } =
  await import("./egress");

/** The customer's own line. */
const HOME = "192.0.2.228";
/** finland1: the tunnel's server, and its exit. */
const FINLAND = "203.0.113.41";
/** Another node, with a mirror of its own. */
const GERMANY = "203.0.113.42";
/** The CDN's edge, which the panel hosts are reached at. */
const EDGE = "198.51.100.10";

const CDN = "https://connect.example.test/api";
const FI_MIRROR = "https://fi1.example.test:2053/api";
const DE_MIRROR = "https://de1.example.test:2053/api";
const PEER: Record<string, string> = { [CDN]: EDGE, [FI_MIRROR]: FINLAND, [DE_MIRROR]: GERMANY };

/** The network. */
const net = {
  /** The server the tunnel is dialled at, or null with none up. */
  tunnel: null as string | null,
  /** A tunnel that is up and carries nothing. */
  dead: false,
  /** Endpoints the bare network blocks -- the panel hosts, in Iran. */
  blockedBare: new Set<string>(),
  /** Mirrors installed without NEOXIFY_PANEL_ORIGIN: they proxy through
   * the CDN, which names the node, so they answer with their own node's
   * address whoever asks. */
  selfReporting: new Set<string>(),
  /** Mirrors answering with an error page. */
  erroring: new Set<string>(),
};
const asked: string[] = [];

/** `health_ip_v4` on that network. */
async function modelTransport(base: string) {
  asked.push(base);
  const peer = PEER[base];
  // The host route: the tunnel's own server is reached around it.
  const throughTunnel = net.tunnel !== null && peer !== net.tunnel;
  if (throughTunnel && net.dead) throw new Error("no answer");
  if (!throughTunnel && net.blockedBare.has(base)) throw new Error("no answer");
  if (net.erroring.has(base)) return { status: 502, body: null, peer };
  const ip = net.selfReporting.has(base) ? peer : throughTunnel ? net.tunnel! : HOME;
  return { status: 200, body: { ip }, peer };
}
setHealthIpTransport(modelTransport);

const FI = new Set([FINLAND]);
const THROUGH = { state: "throughTunnel", exitIp: FINLAND };

afterEach(() => {
  endpoints.mockReset();
  internet.mockReset();
  net.tunnel = null;
  net.dead = false;
  net.blockedBare.clear();
  net.selfReporting.clear();
  net.erroring.clear();
  asked.length = 0;
});

describe("the model", () => {
  it("answers as measured: the node's own mirror with the home address, the rest with the node's", async () => {
    // Nothing here is the code under test; it shows the stand-in behaves
    // as the VM did, so the tests below are about that network.
    net.tunnel = FINLAND;
    endpoints.mockResolvedValue([FI_MIRROR]);
    await expect(captureBaselineIp()).resolves.toEqual({ ip: HOME, from: FI_MIRROR, peer: FINLAND });
    endpoints.mockResolvedValue([CDN, DE_MIRROR]);
    await expect(captureBaselineIp()).resolves.toEqual({ ip: FINLAND, from: CDN, peer: EDGE });
  });
});

describe("(b) the connected node's mirror leads the list", () => {
  // The last endpoint that worked leads `apiEndpoints()`, and on a
  // network where the panel hosts are blocked that is a mirror -- here
  // the mirror of the very node the customer connects to.

  it("took the baseline from that mirror, and then read a working tunnel as bypassing it", async () => {
    // The control, as 0.9.44/0.2.23 ask: no server named.
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp();
    expect(baseline?.from).toBe(FI_MIRROR);
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "bypassingTunnel", exitIp: HOME });
  });

  it("takes the baseline from the next endpoint, and proves the tunnel", async () => {
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });

    net.tunnel = FINLAND;
    // The health poll, in list order.
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual(THROUGH);
    // The ladder's earlier rungs, asking the baseline's endpoint alone.
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual(THROUGH);
    // The ladder itself, and the last rung.
    await expect(
      confirmEgressWithin(baseline, 2_000, { sameEndpointOnly: true, intervalMs: 20, tunnelServer: FI }),
    ).resolves.toEqual(THROUGH);
    await expect(confirmEgressWithin(baseline, 2_000, { intervalMs: 20, tunnelServer: FI })).resolves.toEqual(
      THROUGH,
    );
  });

  it("never accuses the tunnel over a baseline that did come from that mirror", async () => {
    // A baseline taken before the server was known -- when the screen
    // loaded, or by an older client. Comparing it with anything now is
    // impossible: its endpoint can only be asked around the tunnel. So
    // no verdict either way, and not a strike.
    const fromMirror = { ip: HOME, from: FI_MIRROR, peer: FINLAND };
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    net.tunnel = FINLAND;
    await expect(verifyEgress(fromMirror, { tunnelServer: FI })).resolves.toEqual({
      state: "indeterminate",
      exitIp: FINLAND,
    });
    // Asked to use that endpoint alone, it walks the list instead: the
    // one endpoint it would ask cannot answer through the tunnel, and its
    // silence would read as a dead tunnel where no probe says otherwise.
    asked.length = 0;
    await expect(verifyEgress(fromMirror, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual({
      state: "indeterminate",
      exitIp: FINLAND,
    });
    expect(asked).toEqual([FI_MIRROR, CDN]);
  });
});

describe("(a) the reading comes from another endpoint", () => {
  it("left a working tunnel unconfirmed when the list moved on after the baseline", async () => {
    // The control. The baseline came from the node's mirror; once
    // connected the app's API traffic made the CDN the last good
    // endpoint, so the reading came from there: no comparison.
    endpoints.mockResolvedValueOnce([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp();
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: FINLAND });
  });

  it("proves it, because the baseline never came from that mirror", async () => {
    endpoints.mockResolvedValueOnce([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI });
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual(THROUGH);
  });

  it("proves it on a censored network through the rung's own endpoint", async () => {
    // Iran: the panel hosts are blocked on the bare network, so the
    // baseline comes from a mirror -- not the node's own, now, but the
    // next one. The rung asks that one, through the tunnel.
    net.blockedBare.add(CDN);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    const baseline = await captureBaselineIp({ tunnelServer: FI });
    expect(baseline).toEqual({ ip: HOME, from: DE_MIRROR, peer: GERMANY });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual(THROUGH);
  });
});

describe("a dead tunnel", () => {
  it("is not vouched for by the node's own mirror, which answers around it", async () => {
    // The tunnel carries nothing; only the mirror on its own server
    // answers, with the home address, because it is not in the tunnel.
    // Read as a reading, that was "indeterminate" -- "not confirmed",
    // no strike, no failover -- on Windows as much as on a phone, since
    // the public-internet probe is only asked when nothing answered.
    const baseline = { ip: HOME, from: CDN, peer: EDGE };
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    net.tunnel = FINLAND;
    net.dead = true;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: HOME });

    // Passed over, nothing answered: unreachable, where the probe is
    // silent too (Windows) and where there is no probe (the phones).
    internet.mockResolvedValue(false);
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual({ state: "unreachable" });
    internet.mockReset();
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual({ state: "unreachable" });
  });

  it("is not vouched for by an error page from that mirror either, where nothing else can be asked", async () => {
    // The phones' rule: an error page from one of ours is a round trip,
    // so "no verdict". Not one that went around the tunnel.
    const baseline = { ip: HOME, from: CDN, peer: EDGE };
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    net.erroring.add(FI_MIRROR);
    net.tunnel = FINLAND;
    net.dead = true;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: null });
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual({ state: "unreachable" });
  });
});

describe("a mirror that reports its own node's address", () => {
  // Installed without NEOXIFY_PANEL_ORIGIN: it proxies through the CDN,
  // which names the node, so it answers everyone with the node's address.

  /** The same network, with the address each request connected to
   * hidden, as the plugin's fetch hides it -- how every reading looked
   * to the check before `health_ip_v4` reported it. */
  async function withoutPeers<T>(run: () => Promise<T>): Promise<T> {
    setHealthIpTransport(async (base) => {
      const { status, body } = await modelTransport(base);
      return { status, body };
    });
    try {
      return await run();
    } finally {
      setHealthIpTransport(modelTransport);
    }
  }

  it("was compared with itself when it was the connected node's", async () => {
    // The control: its own address became the baseline, and came
    // straight back from around the tunnel.
    net.selfReporting.add(FI_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    await withoutPeers(async () => {
      const baseline = await captureBaselineIp({ tunnelServer: FI });
      expect(baseline).toEqual({ ip: FINLAND, from: FI_MIRROR });
      net.tunnel = FINLAND;
      await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual({
        state: "bypassingTunnel",
        exitIp: FINLAND,
      });
    });
  });

  it("is still never compared with itself when it is the connected node's", async () => {
    net.selfReporting.add(FI_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual(THROUGH);
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual(THROUGH);
  });

  it("is passed over as a baseline when it is another node's, on Windows too", async () => {
    // The phones pass every node address they know (`nodeAddresses`);
    // Windows passes none, and took such a baseline. Asked again through
    // the working tunnel, the same mirror gave the same address back:
    // `bypassingTunnel`. An answer that is the very address the request
    // connected to is the endpoint describing itself, never the caller.
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual(THROUGH);
    // And while connected, its answer is passed over too.
    await expect(verifyEgress(baseline, { tunnelServer: FI })).resolves.toEqual(THROUGH);
    expect(asked.slice(-2)).toEqual([DE_MIRROR, CDN]);
  });

  it("would otherwise have been the baseline, and read the tunnel as a leak", async () => {
    // The control for the test above.
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    await withoutPeers(async () => {
      const baseline = await captureBaselineIp({ tunnelServer: FI });
      expect(baseline).toEqual({ ip: GERMANY, from: DE_MIRROR });
      net.tunnel = FINLAND;
      await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI })).resolves.toEqual({
        state: "bypassingTunnel",
        exitIp: GERMANY,
      });
    });
  });
});

describe("fromTunnelServer", () => {
  it("knows a reading's endpoint only when the transport said where it connected", () => {
    expect(fromTunnelServer({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, FI)).toBe(true);
    expect(fromTunnelServer({ ip: HOME, from: FI_MIRROR, peer: `::ffff:${FINLAND}` }, [FINLAND])).toBe(true);
    expect(fromTunnelServer({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, [` ${FINLAND} `])).toBe(true);
    expect(fromTunnelServer({ ip: HOME, from: CDN, peer: EDGE }, FI)).toBe(false);
    expect(fromTunnelServer({ ip: HOME, from: FI_MIRROR }, FI)).toBe(false);
    expect(fromTunnelServer(null, FI)).toBe(false);
    expect(fromTunnelServer({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, undefined)).toBe(false);
  });
});
