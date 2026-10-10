import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** How long a read waits for an answer, and how soon a blocked network
 * is given up on.
 *
 * Driven through the real api.ts against a network stood in for per
 * address, with a fake clock. Two kinds of silence are told apart here,
 * because filtering produces both and they now end differently:
 *
 *  - a blackhole, where the connection itself never completes. The HTTP
 *    plugin gives up on it at the `connectTimeout` it is passed, with the
 *    same sentence it uses for every transport failure -- which is what
 *    this stand-in does, and only when it is passed one;
 *  - a stall, where the connection is up and the answer is slow or never
 *    comes. Only the request's own deadline ends that.
 *
 * Before: a read gave every address eight seconds and no connection
 * deadline, so a CDN answering at nine to twenty seconds while the
 * mirrors were blocked was thrown away, and the server list and the
 * dashboard said Neoxify could not be reached although it had replied.
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
  apiEndpoints: () => Promise.resolve([...ENDPOINTS]),
  rememberEndpoint: (base: string) => {
    remembered.push(base);
    return Promise.resolve();
  },
  rememberedEndpoint: () => Promise.resolve(remembered[remembered.length - 1]),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve() }));

const { publicRequest, resetRaceWinnerForTests, CONNECT_TIMEOUT_MS, SLOW_ANSWER_MS } = await import("./api");
const { newTrace, renderTrace } = await import("./endpoint-trace");

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";

/** What one address does with a request. A list is used up one request
 * at a time, its last entry for every request after. */
type Behaviour =
  | { after: number; reply: () => Response }
  /** Never completes a connection. */
  | "blackhole"
  /** Connected; never answers. */
  | "stall"
  /** Refused at once. */
  | "reset"
  /** Refused after a while, with the connection already up. */
  | { resetAfter: number };
let network: Record<string, Record<string, Behaviour>>;

/** Every request that left the device: where, and with which options. */
let sent: { origin: string; path: string; connectTimeout: unknown }[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answers = (after: number, reply: () => Response): Behaviour => ({ after, reply });

/** The HTTP plugin's rejection for any transport failure: reqwest's
 * message, which names the URL and drops the cause. */
const transportError = (url: string) => `error sending request for url (${url})`;

function respond(url: string, behaviour: Behaviour, init?: RequestInit & { connectTimeout?: number }): Promise<Response> {
  const signal = init?.signal;
  if (behaviour === "reset") return Promise.reject(transportError(url));
  return new Promise((resolve, reject) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onAbort = () => {
      timers.forEach(clearTimeout);
      reject(new Error("Request cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    const settle = (after: number, outcome: () => void) =>
      timers.push(
        setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          outcome();
        }, after),
      );
    if (behaviour === "stall") return;
    if (behaviour === "blackhole") {
      // What reqwest does with `connect_timeout`, and nothing without it:
      // a blackholed address would otherwise be waited on until our own
      // deadline, or the operating system's, whichever came first.
      if (typeof init?.connectTimeout === "number") settle(init.connectTimeout, () => reject(transportError(url)));
      return;
    }
    if ("resetAfter" in behaviour) return void settle(behaviour.resetAfter, () => reject(transportError(url)));
    settle(behaviour.after, () => resolve(behaviour.reply()));
  });
}

async function run<T>(request: () => Promise<ApiResult<T>>) {
  const startedAt = Date.now();
  let ms: number | null = null;
  const pending = request().then((r) => {
    ms = Date.now() - startedAt;
    return r;
  });
  await vi.runAllTimersAsync();
  return { result: await pending, ms: ms as unknown as number };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  network = {};
  sent = [];
  remembered.length = 0;
  tauriFetch.mockImplementation((url: string, init?: RequestInit & { connectTimeout?: number }) => {
    const { origin, pathname } = new URL(url);
    sent.push({ origin, path: pathname, connectTimeout: init?.connectTimeout });
    return respond(url, network[origin]?.[pathname] ?? "blackhole", init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("a read on a slow network", () => {
  /** The shape that fits the testers' reports: the CDN answering after
   * fifteen seconds, every mirror refused. Before: "could not reach
   * Neoxify" at eight seconds, with the answer still on its way. */
  it("takes an answer that comes after eight seconds", async () => {
    network[A] = { "/customer/routes": answers(15_000, () => json([{ id: "r1" }])) };
    network[B] = { "/customer/routes": "reset" };
    network[C] = { "/customer/routes": "reset" };
    network[D] = { "/customer/routes": "reset" };
    const trace = newTrace();

    const { result, ms } = await run(() => publicRequest<{ id: string }[]>("/customer/routes", undefined, trace));

    expect(result).toEqual({ ok: true, data: [{ id: "r1" }] });
    expect(ms).toBe(15_000);
    expect(renderTrace(trace)).toBe("req: a.example=h200@15000 b.example=net@0 c.example=net@0 d.example=net@0");
  });

  /** Blocked addresses drop out at the connection deadline; the one that
   * connected is still given its full time to answer. */
  it("waits on an address that connected after the blackholed ones have dropped out", async () => {
    network[C] = { "/customer/routes": answers(18_000, () => json([])) };
    const trace = newTrace();

    const { result, ms } = await run(() => publicRequest("/customer/routes", undefined, trace));

    expect(result.ok).toBe(true);
    expect(ms).toBe(18_000);
    expect(renderTrace(trace)).toBe(
      "req: a.example=timeout@10000 b.example=timeout@10000 c.example=h200@18000 d.example=timeout@10000",
    );
  });

  /** Still a deadline: an address that connected and then says nothing
   * is given up on at twenty seconds. */
  it("gives up on an answer that has not come in twenty seconds", async () => {
    network[A] = { "/customer/routes": "stall" };
    network[B] = { "/customer/routes": answers(SLOW_ANSWER_MS + 1, () => json([])) };
    const trace = newTrace();

    const { result, ms } = await run(() => publicRequest("/customer/routes", undefined, trace));

    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(ms).toBe(SLOW_ANSWER_MS);
    expect(renderTrace(trace)).toBe(
      "req: a.example=timeout@20000 b.example=timeout@20000 c.example=timeout@10000 d.example=timeout@10000",
    );
  });
});

describe("a network where nothing connects", () => {
  /** A longer deadline for answers must not make a blocked network
   * slower to report. Without a connection deadline this read would wait
   * twenty seconds, its whole answer deadline, on every address. */
  it("says so for a read at the connection deadline, not the answer deadline", async () => {
    const trace = newTrace();

    const { result, ms } = await run(() => publicRequest("/customer/routes", undefined, trace));

    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(ms).toBe(CONNECT_TIMEOUT_MS);
    // Recorded as timeouts, as a blackhole always has been. The plugin's
    // sentence for them is the same as for a refusal; read as `net`,
    // every blocked address would look refused.
    expect(renderTrace(trace)).toBe(
      "req: a.example=timeout@10000 b.example=timeout@10000 c.example=timeout@10000 d.example=timeout@10000",
    );
  });

  /** A write's health race: the first address's head start, then the
   * connection deadline for the rest. Before: 21.5 seconds. */
  it("says so for a write after its health race, at the connection deadline", async () => {
    const { result, ms } = await run(() => publicRequest("/client-attempts", { method: "POST", body: "{}" }));

    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(ms).toBe(1_500 + CONNECT_TIMEOUT_MS);
    expect(sent.filter((s) => s.path === "/client-attempts")).toEqual([]);
  });

  /** Only a failure at the connection deadline is read as one. A reset
   * on a connection that was up, two seconds later, is still a reset. */
  it("still records a later reset as a transport failure", async () => {
    network[A] = { "/customer/routes": { resetAfter: 12_000 } };
    const trace = newTrace();

    await run(() => publicRequest("/customer/routes", undefined, trace));

    expect(renderTrace(trace)).toMatch(/^req: a\.example=net@12000 /);
  });
});

describe("the connection deadline", () => {
  /** Every request carries it, whichever path sends it: a raced read, a
   * write's health race, and the write itself. */
  it("is passed with every request", async () => {
    network[B] = {
      "/customer/routes": answers(100, () => json([])),
      "/health": answers(100, () => json({ status: "ok" })),
      "/client-attempts": answers(100, () => new Response(null, { status: 204 })),
    };

    await run(() => publicRequest("/customer/routes"));
    resetRaceWinnerForTests();
    await run(() => publicRequest("/client-attempts", { method: "POST", body: "{}" }));

    expect(sent.map((s) => s.path)).toEqual(expect.arrayContaining(["/customer/routes", "/health", "/client-attempts"]));
    expect(sent.every((s) => s.connectTimeout === CONNECT_TIMEOUT_MS)).toBe(true);
  });

  /** Shorter than the answer deadline, or it would never be the one that
   * ends a blackholed address's wait. */
  it("is shorter than the time a race waits for an answer", () => {
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(SLOW_ANSWER_MS);
  });
});

describe("a screen waiting on a read", () => {
  /** A read can now take up to twenty seconds, and a screen waiting on
   * one says it is still trying at eight (still-trying.ts) -- well before
   * the answer it may yet get. */
  it("says it is still trying before the read gives up", async () => {
    const { STILL_TRYING_AFTER_MS } = await import("./still-trying");
    expect(STILL_TRYING_AFTER_MS).toBeLessThan(SLOW_ANSWER_MS);
  });
});
