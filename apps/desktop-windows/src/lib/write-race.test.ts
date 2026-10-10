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

const { apiRequest, publicRequest, resetRaceWinnerForTests } = await import("./api");
const { newTrace, renderTrace } = await import("./endpoint-trace");

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";

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
    expect(ms).toBe(600);
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
   * the same minute, does not wait on that address again. */
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

  /** A minute on, the answer may be from another network, or the address
   * blocked since. The write asks again. */
  it("asks again once the read's answer is a minute old", async () => {
    network[D] = {
      "/customer/subscriptions/s1/routes": answers(200, () => json([])),
      "/health": answers(100, healthy),
      "/customer/subscriptions/s1/route": answers(200, () => json({ id: "pu1" })),
    };
    await run(() => apiRequest("/customer/subscriptions/s1/routes"));
    await vi.advanceTimersByTimeAsync(60_000);

    const { result, ms } = await run(() =>
      apiRequest("/customer/subscriptions/s1/route", { method: "POST", body: JSON.stringify({ routeId: "r1" }) }),
    );

    expect(result.ok).toBe(true);
    expect(sentTo("/health")).toEqual([A, B, C, D]);
    expect(sentTo("/customer/subscriptions/s1/route")).toEqual([D]);
    expect(ms).toBe(1_500 + 100 + 200);
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
