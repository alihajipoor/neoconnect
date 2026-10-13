import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What becomes of the 401s a token refresh walks past.
 *
 * Under the HTTP plugin a response is parked on the Rust side, with its
 * connection, until its body is read to the end or cancelled. The backend's
 * 401 to an expired access token is JSON, so the plugin's null-body patch
 * does not catch it, and the request that met it went on to refresh the
 * token and retry with the 401 never read: its connection stayed open on
 * whatever adapter it was made on, for the life of the app. Access tokens
 * last fifteen minutes and are refreshed only after a 401, so that was the
 * first signed-in request after any idle -- typically the one the app makes
 * as it opens, before Connect, on the bare line. The refresh had two more:
 * the backend's 401 refusing it, and a JSON 401 from an address shown not to
 * be the backend, replaced by the refresh sent on elsewhere.
 *
 * Driven through the real api.ts against a network stood in for per address
 * and path, with a fake clock. Each body records being cancelled; one read
 * to the end is closed and records nothing. Addresses are stand-ins. */

const A = "https://a.example";
const D = "https://d.example";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([A, D]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", async (importOriginal) => ({
  isKnownBlockPage: (await importOriginal<typeof import("./endpoint-bundle-store")>()).isKnownBlockPage,
  maybeRefreshBundle: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("could not resolve")),
}));
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

const { apiRequest, resetRaceWinnerForTests } = await import("./api");
const { resetDemotionsForTests } = await import("./endpoint-demotion");
const { onSessionRevoked } = await import("./session-revoked");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

/** How many times each labelled body was cancelled. */
let cancelled: Record<string, number>;

/** A JSON answer whose body records, under `label`, every cancel that
 * reaches it. Read to the end it is closed, and a cancel then reaches
 * nothing -- so a count is only ever of a body left unread. */
function json(label: string, body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      cancelled[label] = (cancelled[label] ?? 0) + 1;
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

/** One answer per request to a path at an address, after `after` ms; a
 * list is used up one request at a time, its last entry for every request
 * after. Anything not listed never answers. */
type Behaviour = { after: number; reply: () => Response };
let network: Record<string, Record<string, Behaviour | Behaviour[]>>;
const answers = (after: number, reply: () => Response): Behaviour => ({ after, reply });

function respond(origin: string, path: string, signal?: AbortSignal | null): Promise<Response> {
  const entry = network[origin]?.[path];
  const behaviour = entry === undefined ? undefined : Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Request cancelled"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    if (behaviour === undefined) return;
    setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(behaviour.reply());
    }, behaviour.after);
  });
}

async function run<T>(request: () => Promise<T>): Promise<T> {
  const pending = request();
  await vi.runAllTimersAsync();
  return await pending;
}

const UNAUTHORIZED = { statusCode: 401, message: "Unauthorized" };
const REVOKED = { statusCode: 401, message: "Refresh token has been revoked", error: "Unauthorized" };
const HEALTHY = { status: "ok", timestamp: "2026-10-09T00:00:00.000Z" };
const PAIR = { accessToken: "access2", refreshToken: "refresh2" };

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  resetDemotionsForTests();
  network = {};
  cancelled = {};
  announced = 0;
  stored.tokens = { accessToken: "access", refreshToken: "refresh" };
  tauriFetch.mockImplementation((url: string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url);
    return respond(origin, pathname, init?.signal);
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("the backend's 401 to an expired access token", () => {
  it("is let go of once the session is renewed and the request retried", async () => {
    network[A] = {
      "/customer/me": [answers(50, () => json("first 401", UNAUTHORIZED, 401)), answers(50, () => json("retry", { id: "c1" }))],
      "/customer-auth/refresh": answers(50, () => json("refresh", PAIR)),
      "/health": answers(50, () => json("health", HEALTHY)),
    };

    const result = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(stored.tokens).toEqual(PAIR);
    expect(announced).toBe(0);
    expect(cancelled).toEqual({ "first 401": 1 });
  });

  it("is let go of when the refresh could not be completed, which still ends nothing", async () => {
    network[A] = {
      "/customer/me": answers(50, () => json("first 401", UNAUTHORIZED, 401)),
      "/customer-auth/refresh": answers(50, () => json("refresh 503", { statusCode: 503, message: "busy" }, 503)),
    };

    const result = await run(() => apiRequest("/customer/me"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionExpired).toBeFalsy();
    expect(stored.tokens).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(announced).toBe(0);
    expect(cancelled["first 401"]).toBe(1);
  });
});

describe("the backend refusing the refresh", () => {
  /** The sign-out is exactly what it was; only the two 401s are let go of. */
  it("lets go of its 401 and the request's, and still ends the session", async () => {
    network[A] = {
      "/customer/me": answers(50, () => json("first 401", UNAUTHORIZED, 401)),
      "/customer-auth/refresh": answers(50, () => json("refused", REVOKED, 401)),
      "/health": answers(50, () => json("health", HEALTHY)),
    };

    const result = await run(() => apiRequest("/customer/me"));

    expect(!result.ok && result.sessionExpired).toBe(true);
    expect(stored.tokens).toBeNull();
    expect(announced).toBe(1);
    expect(cancelled).toEqual({ "first 401": 1, refused: 1 });
  });
});

describe("a JSON 401 to the refresh from an address that is not the backend", () => {
  /** A answers 401 to everything, the public health check included; D is
   * the backend. The refresh goes on to D, and A's refusal is let go of. */
  it("is let go of when the refresh is sent on, and the session is renewed there", async () => {
    network[A] = {
      "/customer/me": answers(10, () => json("A's 401 to the request", UNAUTHORIZED, 401)),
      "/customer-auth/refresh": answers(10, () => json("A's 401 to the refresh", UNAUTHORIZED, 401)),
      "/health": answers(10, () => json("A's 401 to the health check", UNAUTHORIZED, 401)),
    };
    network[D] = {
      "/customer/me": answers(300, () => json("D's answer", { id: "c1" })),
      "/customer-auth/refresh": answers(300, () => json("D's pair", PAIR)),
      "/health": answers(300, () => json("D's health", HEALTHY)),
    };

    const result = await run(() => apiRequest("/customer/me"));

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(stored.tokens).toEqual(PAIR);
    expect(announced).toBe(0);
    expect(cancelled["A's 401 to the request"]).toBe(1);
    expect(cancelled["A's 401 to the refresh"]).toBe(1);
  });
});
