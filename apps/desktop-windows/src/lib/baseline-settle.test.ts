import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The baseline before a connect, on a network that blocks Neoxify.
 *
 * The test VM, S2: the panel host and the CDN refused on the bare line,
 * and every mirror's name answered with Iran's DNS block page (10.10.34.x,
 * where a TLS handshake never completes). The dashboard's own requests had
 * already found the block page and demoted those names. The baseline
 * ignored all of it: it asked every mirror, waited up to six seconds on
 * each, then walked the list again every 400 ms until its twelve-second
 * ceiling -- 12.7 s of a 20 s Connect before the engine was started, for
 * no baseline at the end, and the honest "Connected, not confirmed" that
 * follows from having none.
 *
 * The real `settleAndCaptureBaseline`, `captureBaselineIp` and demotion
 * memory run here; the transport, the resolver and the endpoint list are
 * a model of that network, on a fake clock. Names and addresses are
 * stand-ins (docs/node-address-hygiene.md), the block page's range
 * excepted: it is what the client recognises. */

const ORIGIN = "https://origin.example.test/api";
const CDN = "https://edge.example.test/api";
const MIRRORS = Array.from({ length: 8 }, (_, i) => `https://m${i}.example.test:2053/api`);
const LIST = [ORIGIN, CDN, ...MIRRORS];
/** The customer's own address, as an endpoint that answers reports it. */
const HOME = "192.0.2.228";

const endpoints = vi.fn<() => Promise<string[]>>();
vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));
vi.mock("./endpoint-bundle-store", () => ({ isKnownBlockPage: (address: string) => /^10\.10\.34\./.test(address) }));

/** The network: what the resolver answers for a name, and what each
 * endpoint does with a `/health/ip` request on the bare line. */
const net = {
  /** Names the resolver sends to the block page. */
  blockPage: new Set<string>(),
  /** Whether `resolve_ipv4` is refused because the app's requests go
   * through a proxy -- only when the caller asks it to be (`unlessProxied`). */
  proxied: false,
  /** Endpoints that answer, with the customer's own address. */
  answering: new Set<string>(),
  /** Endpoints refused at once. The rest hang for their whole budget. */
  refused: new Set<string>(),
  /** Whether the resolver never answers: a device moved to a network
   * whose resolver is slow or silent. */
  resolverSilent: false,
};
/** Every `/health/ip` request sent, in order. */
const sent: string[] = [];
/** Every lookup made, and whether it asked about a proxy. */
const lookups: { host: string; unlessProxied: boolean }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: { host?: string; unlessProxied?: boolean }) => {
    if (command === "resolve_ipv4") {
      const host = args?.host ?? "";
      lookups.push({ host, unlessProxied: args?.unlessProxied === true });
      if (args?.unlessProxied && net.proxied) return Promise.reject("proxied");
      if (net.resolverSilent) return new Promise<string[]>(() => undefined);
      return Promise.resolve(net.blockPage.has(host) ? ["10.10.34.35"] : ["198.51.100.7"]);
    }
    return Promise.reject(new Error(`not registered: ${command}`));
  },
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));

const { captureBaselineIp, setHealthIpTransport, EGRESS_TIMEOUT_MS, DEMOTED_BASELINE_MS } = await import("./egress");
const { settleAndCaptureBaseline } = await import("./baseline-settle");
const demotion = await import("./endpoint-demotion");

const NO_SERVER = { addresses: [] as string[], reachedAround: true };
const NO_NODES: ReadonlySet<string> = new Set();
/** The ladder's budgets for the first rung of several, and for the last. */
const FAILOVER_SETTLE_TIMEOUT_MS = 2_500;

beforeEach(() => {
  vi.useFakeTimers();
  demotion.resetDemotionsForTests();
  net.blockPage = new Set(MIRRORS.map((base) => new URL(base).hostname));
  net.proxied = false;
  net.resolverSilent = false;
  net.answering = new Set();
  net.refused = new Set([ORIGIN, CDN]);
  sent.length = 0;
  lookups.length = 0;
  endpoints.mockResolvedValue(LIST);
  setHealthIpTransport((base, timeoutMs) => {
    sent.push(base);
    if (net.answering.has(base)) return Promise.resolve({ status: 200, body: { ip: HOME }, peer: "198.51.100.7" });
    if (net.refused.has(base)) return Promise.reject(new Error("no answer"));
    // The block page, or a blackholed address: nothing, until the
    // command's own timeout.
    return new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), timeoutMs));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs the settle on the fake clock and says how long it took and what
 * it returned. */
async function timed(budgetMs: number, afterTeardown: boolean): Promise<{ ms: number; baseline: unknown }> {
  const start = Date.now();
  let done: { at: number; baseline: unknown } | null = null;
  void settleAndCaptureBaseline(budgetMs, null, NO_SERVER, NO_NODES, afterTeardown).then((baseline) => {
    done = { at: Date.now(), baseline };
  });
  for (let waited = 0; done === null && waited < 60_000; waited += 50) await vi.advanceTimersByTimeAsync(50);
  if (done === null) throw new Error("the settle never ended");
  const ended = done as { at: number; baseline: unknown };
  return { ms: ended.at - start, baseline: ended.baseline };
}

/** What the dashboard's own requests had found before Connect was pressed. */
function demotedByTheDashboardsLoad() {
  for (const base of MIRRORS) demotion.demoteName(new URL(base).hostname);
}

describe("the baseline before the first rung, on the VM's S2 network", () => {
  it("gives up in well under a second, and sends nothing to a name it knows is on the block page", async () => {
    demotedByTheDashboardsLoad();
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    // Before: 12,000 ms on this model (12.7 s on the VM). Measured by
    // running this test against the previous egress.ts and settle.
    expect(ms).toBeLessThan(1_000);
    expect(baseline).toBeNull();
    // The panel host and the CDN, asked and refused; no mirror sent a
    // request, each name looked at first.
    expect(sent).toEqual([ORIGIN, CDN]);
  });

  it("asks the addresses not known to be dead first", async () => {
    // The list leads with a mirror, as it does when the last address that
    // answered was one; its name is on the block page.
    endpoints.mockResolvedValue([...MIRRORS, ORIGIN, CDN]);
    demotedByTheDashboardsLoad();
    net.refused.delete(CDN);
    net.answering.add(CDN);
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toEqual({ ip: HOME, from: CDN, peer: "198.51.100.7" });
    expect(ms).toBeLessThan(100);
    expect(sent).toEqual([ORIGIN, CDN]);
  });

  it("stops waiting on a name the moment it is found on the block page, when nothing had found it before", async () => {
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(ms).toBeLessThan(1_000);
    expect(baseline).toBeNull();
    // Sent, since nothing knew better, and given up on at the look.
    expect(sent).toEqual(LIST);
  });

  it("does not write what it finds into the network's memory, which the API's own requests are ordered by", async () => {
    await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    for (const base of MIRRORS) expect(demotion.isNameDemoted(base)).toBe(false);
  });

  it("still takes the baseline from a mirror whose name has come back", async () => {
    demotedByTheDashboardsLoad();
    const back = MIRRORS[3];
    net.blockPage.delete(new URL(back).hostname);
    net.answering.add(back);
    const { baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toEqual({ ip: HOME, from: back, peer: "198.51.100.7" });
    // And its answer lifts the demotion, as an answer to the API would.
    expect(demotion.isDemoted(back)).toBe(false);
  });
});

describe("after a teardown", () => {
  it("asks again for the settle's budget, not the walk's twelve-second ceiling", async () => {
    demotedByTheDashboardsLoad();
    const { ms } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, true);
    expect(ms).toBeGreaterThanOrEqual(FAILOVER_SETTLE_TIMEOUT_MS);
    expect(ms).toBeLessThan(FAILOVER_SETTLE_TIMEOUT_MS + 1_000);
  });

  it("finds the network once it is back within that budget", async () => {
    demotedByTheDashboardsLoad();
    let result: unknown = "pending";
    void settleAndCaptureBaseline(FAILOVER_SETTLE_TIMEOUT_MS, null, NO_SERVER, NO_NODES, true).then(
      (baseline) => (result = baseline),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toBe("pending");
    // The previous engine's routes gone: the CDN answers.
    net.refused.delete(CDN);
    net.answering.add(CDN);
    await vi.advanceTimersByTimeAsync(500);
    expect(result).toEqual({ ip: HOME, from: CDN, peer: "198.51.100.7" });
  });
});

describe("addresses that hang rather than refuse", () => {
  /** The blackhole variant: the panel host and the CDN time out, and the
   * API's requests have demoted them for it. Asked last, and briefly. */
  it("gives an address that timed out here lately two seconds, not six", async () => {
    net.refused.clear();
    demotion.demoteEndpoint(ORIGIN);
    demotion.demoteEndpoint(CDN);
    demotedByTheDashboardsLoad();
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toBeNull();
    expect(DEMOTED_BASELINE_MS).toBe(2_000);
    // Hedged a second apart, two seconds each.
    expect(ms).toBeLessThanOrEqual(1_000 + DEMOTED_BASELINE_MS + 100);
    expect(ms).toBeLessThan(EGRESS_TIMEOUT_MS);
  });
});

/** Every address hangs: SNI or DPI drops the ClientHello, or the addresses
 * are blackholed -- the VM's S2b, and a common shape in Iran. The
 * dashboard's failed load has timed out on every one of them, so every
 * one is demoted. Each got two seconds, but the hedge launched one a
 * second, so the walk still took eleven: before the first rung, and again
 * on every rung after a teardown -- about 55 s of a five-rung ladder spent
 * on baselines that could not be had. */
describe("when every address hangs", () => {
  function everyAddressHangs() {
    net.refused.clear();
    net.blockPage.clear();
    for (const base of LIST) demotion.demoteEndpoint(base);
  }

  it("gives up on the baseline before the first rung in about two seconds, not eleven", async () => {
    everyAddressHangs();
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toBeNull();
    // Before: 11,000 ms on this model. Every address is still asked.
    expect(ms).toBeLessThanOrEqual(DEMOTED_BASELINE_MS + 100);
    expect([...sent].sort()).toEqual([...LIST].sort());
  });

  it("gives up again within the settle's budget and one walk on every rung after a teardown", async () => {
    everyAddressHangs();
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, true);
    expect(baseline).toBeNull();
    // Before: 11,000 ms a rung. Now the settle's budget, and the walk that
    // was under way when it ran out.
    expect(ms).toBeLessThanOrEqual(FAILOVER_SETTLE_TIMEOUT_MS + DEMOTED_BASELINE_MS + 500);
  });

  it("still asks the addresses not demoted first, a hedge apart, and the demoted ones together after them", async () => {
    net.refused.clear();
    net.blockPage.clear();
    for (const base of MIRRORS) demotion.demoteEndpoint(base);
    const times: number[] = [];
    const start = Date.now();
    setHealthIpTransport((base, timeoutMs) => {
      sent.push(base);
      times.push(Date.now() - start);
      return new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), timeoutMs));
    });
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toBeNull();
    expect(sent.slice(0, 2)).toEqual([ORIGIN, CDN]);
    expect(times.slice(0, 3)).toEqual([0, 1_000, 2_000]);
    expect(new Set(times.slice(2))).toEqual(new Set([2_000]));
    // The panel host and the CDN get their six seconds: nothing says they
    // are dead here. Before: 11,000 ms.
    expect(ms).toBe(1_000 + EGRESS_TIMEOUT_MS);
  });

  /** Nothing known about the network at all -- no load has failed on it --
   * and every address hangs: nothing says which one is dead, so each still
   * gets its six seconds, a hedge apart, up to the walk's ceiling. This is
   * the case the demotions cannot help with, measured so it is not
   * mistaken for fixed. */
  it("still takes the walk's ceiling when nothing has failed on this network before", async () => {
    net.refused.clear();
    net.blockPage.clear();
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toBeNull();
    expect(ms).toBe(2 * EGRESS_TIMEOUT_MS);
  });
});

describe("the look before sending", () => {
  /** A name already found on the block page here, and a resolver that is
   * now slow or silent. The look was awaited outside the request's budget,
   * so up to three more seconds came on top of it, past the deadline that
   * no request is meant to outlive. */
  it("is held to the request's budget, so the walk keeps its deadline", async () => {
    const mirror = MIRRORS[0];
    demotion.demoteName(new URL(mirror).hostname);
    net.resolverSilent = true;
    const start = Date.now();
    let done: number | null = null;
    void captureBaselineIp({ only: mirror, deadline: start + FAILOVER_SETTLE_TIMEOUT_MS }).then(() => {
      done = Date.now();
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).not.toBeNull();
    // Before: 5,000 ms -- the look's three, then the request's two.
    expect((done as unknown as number) - start).toBeLessThanOrEqual(FAILOVER_SETTLE_TIMEOUT_MS);
  });
});

describe("an answer the walk passes over", () => {
  /** After a teardown whose routes have not gone yet, an endpoint can
   * answer through the old tunnel with the node's address. The walk
   * passes the reading over, and that answer proves nothing about the bare
   * line -- but it used to lift the address's demotion there, and the next
   * API race on the bare line led with an address that is dead on it. */
  it("leaves the address's demotion on this network as it was", async () => {
    const NODE = "203.0.113.20";
    net.refused.clear();
    demotion.demoteEndpoint(CDN);
    setHealthIpTransport((base) => {
      sent.push(base);
      if (base === CDN) return Promise.resolve({ status: 200, body: { ip: NODE }, peer: "198.51.100.9" });
      return Promise.reject(new Error("no answer"));
    });
    let result: unknown = "pending";
    void captureBaselineIp({ only: CDN, nodeAddresses: [NODE] }).then((baseline) => (result = baseline));
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toBeNull();
    expect(demotion.isDemoted(CDN)).toBe(true);
  });
});

describe("behind a proxy", () => {
  /** Psiphon, v2rayN or Clash in system-proxy mode (fbe5cc5). The API's
   * requests go through it, so their look finds nothing and the names are
   * neither stopped nor demoted for them. `/health/ip` never goes through a
   * proxy (`.no_proxy()` in health_ip.rs), so the baseline's look is the
   * engines' plain IPv4 lookup -- what its request will actually meet --
   * and it writes nothing the API's requests would read. */
  it("looks at the names the way its own request resolves them, and leaves the API's memory alone", async () => {
    net.proxied = true;
    const { ms, baseline } = await timed(FAILOVER_SETTLE_TIMEOUT_MS, false);
    expect(baseline).toBeNull();
    expect(ms).toBeLessThan(1_000);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((l) => !l.unlessProxied)).toBe(true);
    for (const base of MIRRORS) expect(demotion.isNameDemoted(base)).toBe(false);
  });
});

describe("a node's own address", () => {
  it("is still never the baseline, whatever the order", async () => {
    const NODE = "203.0.113.20";
    const mirror = MIRRORS[0];
    net.blockPage.delete(new URL(mirror).hostname);
    setHealthIpTransport((base) => {
      sent.push(base);
      if (base === mirror) return Promise.resolve({ status: 200, body: { ip: NODE }, peer: "198.51.100.8" });
      if (base === CDN) return Promise.resolve({ status: 200, body: { ip: HOME }, peer: "198.51.100.7" });
      return Promise.reject(new Error("no answer"));
    });
    endpoints.mockResolvedValue([mirror, ORIGIN, CDN]);
    let result: unknown = "pending";
    void settleAndCaptureBaseline(FAILOVER_SETTLE_TIMEOUT_MS, null, NO_SERVER, new Set([NODE]), false).then(
      (baseline) => (result = baseline),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toEqual({ ip: HOME, from: CDN, peer: "198.51.100.7" });
  });
});
