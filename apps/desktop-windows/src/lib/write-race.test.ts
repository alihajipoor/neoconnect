import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** Where a write goes, and how long it takes, on a filtered network.
 *
 * Every write that is not a sign-in -- the token refresh, the social
 * sign-in exchange, a route switch, an attempt report -- is driven here
 * through the real api.ts, with the network stood in for per address and
 * per path, and the clock faked so that a blackholed address costs
 * exactly what its timeout says.
 *
 * The "before" figures in the comments were worked out from the code as
 * it was, on these same four addresses: a write walked the whole list in
 * order, eight seconds for each address that did not answer, whatever the
 * rest of the app had found out about the network. In a VM with every
 * name but one sinkholed that was 56 seconds for one report, against 0.9
 * for the reads made at the same moment. The real list has eleven to
 * sixteen addresses, and every figure is longer with it.
 */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const D = "https://d.example";
const ENDPOINTS = [A, B, C, D];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

const { remembered } = vi.hoisted(() => ({ remembered: [] as string[] }));
vi.mock("./api-endpoints", () => ({
  // The list in a fixed order, so that where a write goes is decided by
  // what answered and not by which address happens to lead it.
  apiEndpoints: () => Promise.resolve([...ENDPOINTS]),
  rememberEndpoint: (base: string) => {
    remembered.push(base);
    return Promise.resolve();
  },
  rememberedEndpoint: () => Promise.resolve(remembered[remembered.length - 1]),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve() }));
const { stored } = vi.hoisted(() => ({ stored: { tokens: null as { accessToken: string; refreshToken: string } | null } }));
vi.mock("./session", () => ({
  getTokens: async () => stored.tokens,
  setTokens: async (tokens: { accessToken: string; refreshToken: string }) => {
    stored.tokens = tokens;
  },
  clearTokens: async () => {
    stored.tokens = null;
  },
}));

const { apiRequest, publicRequest, resetRaceWinnerForTests, RENEWAL_UNANSWERED } = await import("./api");
const { demoteName } = await import("./endpoint-demotion");
const { newTrace, renderTrace } = await import("./endpoint-trace");
const { onSessionRevoked } = await import("./session-revoked");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";
const STOPPED = "Neoxify answered but then stopped responding. Please try again.";

/** How one address treats one request: answers after a delay, never
 * answers (blackholed), or fails at once (reset). A list is used up one
 * request at a time, its last entry for every request after. */
type Behaviour = { after: number; reply: () => Response } | "hang" | "reset";
let network: Record<string, Record<string, Behaviour | Behaviour[]>>;

/** Every request that left the device, in order. */
let sent: { origin: string; path: string; method: string }[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status: number) =>
  new Response("<html><body>Forbidden</body></html>", { status, headers: { "content-type": "text/html" } });

const healthy = () => json({ status: "ok", timestamp: "2026-10-09T00:00:00.000Z" });
const noContent = () => new Response(null, { status: 204 });
const answers = (after: number, reply: () => Response): Behaviour => ({ after, reply });

function behaviourFor(origin: string, path: string): Behaviour {
  const entry = network[origin]?.[path];
  if (entry === undefined) return "hang";
  if (!Array.isArray(entry)) return entry;
  return entry.length > 1 ? entry.shift()! : entry[0];
}

function respond(behaviour: Behaviour, signal?: AbortSignal | null): Promise<Response> {
  if (behaviour === "reset") return Promise.reject(new Error("error sending request for url"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Request cancelled"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    if (behaviour === "hang") return;
    setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(behaviour.reply());
    }, behaviour.after);
  });
}

/** A request, started now: its result, and how long after starting it
 * arrived, once the fake clock has been run on far enough. */
function start<T>(request: () => Promise<ApiResult<T>>) {
  const startedAt = Date.now();
  let ms: number | null = null;
  const result = request().then((r) => {
    ms = Date.now() - startedAt;
    return r;
  });
  return { result, ms: () => ms };
}

async function run<T>(request: () => Promise<ApiResult<T>>) {
  const pending = start(request);
  await vi.runAllTimersAsync();
  return { result: await pending.result, ms: pending.ms() as number };
}

const sentTo = (path: string) => sent.filter((s) => s.path === path).map((s) => s.origin);

const report = () => publicRequest<void>("/client-attempts", { method: "POST", body: "{}" });

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  network = {};
  sent = [];
  remembered.length = 0;
  announced = 0;
  stored.tokens = { accessToken: "access", refreshToken: "refresh" };
  tauriFetch.mockImplementation((url: string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url);
    sent.push({ origin, path: pathname, method: (init?.method ?? "GET").toUpperCase() });
    return respond(behaviourFor(origin, pathname), init?.signal);
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("a write with no recent answer to go on", () => {
  /** The VM's shape: the remembered address and most others blackholed,
   * one refusing, the last alive. Before: 16.3 seconds, the report sent
   * to every address in turn. */
  it("is sent only where the health check was answered", async () => {
    network[C] = { "/health": "reset", "/client-attempts": "reset" };
    network[D] = { "/health": answers(300, healthy), "/client-attempts": answers(300, noContent) };
    const trace = newTrace();

    const { result, ms } = await run(() =>
      publicRequest<void>("/client-attempts", { method: "POST", body: "{}" }, trace),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([D]);
    // The first address's head start, then D's answer, then the write.
    expect(ms).toBe(1_500 + 300 + 300);
    expect(renderTrace(trace)).toBe(
      "health: a.example=cancel@1800 b.example=cancel@300 c.example=net@0 d.example=h200@300; req: d.example=h204@300",
    );
  });

  /** Before: 32 seconds, and the code sent to every address on the way,
   * before "could not reach Neoxify". */
  it("is not sent at all when nothing answers the health check", async () => {
    const trace = newTrace();

    const { result, ms } = await run(() =>
      publicRequest(
        "/customer-auth/social/exchange",
        { method: "POST", body: JSON.stringify({ code: "c", verifier: "v" }) },
        trace,
      ),
    );

    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(sentTo("/customer-auth/social/exchange")).toEqual([]);
    expect(ms).toBe(1_500 + 20_000);
    expect(renderTrace(trace)).toBe(
      "health: a.example=timeout@20000 b.example=timeout@20000 c.example=timeout@20000 d.example=timeout@20000",
    );
  });

  /** A node's fallback site without the API, or the CDN's bot check,
   * answers in milliseconds and is not the backend. Before: the write
   * went to it first, was answered with its page, and failed with
   * "Request failed (403)". */
  it("does not go first to an address whose answer was a page", async () => {
    network[A] = { "/health": answers(50, () => page(403)), "/client-attempts": answers(50, () => page(403)) };
    network[B] = { "/health": answers(300, healthy), "/client-attempts": answers(100, noContent) };

    const { result } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([B]);
  });

  /** The health check is throttled per address, and behind a mirror that
   * address is the node's, shared by everyone using it. A 429 from the
   * backend still proves the address reaches it. */
  it("takes a throttled answer to the health check as an answer", async () => {
    const throttled = () => json({ statusCode: 429, message: "ThrottlerException: Too Many Requests" }, 429);
    network[A] = { "/health": answers(50, throttled), "/client-attempts": answers(100, noContent) };
    network[B] = { "/health": answers(400, healthy), "/client-attempts": answers(100, noContent) };

    const { result } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([A]);
    expect(sentTo("/health")).toEqual([A]);
  });

  /** The address that answered the health check can still fail the write
   * itself. The others were never asked, because the first answer ended
   * the race, so they are asked now -- not the one that failed. */
  it("asks the rest when the address that answered then fails the write", async () => {
    network[A] = { "/health": answers(100, healthy), "/client-attempts": "reset" };
    network[C] = { "/health": answers(200, healthy), "/client-attempts": answers(100, noContent) };

    const { result, ms } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([A, C]);
    expect(sentTo("/health")).toEqual([A, B, C, D]);
    // A's answer, then B's head start in the second race, C's answer,
    // and the write.
    expect(ms).toBe(100 + 1_500 + 200 + 100);
  });

  /** A second race asks only what the first had not heard from: not B,
   * which refused the health check outright. A, still pending when C
   * answered, is asked again. */
  it("does not ask again an address that failed the health check", async () => {
    network[B] = { "/health": "reset" };
    network[C] = { "/health": answers(300, healthy), "/client-attempts": "reset" };
    network[D] = { "/health": answers(300, healthy), "/client-attempts": answers(100, noContent) };

    const { result, ms } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([C, D]);
    expect(sentTo("/health")).toEqual([A, B, C, D, A, D]);
    expect(ms).toBe(1_500 + 300 + 1_500 + 300 + 100);
  });
});

describe("a write after a read", () => {
  /** Before: 24.2 seconds, the route switch walking three blackholed
   * addresses to reach the one the route list had just come from. */
  it("goes straight to the address the read was answered by", async () => {
    network[D] = {
      "/customer/subscriptions/s1/routes": answers(200, () => json([])),
      "/customer/subscriptions/s1/route": answers(200, () => json({ id: "pu1" })),
    };
    await run(() => apiRequest("/customer/subscriptions/s1/routes"));

    const { result, ms } = await run(() =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) }),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([D]);
    expect(sentTo("/health")).toEqual([]);
    expect(ms).toBe(200);
  });

  /** The token refresh that follows an expired access token, which is
   * what the pre-connect config refresh runs into after any real idle --
   * inside a six-second budget. Before: 24.6 seconds for the read, the
   * refresh walking the same three blackholed addresses first. */
  it("sends the token refresh where the read was just refused", async () => {
    network[D] = {
      "/customer/me": [answers(200, () => json({ message: "Unauthorized" }, 401)), answers(200, () => json({ id: "c1" }))],
      "/customer-auth/refresh": answers(200, () => json({ accessToken: "access2", refreshToken: "refresh2" })),
    };

    const { result, ms } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(sentTo("/customer-auth/refresh")).toEqual([D]);
    expect(sentTo("/health")).toEqual([]);
    // Each read waits out A's head start, since this list leads with A
    // whatever answered (the app's own leads with the address that did),
    // and is answered by D; the refresh goes straight to D in between.
    expect(ms).toBe(1_500 + 200 + 200 + 1_500 + 200);
  });

  /** A page can win a raced read today. It is not offered to the next
   * write, which would stop on it. */
  it("is not sent where the read was only answered by a page", async () => {
    network[A] = {
      "/config": answers(50, () => page(404)),
      "/health": answers(50, () => page(404)),
      "/client-attempts": answers(50, () => page(404)),
    };
    network[B] = {
      "/config": answers(300, () => json({})),
      "/health": answers(300, healthy),
      "/client-attempts": answers(100, noContent),
    };
    await run(() => publicRequest("/config"));

    const { result } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([B]);
  });

  /** The read's address then stops answering, and so does everything
   * else. The first write finds that out the slow way; the next, inside
   * the same minute, does not wait on that address again.
   *
   * Both say Neoxify could not be reached, because nothing answered either
   * of them. Before, the first said it had stopped responding, on the
   * strength of an answer to another request up to a minute and a half
   * old -- perhaps on the network the laptop had just left -- and the
   * second, on the same network a moment later, said it could not be
   * reached. */
  it("does not send the next write where the last one got nothing", async () => {
    network[D] = { "/customer/subscriptions/s1/routes": answers(200, () => json([])) };
    await run(() => apiRequest("/customer/subscriptions/s1/routes"));
    network = {};

    const switchRoute = () =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) });
    const first = await run(switchRoute);
    const second = await run(switchRoute);

    expect(first.result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(second.result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    // D's eight seconds, then a health race nothing answers.
    expect(first.ms).toBe(8_000 + 1_500 + 20_000);
    // The health race alone.
    expect(second.ms).toBe(1_500 + 20_000);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([D]);
  });

  /** A minute and a half on, the answer may be from another network, or
   * the address blocked since. The write asks again. */
  it("asks again once the read's answer is a minute and a half old", async () => {
    network[D] = {
      "/customer/subscriptions/s1/routes": answers(200, () => json([])),
      "/health": answers(100, healthy),
      "/customer/subscriptions/s1/route": answers(200, () => json({ id: "pu1" })),
    };
    await run(() => apiRequest("/customer/subscriptions/s1/routes"));
    await vi.advanceTimersByTimeAsync(90_000);

    const { result, ms } = await run(() =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) }),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/health")).toEqual([A, B, C, D]);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([D]);
    expect(ms).toBe(1_500 + 100 + 200);
  });
});

/** A 401 from an address that is not the backend, which answers faster
 * than the backend can because it never reaches it. In a simulated
 * network, before: the 401 won the read, the token refresh was sent to the
 * same address and refused there, and the customer was signed out --
 * which takes the tunnel down. */
describe("a 401 from something that is not the backend", () => {
  const unauthorized = () => json({ statusCode: 401, message: "Unauthorized" }, 401);
  const pair = () => json({ accessToken: "access2", refreshToken: "refresh2" });

  /** And the session is renewed where the backend is. Before: the read
   * and every read after it ended with "could not renew your session",
   * A winning each one with its fast 401 and refusing the refresh, while
   * D would have renewed it. */
  it("does not sign the customer out when one address answers 401 to everything, and renews elsewhere", async () => {
    network[A] = {
      "/customer/me": answers(50, unauthorized),
      "/customer-auth/refresh": answers(50, unauthorized),
      "/health": answers(50, unauthorized),
    };
    network[D] = {
      "/customer/me": answers(300, () => json({ id: "c1" })),
      "/customer-auth/refresh": answers(300, pair),
      "/health": answers(300, healthy),
    };
    const trace = newTrace();

    const { result } = await run(() => apiRequest("/customer/me", undefined, trace));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(stored.tokens).toEqual({ accessToken: "access2", refreshToken: "refresh2" });
    expect(announced).toBe(0);
    // The refusal was not believed until the address answered the public
    // health check as the backend would, and it did not; then the refresh
    // went on to the rest, and the read again found D past A's 401.
    expect(renderTrace(trace)).toBe(
      "req: a.example=h401@50; refresh: a.example=h401@50; " +
        "health: a.example=h401@50 b.example=cancel@1800 c.example=cancel@300 d.example=h200@300; " +
        "refresh: d.example=h200@300; " +
        "retry: a.example=h401@50 b.example=cancel@300 c.example=cancel@300 d.example=h200@300",
    );
    expect(sentTo("/customer-auth/refresh")).toEqual([A, D]);

    // A no longer wins a read: its 401 is not the backend's.
    sent = [];
    const next = await run(() => apiRequest("/customer/me"));
    expect(next.result).toEqual({ ok: true, data: { id: "c1" } });
    expect(sentTo("/customer-auth/refresh")).toEqual([]);
  });

  /** Before: the page won the read, and the read failed with "Request
   * failed (401)" after a token refresh nobody needed. */
  it("does not let a fast 401 page decide the read", async () => {
    network[A] = {
      "/customer/me": answers(50, () => page(401)),
      "/customer-auth/refresh": answers(50, () => page(401)),
      "/health": answers(50, () => page(401)),
    };
    network[D] = { "/customer/me": answers(300, () => json({ id: "c1" })) };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(sentTo("/customer-auth/refresh")).toEqual([]);
    expect(announced).toBe(0);
  });

  /** The refresh may be sent twice (`REPEATABLE_WRITES` in api.ts), so a
   * gateway page at the address it went to first does not end it. Before:
   * "could not renew your session" with D ready to renew it. */
  it("sends the token refresh on past a gateway page", async () => {
    network[A] = {
      "/customer/me": [answers(100, unauthorized), answers(100, () => json({ id: "c1" }))],
      "/customer-auth/refresh": answers(100, () => page(502)),
    };
    network[D] = { "/health": answers(200, healthy), "/customer-auth/refresh": answers(100, pair) };

    const { result, ms } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(sentTo("/customer-auth/refresh")).toEqual([A, D]);
    expect(stored.tokens).toEqual({ accessToken: "access2", refreshToken: "refresh2" });
    // The read, A's page, B's head start in the health race, D's answer
    // to it, the refresh at D, and the read again.
    expect(ms).toBe(100 + 100 + 1_500 + 200 + 100 + 100);
  });
});

describe("a write already under way", () => {
  /** The VM again: a report was still waiting out a dead address while
   * the dashboard's reads found a live one, and it carried on down its
   * own list regardless. Here the write's own health race was answered by
   * an address that then hangs on the write; a read started a second
   * later finds D. Without reading the remembered endpoint again, the
   * write would run a second health race and arrive at 10.2 seconds. */
  it("is sent next to an address another request has just found", async () => {
    network[A] = { "/health": answers(100, healthy), "/client-attempts": "hang", "/config": "hang" };
    network[D] = {
      "/health": answers(300, healthy),
      "/config": answers(200, () => json({})),
      "/client-attempts": answers(300, noContent),
    };
    const trace = newTrace();

    const write = start(() => publicRequest<void>("/client-attempts", { method: "POST", body: "{}" }, trace));
    await vi.advanceTimersByTimeAsync(1_000);
    const read = start(() => publicRequest("/config"));
    await vi.runAllTimersAsync();

    expect((await read.result).ok).toBe(true);
    expect((await write.result).ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([A, D]);
    // A's answer to the health check, its eight seconds on the write, and
    // D's answer.
    expect(write.ms()).toBe(100 + 8_000 + 300);
    expect(renderTrace(trace)).toBe("health: a.example=h200@100; req: a.example=timeout@8000 d.example=h204@300");
  });
});

describe("an address that has stopped taking writes", () => {
  /** The health race's winner, which then goes dark: the write times out
   * there, and nothing else answers. Before: the next write inside the
   * minute went to it first, and waited out the same eight seconds there
   * before asking anyone else. */
  it("is not sent the next write when it won a health race and then got nothing", async () => {
    network[A] = { "/health": [answers(100, healthy), "hang"], "/client-attempts": "hang" };

    const first = await run(report);
    expect(first.result).toEqual({ ok: false, error: STOPPED, noResponse: true });

    // D answers now; A still takes nothing.
    network[D] = { "/health": answers(300, healthy), "/client-attempts": answers(100, noContent) };
    sent = [];
    const second = await run(report);
    expect(second.result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([D]);
    // A's head start in the health race, and D's answers: not eight
    // seconds at A first.
    expect(second.ms).toBe(1_500 + 300 + 100);
  });

  /** A read's winner whose next answer is a gateway page: a mirror whose
   * upstream has just broken. Before: every write for a minute went to it
   * first and ended on its 502, which a write that must not be sent twice
   * stops at -- B, which would have taken them, was never asked. */
  it("is not sent the next write when it answered the last one with a gateway page", async () => {
    network[A] = { "/config": answers(50, () => json({})) };
    network[B] = { "/health": answers(200, healthy), "/customer/subscriptions/s1/route": answers(100, () => json({ id: "pu1" })) };
    await run(() => publicRequest("/config"));
    network[A] = { "/health": answers(50, () => page(502)), "/customer/subscriptions/s1/route": answers(50, () => page(502)) };

    const switchRoute = () =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) });
    const first = await run(switchRoute);
    // The first may have reached the backend, so it is not sent on.
    expect(first.result).toMatchObject({ ok: false, status: 502 });

    sent = [];
    const second = await run(switchRoute);
    expect(second.result.ok).toBe(true);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([B]);
  });

  /** Demoted on this network since it won -- its name found on the block
   * page -- it does not lead a race, and does not lead a write either. */
  it("is not sent the next write once it has been demoted", async () => {
    network[D] = { "/config": answers(100, () => json({})), "/client-attempts": answers(100, noContent) };
    network[C] = { "/health": answers(100, healthy), "/client-attempts": answers(100, noContent) };
    await run(() => publicRequest("/config"));
    demoteName("d.example");

    const { result } = await run(report);
    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([C]);
  });
});

describe("a write that follows a write", () => {
  /** The device slot is renewed every sixty seconds while connected, and
   * the release on Disconnect has a second and a half. Before: only a race
   * renewed the trust in an address, and it lasted sixty seconds, so about
   * half of all releases began with a health check -- two fresh
   * connections in a row, past the budget on a slow link. Now an answered
   * write renews it, for ninety seconds. */
  it("goes straight to the address the last one was answered at, a minute and more on", async () => {
    network[D] = {
      "/config": answers(100, () => json({})),
      "/customer/vpn/renew": answers(100, () => json({ status: "held" })),
      "/customer/vpn/release": answers(100, noContent),
    };
    await run(() => publicRequest("/config"));
    await vi.advanceTimersByTimeAsync(50_000);
    await run(() => apiRequest("/customer/vpn/renew", { method: "POST", body: "{}" }));
    await vi.advanceTimersByTimeAsync(60_000);

    sent = [];
    const { result, ms } = await run(() => apiRequest("/customer/vpn/release", { method: "POST", body: "{}" }));
    expect(result.ok).toBe(true);
    expect(sentTo("/health")).toEqual([]);
    expect(ms).toBe(100);
  });
});

describe("what a health race will take as the backend", () => {
  /** GET /health is public: the backend answers it 200, 503 or 429, never
   * 401. Before: A's JSON 401 won the race, was remembered, and took the
   * write, which it refused -- and a report refused that way counts as
   * delivered and is dropped. */
  it("is not an address that answers its public health check with 401", async () => {
    const unauthorized = () => json({ statusCode: 401, message: "Unauthorized" }, 401);
    network[A] = { "/health": answers(50, unauthorized), "/client-attempts": answers(50, unauthorized) };
    network[D] = { "/health": answers(300, healthy), "/client-attempts": answers(100, noContent) };

    const { result } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([D]);
    expect(remembered).not.toContain(A);
  });

  /** A mirror whose upstream is broken answers the health check with its
   * 502 page, fast. Before: it was sent the write after the backend's own
   * answerer reset it, and its 502 ended a write that must not be sent
   * twice before D, stopped when C answered, was ever asked. */
  it("does not send the write to an address that answered it with a page", async () => {
    network[A] = { "/health": "hang" };
    network[B] = { "/health": answers(20, () => page(502)), "/customer/subscriptions/s1/route": answers(20, () => page(502)) };
    network[C] = { "/health": answers(100, healthy), "/customer/subscriptions/s1/route": "reset" };
    network[D] = { "/health": answers(300, healthy), "/customer/subscriptions/s1/route": answers(100, () => json({ id: "pu1" }, 201)) };

    const { result } = await run(() =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) }),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([C, D]);
  });

  /** Only a page answered, and the mirrors are blackholed. Before: the
   * write went to the page's address, failed there in transport, and the
   * customer was told to check their connection although something had
   * answered moments earlier. */
  it("says what answered when only a page did", async () => {
    network[A] = { "/health": answers(50, () => page(403)), "/client-attempts": "reset" };

    const { result } = await run(report);

    expect(result).toEqual({ ok: false, error: "Request failed (403)", status: 403, page: true });
    expect(sentTo("/client-attempts")).toEqual([]);
  });
});

describe("a read answered by a fallback site", () => {
  /** A node's fallback site answers 200 with its HTML to any path, in ten
   * milliseconds. Before: it won the read, was remembered, and the read
   * then threw on the body -- an exception to a caller that expected a
   * result. */
  it("is won by the backend's JSON, not the site's 200", async () => {
    const site = () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    network[A] = { "/customer/me": answers(10, site) };
    network[B] = { "/customer/me": answers(300, () => json({ id: "c1" })) };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(remembered).toEqual([B]);
  });

  /** And when it is the only answer, it is a failure with its status, not
   * a rejection. */
  it("is a failure, not an exception, when nothing else answers", async () => {
    const site = () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    network[A] = { "/customer/me": answers(10, site) };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: false, error: "Request failed (200)", status: 200, page: true });
  });
});

describe("a session that cannot be renewed just now", () => {
  /** The backend answered the read with a 401, and the token refresh then
   * got no answer anywhere. Before: one English sentence for this and for
   * a refresh a page answered, with nothing for the screen to translate
   * by. */
  it("says the renewal got no answer, in words the screens can translate", async () => {
    network[D] = { "/customer/me": answers(100, () => json({ message: "Unauthorized" }, 401)) };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: false, error: RENEWAL_UNANSWERED });
    expect(stored.tokens).toEqual({ accessToken: "access", refreshToken: "refresh" });
  });

  /** The session was renewed and the retry then got nothing. Before:
   * "could not reach Neoxify -- check your internet connection", about a
   * backend that had answered this request twice. */
  it("says Neoxify stopped responding when the retry after a renewal gets nothing", async () => {
    network[D] = {
      "/customer/me": [answers(100, () => json({ message: "Unauthorized" }, 401)), "hang"],
      "/customer-auth/refresh": answers(100, () => json({ accessToken: "access2", refreshToken: "refresh2" })),
    };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: false, error: STOPPED, noResponse: true });
  });
});

describe("a page on the health check during an outage", () => {
  const unauthorized = () => json({ statusCode: 401, message: "Unauthorized" }, 401);
  const pair = () => json({ accessToken: "access2", refreshToken: "refresh2" });

  /** A deploy: the only address this network reaches answers a report's
   * health check with its gateway page. Then the backend is back and the
   * access token has expired. Before: the page had marked the address as
   * not the backend, so its JSON 401 was a page too, no refresh was sent,
   * and every screen said "Request failed (401)" until some write
   * happened to check the address again. */
  it("does not keep the backend's own 401 from renewing the session afterwards", async () => {
    network[A] = { "/health": answers(50, () => page(502)) };
    const outage = await run(report);
    expect(outage.result).toMatchObject({ ok: false, status: 502 });

    network[A] = {
      "/customer/me": [answers(100, unauthorized), answers(100, () => json({ id: "c1" }))],
      "/customer-auth/refresh": answers(100, pair),
    };
    sent = [];
    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(sentTo("/customer-auth/refresh")).toEqual([A]);
    expect(stored.tokens).toEqual({ accessToken: "access2", refreshToken: "refresh2" });
  });
});

describe("an address that answers its public health check with a 403 or 404", () => {
  /** It is not the backend, which never says either there. Before: that
   * very answer counted the address as one the backend answered from, so
   * its JSON 401 to the token refresh was believed -- the customer was
   * signed out and the tunnel taken down by something that was not us. */
  it.each([403, 404])("is not believed when it refuses the token refresh (health %i)", async (status) => {
    network[A] = {
      "/customer/me": answers(50, () => json({ statusCode: 401, message: "Unauthorized" }, 401)),
      "/customer-auth/refresh": answers(50, () => json({ statusCode: 401, message: "Refresh token has been revoked" }, 401)),
      "/health": answers(50, () => json({ statusCode: status, message: "Nope" }, status)),
    };

    const { result } = await run(() => apiRequest("/customer/me"));

    expect(result).not.toHaveProperty("sessionExpired");
    expect(announced).toBe(0);
    expect(stored.tokens).toEqual({ accessToken: "access", refreshToken: "refresh" });
  });
});

describe("a read won by a JSON 401", () => {
  /** An address answering JSON 401 to everything wins the launch's public
   * read before anything shows it is not the backend. Before: the attempt
   * report that followed went there alone, with no health check; its 401
   * counted the report as delivered, and the report was dropped while D
   * was healthy. A 401 is offered only to the token refresh it causes. */
  it("is not where the next write goes, other than the token refresh", async () => {
    const unauthorized = () => json({ statusCode: 401, message: "Unauthorized" }, 401);
    network[A] = { "/health/ip": answers(50, unauthorized), "/health": answers(50, unauthorized), "/client-attempts": answers(50, unauthorized) };
    network[D] = { "/health": answers(300, healthy), "/client-attempts": answers(100, noContent) };
    await run(() => publicRequest("/health/ip"));

    sent = [];
    const { result } = await run(report);

    expect(result.ok).toBe(true);
    expect(sentTo("/client-attempts")).toEqual([D]);
  });
});

describe("a write with a deadline of its own", () => {
  /** The device-slot claim before a dial has three seconds. Here every
   * fresh request to the address that works takes 1.6 seconds, and the
   * dashboard's read was answered there two minutes ago. Before: the
   * trust had lapsed, so the claim ran a health race first -- two fresh
   * connections in a row, led by a dead address -- and its three seconds
   * ran out before the claim was sent. */
  it("goes straight to the remembered address once the trust has lapsed", async () => {
    network[D] = {
      "/customer/me": answers(1_600, () => json({ id: "c1" })),
      "/health": answers(1_600, healthy),
      "/customer/vpn/claim": answers(1_600, () => json({ granted: true })),
    };
    await run(() => apiRequest("/customer/me"));
    await vi.advanceTimersByTimeAsync(120_000);

    sent = [];
    const budget = new AbortController();
    setTimeout(() => budget.abort(), 3_000);
    const { result, ms } = await run(() =>
      apiRequest("/customer/vpn/claim", { method: "POST", body: "{}", signal: budget.signal }),
    );

    expect(result.ok).toBe(true);
    expect(ms).toBe(1_600);
    expect(sentTo("/health")).toEqual([]);
  });

  /** A read through a failing tunnel timed out at the address the slot was
   * renewed at, and demoted it. Then Disconnect: the release has a second
   * and a half. Before: no address was trusted, so the release ran a
   * health race in which the demoted address was asked last, three
   * seconds in, and the slot stayed held until it went stale. */
  it("goes there even when a timeout has demoted it since", async () => {
    network[D] = { "/customer/me": answers(100, () => json({ id: "c1" })) };
    await run(() => apiRequest("/customer/me"));
    // Only D times out; the rest refuse at once, which demotes nothing.
    network[D] = { "/customer/me": "hang" };
    for (const origin of [A, B, C]) network[origin] = { "/customer/me": "reset" };
    await run(() => apiRequest("/customer/me"));
    network[D] = { "/customer/vpn/release": answers(100, noContent) };

    sent = [];
    const budget = new AbortController();
    setTimeout(() => budget.abort(), 1_500);
    const { result } = await run(() =>
      apiRequest("/customer/vpn/release", { method: "POST", body: "{}", signal: budget.signal }),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/customer/vpn/release")).toEqual([D]);
  });
});
