import { afterEach, describe, expect, it, vi } from "vitest";

/** The tunnel's own server, as the egress check meets it.
 *
 * Measured on 2026-10-06, in the VM, on the 0.9.45 candidate, connected
 * on Stealth to finland1 with the tunnel verifiably carrying traffic:
 * `health_ip_v4` through the tunnel answered finland1's address from
 * every endpoint -- the panel and CDN hosts and the other nodes' mirrors
 * -- except finland1's own mirror, which answered the VM's home address.
 * The Windows service routes the node's own address around the tunnel
 * (the host route that lets the tunnel reach its server), so a request
 * to that mirror never enters the tunnel. The dashboard said "Connected,
 * not confirmed" where 0.9.44 said "You're protected".
 *
 * Not every engine routes it that way. The phones' Xray and WireGuard,
 * and wireguard.exe on Windows, keep only their own sockets off the
 * tunnel, so the app's request to the server's address goes through the
 * tunnel and reaches the node from inside it -- read from the source,
 * not measured. Both routings are modelled below (`net.route`).
 *
 * The real `verifyEgress`, `confirmEgressWithin` and `captureBaselineIp`
 * run below; only the transport is stood in for, and it is a model of
 * that routing and nothing more. It reports the address it connected
 * to, as `health_ip_v4` now does. Addresses are RFC 5737 stand-ins
 * (docs/node-address-hygiene.md). */

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

const {
  askedAroundTunnel,
  BASELINE_HEDGE_MS,
  captureBaselineIp,
  confirmEgressWithin,
  EGRESS_TIMEOUT_MS,
  setHealthIpTransport,
  verifyEgress,
} = await import("./egress");

/** The customer's own line. */
const HOME = "192.0.2.228";
/** finland1: the tunnel's server, and its exit unless a relay says not. */
const FINLAND = "203.0.113.41";
/** Another node, with a mirror of its own. */
const GERMANY = "203.0.113.42";
/** The CDN's edge, which the panel hosts are reached at. */
const EDGE = "198.51.100.10";

const CDN = "https://connect.example.test/api";
const CDN2 = "https://connect2.example.test/api";
const FI_MIRROR = "https://fi1.example.test:2053/api";
const DE_MIRROR = "https://de1.example.test:2053/api";
const PEER: Record<string, string> = { [CDN]: EDGE, [CDN2]: EDGE, [FI_MIRROR]: FINLAND, [DE_MIRROR]: GERMANY };

/** The network. */
const net = {
  /** The server the tunnel is dialled at, or null with none up. */
  tunnel: null as string | null,
  /** Where the tunnel's traffic leaves: the server itself, or a relay's
   * exit. */
  exit: null as string | null,
  /** How this client reaches the tunnel's own server address. */
  route: "around" as "around" | "through",
  /** A tunnel that is up and carries nothing. */
  dead: false,
  /** Endpoints the bare network refuses at once. */
  blockedBare: new Set<string>(),
  /** Endpoints the bare network black-holes: the request waits out its
   * whole timeout -- the panel hosts, filtered in Iran. */
  hangBare: new Set<string>(),
  /** Mirrors installed without NEOXIFY_PANEL_ORIGIN: they proxy through
   * the CDN, which names the node, so they answer with their own node's
   * address whoever asks. */
  selfReporting: new Set<string>(),
  /** Mirrors answering with an error page. */
  erroring: new Set<string>(),
};
const asked: string[] = [];

/** `health_ip_v4` on that network. */
async function modelTransport(base: string, timeoutMs: number) {
  asked.push(base);
  const peer = PEER[base];
  // The host route, where there is one: the tunnel's own server is then
  // reached around the tunnel. Without it, through it like the rest.
  const throughTunnel = net.tunnel !== null && !(peer === net.tunnel && net.route === "around");
  if (throughTunnel && net.dead) throw new Error("no answer");
  if (!throughTunnel && net.hangBare.has(base)) {
    await new Promise((r) => setTimeout(r, timeoutMs));
    throw new Error("timed out");
  }
  if (!throughTunnel && net.blockedBare.has(base)) throw new Error("no answer");
  if (net.erroring.has(base)) return { status: 502, body: null, peer };
  // Through the tunnel the request leaves from the exit -- which, for
  // the server's own mirror on a direct route, is that node handing on
  // our request from its own address.
  const caller = throughTunnel ? (net.exit ?? net.tunnel!) : HOME;
  const ip = net.selfReporting.has(base) ? peer : caller;
  return { status: 200, body: { ip }, peer };
}
setHealthIpTransport(modelTransport);

/** finland1, where the client routes it around the tunnel: Windows on
 * Stealth, as measured. */
const FI_AROUND = { addresses: [FINLAND], reachedAround: true };
/** finland1, where the app's request to it goes through the tunnel. */
const FI_THROUGH = { addresses: new Set([FINLAND]), reachedAround: false };
const THROUGH = { state: "throughTunnel", exitIp: FINLAND };

afterEach(() => {
  vi.useRealTimers();
  endpoints.mockReset();
  internet.mockReset();
  net.tunnel = null;
  net.exit = null;
  net.route = "around";
  net.dead = false;
  net.blockedBare.clear();
  net.hangBare.clear();
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

describe("(b) the connected node's mirror leads the list, reached around the tunnel", () => {
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
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });

    net.tunnel = FINLAND;
    // The health poll, in list order and baseline first.
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual(THROUGH);
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND, baselineFirst: true })).resolves.toEqual(THROUGH);
    // The ladder's earlier rungs, asking the baseline's endpoint alone.
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual(
      THROUGH,
    );
    // The ladder itself, and the last rung.
    await expect(
      confirmEgressWithin(baseline, 2_000, { sameEndpointOnly: true, intervalMs: 20, tunnelServer: FI_AROUND }),
    ).resolves.toEqual(THROUGH);
    await expect(
      confirmEgressWithin(baseline, 2_000, { intervalMs: 20, tunnelServer: FI_AROUND, baselineFirst: true }),
    ).resolves.toEqual(THROUGH);
  });

  it("never accuses the tunnel over a baseline that did come from that mirror", async () => {
    // A baseline taken before the server was known -- when the screen
    // loaded, or by an older client. Comparing it with anything now is
    // impossible: its endpoint can only be asked around the tunnel. So
    // no verdict either way, and not a strike.
    const fromMirror = { ip: HOME, from: FI_MIRROR, peer: FINLAND };
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    net.tunnel = FINLAND;
    await expect(verifyEgress(fromMirror, { tunnelServer: FI_AROUND })).resolves.toEqual({
      state: "indeterminate",
      exitIp: FINLAND,
    });
    // Asked to use that endpoint alone, or first, it walks the list
    // instead: the one endpoint it would ask cannot answer through the
    // tunnel, and its silence would read as a dead tunnel where no probe
    // says otherwise.
    asked.length = 0;
    await expect(verifyEgress(fromMirror, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual({
      state: "indeterminate",
      exitIp: FINLAND,
    });
    expect(asked).toEqual([FI_MIRROR, CDN]);
    asked.length = 0;
    await expect(verifyEgress(fromMirror, { baselineFirst: true, tunnelServer: FI_AROUND })).resolves.toEqual({
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
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual(THROUGH);
  });

  it("proves it on a censored network through the rung's own endpoint", async () => {
    // Iran: the panel hosts are blocked on the bare network, so the
    // baseline comes from a mirror -- not the node's own, now, but the
    // next one. The rung asks that one, through the tunnel.
    net.blockedBare.add(CDN);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    expect(baseline).toEqual({ ip: HOME, from: DE_MIRROR, peer: GERMANY });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual(
      THROUGH,
    );
  });
});

describe("the baseline's endpoint first (the Windows health poll and last rung)", () => {
  // Iran again, the case the first fix left at "not confirmed" on
  // Windows: the baseline came from another node's mirror, because the
  // panel host ahead of it is filtered on the bare line -- and through
  // the tunnel that panel host answers, first.

  async function censoredBaseline() {
    net.blockedBare.add(CDN);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    expect(baseline?.from).toBe(DE_MIRROR);
    net.tunnel = FINLAND;
    return baseline;
  }

  it("compared nothing in list order, on every poll of a working tunnel", async () => {
    // The control: the poll as the first fix left it.
    const baseline = await censoredBaseline();
    await expect(
      verifyEgress(baseline, { totalMs: 2 * EGRESS_TIMEOUT_MS, tunnelServer: FI_AROUND }),
    ).resolves.toEqual({ state: "indeterminate", exitIp: FINLAND });
  });

  it("proves it, asking the baseline's endpoint before the panel host", async () => {
    const baseline = await censoredBaseline();
    asked.length = 0;
    await expect(
      verifyEgress(baseline, { totalMs: 2 * EGRESS_TIMEOUT_MS, tunnelServer: FI_AROUND, baselineFirst: true }),
    ).resolves.toEqual(THROUGH);
    expect(asked).toEqual([DE_MIRROR]);
    // And the last rung, which walks the list too.
    await expect(
      confirmEgressWithin(baseline, 2_000, { intervalMs: 20, tunnelServer: FI_AROUND, baselineFirst: true }),
    ).resolves.toEqual(THROUGH);
  });

  it("still walks the rest when the baseline's endpoint is silent, and accuses nothing", async () => {
    const baseline = await censoredBaseline();
    net.dead = true;
    internet.mockResolvedValue(true);
    asked.length = 0;
    // Through a dead tunnel nothing answers but the server's own mirror,
    // which is passed over: the probe decides.
    await expect(
      verifyEgress(baseline, { totalMs: 2 * EGRESS_TIMEOUT_MS, tunnelServer: FI_AROUND, baselineFirst: true }),
    ).resolves.toEqual({ state: "indeterminate", exitIp: null });
    expect(asked).toEqual([DE_MIRROR, FI_MIRROR, CDN]);
    internet.mockResolvedValue(false);
    await expect(
      verifyEgress(baseline, { totalMs: 2 * EGRESS_TIMEOUT_MS, tunnelServer: FI_AROUND, baselineFirst: true }),
    ).resolves.toEqual({ state: "unreachable" });
  });
});

describe("a server reached through the tunnel (phones' Xray and WireGuard, wireguard.exe; from the source)", () => {
  // The request to the server's own address goes into the tunnel and
  // reaches the node from inside it, which hands it on from its own
  // address: the mirror there names the node. That is what a working
  // tunnel looks like from that endpoint -- and on a network where the
  // node's mirror is the only thing answering, the only proof there is.

  it("lost that proof when the server's endpoints were passed over as if reached around it", async () => {
    // The control: only finland1's mirror answers on the bare line, and
    // the first fix skipped it on every platform.
    net.route = "through";
    net.blockedBare.add(CDN).add(DE_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    await expect(captureBaselineIp({ tunnelServer: FI_AROUND })).resolves.toBeNull();
  });

  it("keeps the baseline from the server's own mirror, and proves the tunnel through it", async () => {
    net.route = "through";
    net.blockedBare.add(CDN).add(DE_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_THROUGH });
    expect(baseline).toEqual({ ip: HOME, from: FI_MIRROR, peer: FINLAND });

    net.tunnel = FINLAND;
    // It names the very address it was fetched from -- and is believed,
    // because it is the baseline's own endpoint, on the tunnel's server,
    // and its baseline named the caller.
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_THROUGH })).resolves.toEqual(
      THROUGH,
    );
    await expect(verifyEgress(baseline, { tunnelServer: FI_THROUGH, baselineFirst: true })).resolves.toEqual(THROUGH);
    await expect(verifyEgress(baseline, { tunnelServer: FI_THROUGH })).resolves.toEqual(THROUGH);
  });

  it("proves a relay through the entry's own mirror, which sees the exit", async () => {
    // A relay is dialled at its entry, here finland1, and leaves from its
    // exit: the entry's mirror, asked through the tunnel, is reached from
    // the exit. Not a self-report at all.
    net.route = "through";
    net.blockedBare.add(CDN).add(DE_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, DE_MIRROR]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_THROUGH });
    net.tunnel = FINLAND;
    net.exit = GERMANY;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_THROUGH })).resolves.toEqual({
      state: "throughTunnel",
      exitIp: GERMANY,
    });
  });

  it("believes a self-naming answer only from the baseline's own endpoint", async () => {
    // The baseline came from the CDN. finland1's mirror, ahead of it in
    // the list, names itself through the tunnel; from an endpoint that is
    // not the baseline's that is passed over as ever, and the CDN asked.
    net.route = "through";
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = { ip: HOME, from: CDN, peer: EDGE };
    net.tunnel = FINLAND;
    asked.length = 0;
    await expect(verifyEgress(baseline, { tunnelServer: FI_THROUGH })).resolves.toEqual(THROUGH);
    expect(asked).toEqual([FI_MIRROR, CDN]);
  });

  it("does not believe it over a baseline that may itself have been a self-report", async () => {
    // A baseline with no peer -- taken by a transport that could not say
    // where it connected -- might have been that mirror naming itself.
    // Believing the same answer now would compare a self-report with
    // itself.
    net.route = "through";
    net.selfReporting.add(FI_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR]);
    const unknownPeer = { ip: FINLAND, from: FI_MIRROR };
    net.tunnel = FINLAND;
    const verdict = await verifyEgress(unknownPeer, { sameEndpointOnly: true, tunnelServer: FI_THROUGH });
    expect(verdict.state).not.toBe("bypassingTunnel");
    expect(verdict.state).not.toBe("throughTunnel");
  });

  it("never takes a self-reporting mirror on the server as the baseline", async () => {
    net.route = "through";
    net.selfReporting.add(FI_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_THROUGH });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { tunnelServer: FI_THROUGH, baselineFirst: true })).resolves.toEqual(THROUGH);
  });

  it("still sees a dead tunnel", async () => {
    net.route = "through";
    const baseline = { ip: HOME, from: FI_MIRROR, peer: FINLAND };
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    net.tunnel = FINLAND;
    net.dead = true;
    await expect(verifyEgress(baseline, { tunnelServer: FI_THROUGH })).resolves.toEqual({ state: "unreachable" });
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
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual({ state: "unreachable" });
    internet.mockReset();
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual({ state: "unreachable" });
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
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual({ state: "unreachable" });
  });
});

describe("a mirror that reports its own node's address", () => {
  // Installed without NEOXIFY_PANEL_ORIGIN: it proxies through the CDN,
  // which names the node, so it answers everyone with the node's address.

  /** The same network, with the address each request connected to
   * hidden, as the plugin's fetch hides it -- how every reading looked
   * to the check before `health_ip_v4` reported it. */
  async function withoutPeers<T>(run: () => Promise<T>): Promise<T> {
    setHealthIpTransport(async (base, timeoutMs) => {
      const { status, body } = await modelTransport(base, timeoutMs);
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
      const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
      expect(baseline).toEqual({ ip: FINLAND, from: FI_MIRROR });
      net.tunnel = FINLAND;
      await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual({
        state: "bypassingTunnel",
        exitIp: FINLAND,
      });
    });
  });

  it("is still never compared with itself when it is the connected node's", async () => {
    net.selfReporting.add(FI_MIRROR);
    endpoints.mockResolvedValue([FI_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual(
      THROUGH,
    );
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual(THROUGH);
  });

  it("is passed over as a baseline when it is another node's, on Windows too", async () => {
    // The phones pass every node address they know (`nodeAddresses`);
    // Windows passed none, and took such a baseline. Asked again through
    // the working tunnel, the same mirror gave the same address back:
    // `bypassingTunnel`. An answer that is the very address the request
    // connected to is the endpoint describing itself, never the caller.
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    net.tunnel = FINLAND;
    await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual(
      THROUGH,
    );
    // And while connected, its answer is passed over too.
    await expect(verifyEgress(baseline, { tunnelServer: FI_AROUND })).resolves.toEqual(THROUGH);
    expect(asked.slice(-2)).toEqual([DE_MIRROR, CDN]);
  });

  it("is passed over by its node's address where the transport says nothing", async () => {
    // Windows now passes its nodes' addresses as the phones do, so a
    // baseline taken without a peer still cannot be such a mirror.
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    await withoutPeers(async () => {
      const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND, nodeAddresses: [FINLAND, GERMANY] });
      expect(baseline).toEqual({ ip: HOME, from: CDN });
    });
  });

  it("would otherwise have been the baseline, and read the tunnel as a leak", async () => {
    // The control for the tests above.
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    await withoutPeers(async () => {
      const baseline = await captureBaselineIp({ tunnelServer: FI_AROUND });
      expect(baseline).toEqual({ ip: GERMANY, from: DE_MIRROR });
      net.tunnel = FINLAND;
      await expect(verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer: FI_AROUND })).resolves.toEqual({
        state: "bypassingTunnel",
        exitIp: GERMANY,
      });
    });
  });
});

describe("a baseline walk past endpoints the bare network black-holes", () => {
  // Iran: the panel hosts lead the list and hang until their timeout;
  // the last endpoint that worked -- finland1's mirror -- is passed over
  // because finland1 is about to be dialled. The Windows settle gives
  // this walk twelve seconds.

  function iran() {
    net.hangBare.add(CDN).add(CDN2);
    endpoints.mockResolvedValue([FI_MIRROR, CDN, CDN2, DE_MIRROR]);
  }

  it("spent the whole ceiling on the panel hosts, strictly in turn", async () => {
    // The control.
    vi.useFakeTimers();
    iran();
    let result: unknown = "pending";
    void captureBaselineIp({ deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS, tunnelServer: FI_AROUND }).then(
      (r) => (result = r),
    );
    await vi.advanceTimersByTimeAsync(2 * EGRESS_TIMEOUT_MS + 100);
    expect(result).toBeNull();
  });

  it("reaches the next working mirror in a few seconds, hedged", async () => {
    vi.useFakeTimers();
    iran();
    let result: unknown = "pending";
    void captureBaselineIp({
      deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS,
      tunnelServer: FI_AROUND,
      hedgeMs: BASELINE_HEDGE_MS,
    }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(3 * BASELINE_HEDGE_MS);
    expect(result).toEqual({ ip: HOME, from: DE_MIRROR, peer: GERMANY });
  });

  it("asks a working first endpoint alone", async () => {
    vi.useFakeTimers();
    endpoints.mockResolvedValue([CDN, CDN2, DE_MIRROR]);
    let result: unknown = "pending";
    void captureBaselineIp({ deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS, hedgeMs: BASELINE_HEDGE_MS }).then(
      (r) => (result = r),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ip: HOME, from: CDN, peer: EDGE });
    expect(asked).toEqual([CDN]);
  });

  it("ends with nothing when nothing answers, once what it asked has failed", async () => {
    vi.useFakeTimers();
    net.hangBare.add(DE_MIRROR);
    iran();
    let result: unknown = "pending";
    void captureBaselineIp({
      deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS,
      tunnelServer: FI_AROUND,
      hedgeMs: BASELINE_HEDGE_MS,
    }).then((r) => (result = r));
    // The last of them started two seconds in, with six to run.
    await vi.advanceTimersByTimeAsync(2 * BASELINE_HEDGE_MS + EGRESS_TIMEOUT_MS - 100);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeNull();
    expect(asked).toEqual([FI_MIRROR, CDN, CDN2, DE_MIRROR]);
  });

  it("starts nothing after its ceiling, and nothing it started outlives it", async () => {
    vi.useFakeTimers();
    const list = Array.from({ length: 30 }, (_, i) => `https://n${i}.example.test/api`);
    for (const base of list) net.hangBare.add(base);
    endpoints.mockResolvedValue(list);
    let result: unknown = "pending";
    void captureBaselineIp({ deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS, hedgeMs: BASELINE_HEDGE_MS }).then(
      (r) => (result = r),
    );
    await vi.advanceTimersByTimeAsync(2 * EGRESS_TIMEOUT_MS + 50);
    expect(result).toBeNull();
    // One a second, for the twelve seconds.
    expect(asked.length).toBe(2 * EGRESS_TIMEOUT_MS / BASELINE_HEDGE_MS);
  });

  it("still passes over a self-reporting mirror and a node's address", async () => {
    vi.useFakeTimers();
    net.selfReporting.add(DE_MIRROR);
    endpoints.mockResolvedValue([DE_MIRROR, CDN]);
    let result: unknown = "pending";
    void captureBaselineIp({ deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS, hedgeMs: BASELINE_HEDGE_MS }).then(
      (r) => (result = r),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ip: HOME, from: CDN, peer: EDGE });
  });
});

describe("askedAroundTunnel", () => {
  it("knows a reading's endpoint only when the transport said where it connected", () => {
    expect(askedAroundTunnel({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, FI_AROUND)).toBe(true);
    expect(
      askedAroundTunnel({ ip: HOME, from: FI_MIRROR, peer: `::ffff:${FINLAND}` }, { addresses: [FINLAND], reachedAround: true }),
    ).toBe(true);
    expect(
      askedAroundTunnel({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, { addresses: [` ${FINLAND} `], reachedAround: true }),
    ).toBe(true);
    expect(askedAroundTunnel({ ip: HOME, from: CDN, peer: EDGE }, FI_AROUND)).toBe(false);
    expect(askedAroundTunnel({ ip: HOME, from: FI_MIRROR }, FI_AROUND)).toBe(false);
    expect(askedAroundTunnel(null, FI_AROUND)).toBe(false);
    expect(askedAroundTunnel({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, undefined)).toBe(false);
  });

  it("is never true of a server reached through the tunnel", () => {
    expect(askedAroundTunnel({ ip: HOME, from: FI_MIRROR, peer: FINLAND }, FI_THROUGH)).toBe(false);
  });
});
