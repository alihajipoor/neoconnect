import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** How many addresses a read asks, and in what order, once some of them
 * have failed on this network.
 *
 * Driven through the real api.ts and endpoint-demotion.ts against a
 * network stood in for per address, and a resolver per name, with a fake
 * clock. The list is put together as the app's is: the address that
 * answered last leads, the rest follow in a fixed order.
 *
 * Before: every read went to every address at once, whatever had
 * answered a moment earlier -- 112 connections for one launch of the app
 * in a VM, sixteen for each of seven reads -- and an address that had just
 * spent a whole race timing out was asked again by the next one, first
 * if it happened to be the last to have answered. */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const D = "https://d.example";
const E = "https://e.example";
const F = "https://f.example";
const ENDPOINTS = [A, B, C, D, E, F];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

const { remembered } = vi.hoisted(() => ({ remembered: [] as string[] }));
vi.mock("./api-endpoints", () => ({
  // As `apiEndpoints` builds it: what answered last time first.
  apiEndpoints: () => {
    const last = remembered[remembered.length - 1];
    return Promise.resolve(last === undefined ? [...ENDPOINTS] : [last, ...ENDPOINTS.filter((base) => base !== last)]);
  },
  rememberEndpoint: (base: string) => {
    remembered.push(base);
    return Promise.resolve();
  },
  rememberedEndpoint: () => Promise.resolve(remembered[remembered.length - 1]),
}));
vi.mock("./endpoint-bundle-store", async (importOriginal) => ({
  isKnownBlockPage: (await importOriginal<typeof import("./endpoint-bundle-store")>()).isKnownBlockPage,
  maybeRefreshBundle: () => Promise.resolve(),
}));

/** What the system resolver answers for each name, as `resolve_ipv4`
 * hands it back. A name not here fails to resolve, which is nothing
 * known.
 *
 * `proxy.on` is a proxy the HTTP plugin's requests go through -- Psiphon
 * or v2rayN in system-proxy mode. Then `resolve_ipv4`, asked on the
 * requests' behalf (`unlessProxied`), refuses before asking the resolver,
 * as `http_proxied` in health_ip.rs makes it; asked for the engines, it
 * answers as before. */
const { resolver, proxy } = vi.hoisted(() => ({ resolver: new Map<string, string[]>(), proxy: { on: false } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { host: string; unlessProxied?: boolean }) => {
    if (command === "resolve_ipv4" && proxy.on && args.unlessProxied === true) {
      return Promise.reject(new Error("proxied"));
    }
    const answer = command === "resolve_ipv4" ? resolver.get(args.host) : undefined;
    return answer === undefined ? Promise.reject(new Error("could not resolve")) : Promise.resolve(answer);
  },
}));
/** Iran's DNS block page, as it answered for every name under the mirror
 * domain from inside the country on 2026-10-10. */
const BLOCK_PAGE = ["10.10.34.34"];

const { publicRequest, resetRaceWinnerForTests, CONNECT_TIMEOUT_MS, LEAD_MS } = await import("./api");
const { newTrace, renderTrace } = await import("./endpoint-trace");

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";
const BLOCKED = "Could not reach Neoxify: this network's DNS sends its addresses to a block page.";
const ROUTES = "/customer/routes";

/** What one address does with a request: by origin, or by origin and
 * path where one path is treated differently. */
type Behaviour =
  | { after: number; reply: () => Response }
  /** Never completes a connection: given up on at the connection
   * deadline, as reqwest does. */
  | "blackhole"
  /** Connected; never answers. */
  | "stall"
  /** Refused at once. */
  | "reset";
let network: Record<string, Behaviour>;

/** Every request that left the device, in order. */
let sent: string[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answers = (after: number): Behaviour => ({ after, reply: () => json([]) });

function respond(url: string, behaviour: Behaviour, init?: RequestInit & { connectTimeout?: number }): Promise<Response> {
  const signal = init?.signal;
  if (behaviour === "reset") return Promise.reject(`error sending request for url (${url})`);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    if (behaviour === "stall") return;
    if (behaviour === "blackhole") {
      timer = setTimeout(() => reject(`error sending request for url (${url})`), init?.connectTimeout ?? 1e9);
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(behaviour.reply());
    }, behaviour.after);
  });
}

async function run<T>(request: () => Promise<ApiResult<T>>) {
  sent = [];
  const startedAt = Date.now();
  let ms: number | null = null;
  const pending = request().then((r) => {
    ms = Date.now() - startedAt;
    return r;
  });
  await vi.runAllTimersAsync();
  return { result: await pending, ms: ms as unknown as number, sent };
}

const read = (trace?: ReturnType<typeof newTrace>) => run(() => publicRequest(ROUTES, undefined, trace));

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  resolver.clear();
  proxy.on = false;
  network = {};
  sent = [];
  remembered.length = 0;
  tauriFetch.mockImplementation((url: string, init?: RequestInit & { connectTimeout?: number }) => {
    const { origin, pathname } = new URL(url);
    sent.push(origin);
    return respond(url, network[origin + pathname] ?? network[origin] ?? "blackhole", init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("a read where the last address to answer still answers", () => {
  /** The VM's count, on six addresses: a launch's seven reads. Before:
   * all six asked by every read, 42 connections. */
  it("asks that address alone", async () => {
    network[E] = answers(200);
    const first = await read();
    expect(first.result.ok).toBe(true);

    const asked: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { result, ms, sent } = await read();
      expect(result.ok).toBe(true);
      expect(ms).toBe(200);
      asked.push(...sent);
    }
    expect(asked).toEqual([E, E, E, E, E, E]);
  });
});

describe("a read where the first address does not answer", () => {
  /** A first install: nothing remembered, the first address blocked. */
  it("asks the rest after its head start, and remembers the one that answered", async () => {
    network[D] = answers(300);
    const trace = newTrace();

    const { result, ms } = await read(trace);

    expect(result.ok).toBe(true);
    expect(ms).toBe(LEAD_MS + 300);
    expect(renderTrace(trace)).toBe(
      "req: a.example=cancel@1800 b.example=cancel@300 c.example=cancel@300 d.example=h200@300 " +
        "e.example=cancel@300 f.example=cancel@300",
    );
    expect(remembered).toEqual([D]);
  });

  /** Refused outright is no reason to wait out the rest of the head start. */
  it("asks the rest at once when the first is refused", async () => {
    network[A] = "reset";
    network[D] = answers(300);

    const { ms } = await read();

    expect(ms).toBe(300);
  });
});

describe("an address that timed out", () => {
  /** The dead Iranian mirror: it has not completed a TCP handshake since
   * its node went offline. Here B is that mirror; the first read finds
   * only the CDN, slowly, so B is given up on at the connection deadline.
   * When a mirror then answers quickly, B is not asked at all. Before: B
   * was asked by every read that got past the first address. */
  it("is not asked while another address answers within the next head start", async () => {
    network[A] = answers(12_000);
    for (const base of [C, D, E, F]) network[base] = "reset";
    const first = await read();
    expect(first.result.ok).toBe(true);
    expect(first.sent).toEqual([A, B, C, D, E, F]);

    // The CDN is blackholed now, and a mirror answers.
    network[A] = "blackhole";
    network[D] = answers(300);
    const trace = newTrace();
    const second = await read(trace);

    expect(second.result.ok).toBe(true);
    expect(second.ms).toBe(LEAD_MS + 300);
    expect(second.sent).toEqual([A, C, D, E, F]);
    expect(renderTrace(trace)).toBe(
      "req: a.example=cancel@1800 c.example=net@0 d.example=h200@300 e.example=net@0 f.example=net@0",
    );
  });

  /** It answered last, so the list leads with it; it then timed out, and
   * nothing else answered. Before: every read after waited out its head
   * start on it first. */
  it("does not lead the next read, though it was the last to answer", async () => {
    network[C] = answers(200);
    await read();
    expect(remembered).toEqual([C]);

    // C goes dark, and nothing else answers either.
    network[C] = "blackhole";
    for (const base of [A, B, D, E, F]) network[base] = "reset";
    const failed = await read();
    expect(failed.result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(failed.ms).toBe(CONNECT_TIMEOUT_MS);

    // Then A answers again.
    network[A] = answers(300);
    const { result, ms, sent } = await read();

    expect(result.ok).toBe(true);
    expect(ms).toBe(300);
    expect(sent).toEqual([A]);
  });

  /** A write times out too: here at the address that had just answered a
   * read, and so leads the list. Nothing else answers the health race the
   * write then runs, so nothing replaces it as the last to answer, and
   * nothing answered the write: Neoxify could not be reached. */
  it("does not lead the next read when the timeout was a write's", async () => {
    network[B] = answers(200);
    network[B + "/client-attempts"] = "stall";
    for (const base of [A, C, D, E, F]) network[base] = "reset";
    await read();
    expect(remembered).toEqual([B]);

    const write = await run(() => publicRequest("/client-attempts", { method: "POST", body: "{}" }));
    expect(write.result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });

    network[A] = answers(300);
    const { ms, sent } = await read();
    expect(ms).toBe(300);
    expect(sent).toEqual([A]);
  });

  /** Asked last, never not at all: when it is the one that answers, it is
   * asked a head start after the rest -- and only once, because its
   * answer lifts the demotion. */
  it("is still asked, and is not demoted again once it has answered", async () => {
    network[A] = "stall";
    network[B] = answers(11_000);
    const first = await read();
    expect(first.result.ok).toBe(true);
    // C to F were given up on at the connection deadline.

    network[B] = "stall";
    network[E] = answers(300);
    const trace = newTrace();
    const second = await read(trace);

    expect(second.result.ok).toBe(true);
    // B, remembered, leads; A is asked a head start later; the demoted
    // C to F a head start after that.
    expect(second.ms).toBe(LEAD_MS + LEAD_MS + 300);
    expect(renderTrace(trace)).toBe(
      "req: b.example=cancel@3300 a.example=cancel@1800 c.example=cancel@300 d.example=cancel@300 " +
        "e.example=h200@300 f.example=cancel@300",
    );
    expect(remembered[remembered.length - 1]).toBe(E);

    // E answered, so it is no longer demoted: remembered, it leads the
    // next read and answers inside its head start. Still demoted, it
    // would be asked last again, two head starts in.
    const third = await read();
    expect(third.ms).toBe(300);
    expect(third.sent).toEqual([E]);
  });
});

describe("an address stopped rather than failed", () => {
  /** A is stopped because C answered, ten seconds and a little after A
   * was asked: when the connection deadline would have given up on it.
   * The plugin reports a cancelled request in the same words as a
   * connection that timed out, so only the fact that the race had been
   * decided tells them apart. */
  it("is not demoted when another address answered first", async () => {
    network[A] = "stall";
    network[B] = "stall";
    network[C] = answers(CONNECT_TIMEOUT_MS + 300 - LEAD_MS);
    for (const base of [D, E, F]) network[base] = "reset";
    await read();
    expect(remembered).toEqual([C]);

    // C is gone, and A answers: asked with the rest after C's head start,
    // not a head start after them.
    network[C] = "stall";
    network[A] = answers(300);
    const { ms } = await read();
    expect(ms).toBe(LEAD_MS + 300);
  });

  /** A caller's own deadline, such as the pre-connect refresh's budget,
   * says nothing about the addresses still being waited for -- here
   * running out just past ten seconds into A's wait, as in the case
   * above. */
  it("is not demoted when the caller's deadline ran out", async () => {
    network[A] = "stall";
    const budget = new AbortController();
    setTimeout(() => budget.abort(), CONNECT_TIMEOUT_MS + 500);
    const cut = await run(() => publicRequest(ROUTES, { signal: budget.signal }));
    expect(cut.result.ok).toBe(false);

    network[A] = answers(300);
    const { ms, sent } = await read();
    expect(ms).toBe(300);
    expect(sent).toEqual([A]);
  });
});

describe("an address whose name resolves to the block page", () => {
  /** It answered last, so it leads; since then its name has started to
   * resolve to the block page, which leaves the handshake hanging. Before:
   * every read waited out its head start before asking anyone else. */
  it("does not hold up the race when it leads", async () => {
    network[C] = answers(200);
    await read();
    expect(remembered).toEqual([C]);

    // A while later.
    resolver.set("c.example", BLOCK_PAGE);
    network[C] = "stall";
    network[A] = answers(300);
    const trace = newTrace();
    const { result, ms } = await read(trace);

    expect(result.ok).toBe(true);
    expect(ms).toBe(300);
    expect(renderTrace(trace)).toBe(
      "req: c.example=blockpage@0 a.example=h200@300 b.example=cancel@300 d.example=cancel@300 " +
        "e.example=cancel@300 f.example=cancel@300",
    );
  });

  /** The field's shape: the CDN answers, slowly, and every mirror's name
   * resolves to the block page, whose handshake hangs. Before: each read
   * that waited out the CDN's head start asked every mirror again, and
   * they were stopped, not failed, when the CDN answered -- so nothing
   * learned that they could never answer. Now each race looks at their
   * names again, which the resolver answers from its cache, and stops them
   * at once: asked last, they cost the race nothing. A look is not kept
   * from one race to the next, because the next may be on another path
   * (see the tunnel case below). */
  it("is found by every race, demoted, and stopped at once", async () => {
    network[A] = answers(5_000);
    network[B] = "reset";
    for (const base of [C, D, E, F]) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    resolver.set("a.example", ["203.0.113.10"]);
    const first = await read();
    expect(first.result.ok).toBe(true);
    expect(first.ms).toBe(5_000);

    const trace = newTrace();
    const second = await read(trace);

    expect(second.result.ok).toBe(true);
    expect(second.ms).toBe(5_000);
    // Looked at before anything was sent, and nothing was. Before, every
    // one of them was sent the read -- a handshake naming a blocked host,
    // to the block page -- and stopped when the look caught up.
    expect(second.sent).toEqual([A, B]);
    expect(renderTrace(trace)).toBe(
      "req: a.example=h200@5000 b.example=net@0 c.example=blockpage@0 d.example=blockpage@0 " +
        "e.example=blockpage@0 f.example=blockpage@0",
    );
  });

  /** Nowhere to go but the block page: said at once, and as what it is.
   * Before, "Could not reach Neoxify. Check your internet connection." --
   * for a connection that works, on a network keeping Neoxify's names
   * from it. */
  it("ends a race in which nothing else answers without waiting on it, and says why", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    const { result, ms } = await read();
    expect(result).toEqual({ ok: false, error: BLOCKED, noResponse: true, blockPage: true });
    expect(ms).toBe(0);
  });

  /** One name that resolves for real is enough to say nothing about the
   * block page: then the network is not keeping all of Neoxify away, and
   * the race that found nothing says what it always has. */
  it("does not say the network blocks Neoxify when one name resolved somewhere real", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    network[F] = "reset";
    resolver.set("f.example", ["203.0.113.10"]);
    const { result } = await read();
    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
  });

  /** Before a connect the resolver answers every name with the block page;
   * once the tunnel is up it answers for real. A look that found the block
   * page used to be trusted for a minute, and every request in that
   * minute -- the slot claim through the tunnel, a server switch -- was not
   * sent at all, and said Neoxify could not be reached. */
  it("looks again once the resolver answers for real, as through a tunnel just up", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    const before = await read();
    expect(before.result.ok).toBe(false);

    // Ten seconds later, through the tunnel.
    vi.advanceTimersByTime(10_000);
    for (const base of ENDPOINTS) resolver.set(new URL(base).hostname, ["203.0.113.10"]);
    network[A] = answers(200);
    const after = await read();
    expect(after.result.ok).toBe(true);
    expect(after.sent).toContain(A);
  });

  /** An ordinary answer from the resolver changes nothing. */
  it("leaves alone an address whose name resolves somewhere real", async () => {
    resolver.set("a.example", ["203.0.113.10"]);
    network[A] = answers(1_000);
    const { result, ms, sent } = await read();
    expect(result.ok).toBe(true);
    expect(ms).toBe(1_000);
    expect(sent).toEqual([A]);
  });
});

describe("a block page that refuses the connection outright", () => {
  /** Every name resolves to the block page, and the page resets each
   * connection at once -- before the look at the name comes back. Before:
   * each failure was recorded as a plain refusal, and the customer was
   * told to check a connection that works; which of the two they were
   * told depended on which came back first. */
  it("still says the network sends Neoxify to the block page", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "reset";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    const trace = newTrace();
    const { result } = await read(trace);

    expect(result).toEqual({ ok: false, error: BLOCKED, noResponse: true, blockPage: true });
    expect(renderTrace(trace)).not.toContain("net@");
  });
});

describe("a write sent straight to the address that answered last", () => {
  /** Connected, reads went through the tunnel to D, which became the
   * address the next write goes straight to. The tunnel drops, and on the
   * carrier's network D's name resolves to the block page, where the
   * connection hangs. Before: the write waited out D's eight seconds
   * there -- the whole of a slot claim's budget -- before asking anyone
   * else. */
  it("is stopped as soon as the address's name turns out to be on the block page", async () => {
    resolver.set("d.example", ["203.0.113.10"]);
    network[D] = answers(100);
    await read();
    expect(remembered).toEqual([D]);

    resolver.set("d.example", BLOCK_PAGE);
    network[D] = "stall";
    network[C] = answers(100);
    const trace = newTrace();
    const { result, ms } = await run(() => publicRequest("/client-attempts", { method: "POST", body: "{}" }, trace));

    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(5_000);
    expect(renderTrace(trace)).toMatch(/^req: d\.example=blockpage@0; health: /);
  });
});

describe("requests that go through a proxy", () => {
  /** The tester network on which every name, the CDN's included, resolves
   * here to the block page -- with Psiphon, v2rayN or Clash in system-proxy
   * mode, which is how people in Iran get past a blocked sign-in. The
   * proxy resolves the names at its own end, and reaches A. Before: each
   * race's look found the block page and stopped every request, the names
   * were demoted and the next race sent them nothing at all, and the
   * screen said the network was blocking Neoxify. */
  it("are sent to a name this machine's resolver puts on the block page, and its answer is taken", async () => {
    proxy.on = true;
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    network[A] = answers(300);
    const first = await read();
    expect(first.result.ok).toBe(true);
    expect(first.ms).toBe(300);

    // Nothing was demoted: the next read is A's alone, as on any network.
    const trace = newTrace();
    const second = await read(trace);
    expect(second.result.ok).toBe(true);
    expect(second.sent).toEqual([A]);
    expect(renderTrace(trace)).toBe("req: a.example=h200@300");
  });

  /** With no proxy, the same network is what the look was written for, and
   * it still decides: every request stopped, the names demoted, nothing
   * sent to them by the next race, and the block page named. */
  it("leave the look to decide where no proxy is in the way", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    network[A] = answers(300);
    const first = await read();
    expect(first.result).toEqual({ ok: false, error: BLOCKED, noResponse: true, blockPage: true });
    const second = await read();
    expect(second.sent).toEqual([]);
    expect(second.result).toEqual({ ok: false, error: BLOCKED, noResponse: true, blockPage: true });
  });

  /** The names were found on the block page, and demoted, before the proxy
   * was switched on. A demoted name is looked at again before anything is
   * sent to it, and through the proxy the look finds nothing. */
  it("are sent to a name found on the block page before the proxy was switched on", async () => {
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    const before = await read();
    expect(before.result).toMatchObject({ ok: false, blockPage: true });

    proxy.on = true;
    network[A] = answers(300);
    const after = await read();
    expect(after.result.ok).toBe(true);
    expect(after.sent).toContain(A);
  });

  /** Nothing answering through the proxy either is Neoxify not answering,
   * not this network's DNS: the request never used it. */
  it("never say the network blocks Neoxify", async () => {
    proxy.on = true;
    for (const base of ENDPOINTS) {
      network[base] = "stall";
      resolver.set(new URL(base).hostname, BLOCK_PAGE);
    }
    const { result } = await read();
    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
  });

  /** A write sent straight to the address that answered last, whose name
   * this machine's resolver has since started to put on the block page.
   * Before: stopped at once on the look, and then a health race. */
  it("include a write sent straight to the address that answered last", async () => {
    resolver.set("d.example", ["203.0.113.10"]);
    network[D] = answers(100);
    await read();
    expect(remembered).toEqual([D]);

    proxy.on = true;
    resolver.set("d.example", BLOCK_PAGE);
    const trace = newTrace();
    const { result, sent } = await run(() => publicRequest("/client-attempts", { method: "POST", body: "{}" }, trace));

    expect(result.ok).toBe(true);
    expect(sent).toEqual([D]);
    expect(renderTrace(trace)).toBe("req: d.example=h200@100");
  });
});
