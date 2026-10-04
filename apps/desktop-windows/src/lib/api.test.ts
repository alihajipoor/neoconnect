import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Tests for the endpoint selection in `api.ts`.
 *
 * This file exists because there was no test here at all, and two
 * defects shipped in 0.9.39 as a direct result. Both were in the same
 * dozen lines, both broke sign-in, and both are trivially expressible as
 * a test once somebody writes one.
 */

const ENDPOINTS = ["https://a.example", "https://b.example", "https://c.example"];

/** The client uses Tauri's fetch, not the global one. */
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
}));

let publicRequest: typeof import("./api").publicRequest;

beforeEach(async () => {
  vi.resetModules();
  ({ publicRequest } = await import("./api"));
});

afterEach(() => {
  tauriFetch.mockReset();
});

/** A Response whose body can only be read if nobody cancelled it. */
function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("reading the winner's body", () => {
  /** The 0.9.39 hang, in one test.
   *
   * `finally` ran before `return response` handed the value to the
   * caller, so every controller was aborted -- the winner's included --
   * while its body was still unread. `Promise.any` settles on headers,
   * not on the body, so the caller's `res.json()` waited for ever on a
   * cancelled stream and the sign-in button span.
   *
   * Asserting on the parsed body rather than on the Response is the
   * whole point: a test that only checked `res.ok` would have passed
   * against the broken version.
   */
  it("hands back a body the caller can still read", async () => {
    // The body must *stream*, or this test cannot see the bug. A
    // `Response` built from a string already holds its body, so aborting
    // afterwards costs nothing and the broken code passes. A real fetch
    // resolves when the headers arrive and delivers the body after,
    // which is the window the abort landed in.
    tauriFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            if (signal?.aborted) {
              controller.error(new DOMException("aborted", "AbortError"));
              return;
            }
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: "ok" })));
            controller.close();
          }, 0);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await publicRequest<{ token: string }>("/login");
    expect(result).toEqual({ ok: true, data: { token: "ok" } });
  });
});

describe("which endpoints a request is sent to", () => {
  /** A read may go to every mirror: that is the anti-filtering feature.
   *
   * The slowest address costs nothing because nobody waits for it, which
   * is what stopped one blocked endpoint failing a config refresh.
   */
  it("races a read across every endpoint", async () => {
    const seen: string[] = [];
    tauriFetch.mockImplementation(async (url: string) => {
      seen.push(new URL(url).origin);
      return jsonResponse({ ok: true });
    });

    await publicRequest("/config");
    expect(seen.sort()).toEqual([...ENDPOINTS].sort());
  });

  /** The second 0.9.39 defect, and the one that would have kept sign-in
   * broken even after the abort was fixed.
   *
   * A race sends the request to every mirror, so one click became one
   * login attempt per endpoint. The proof-of-work challenge is
   * single-use: the first to arrive spends it and the server refuses the
   * rest with 400 before doing any password hashing -- so the refusals
   * come back faster than the real answer and win the race. The endpoint
   * is also throttled at five a minute, which a single click already
   * exceeds.
   */
  it("sends a write to one endpoint, not to all of them", async () => {
    const seen: string[] = [];
    tauriFetch.mockImplementation(async (url: string) => {
      seen.push(new URL(url).origin);
      return jsonResponse({ token: "ok" });
    });

    await publicRequest("/login", { method: "POST", body: "{}" });
    expect(seen).toHaveLength(1);
    expect(ENDPOINTS).toContain(seen[0]);
  });

  /** Failover still works for a write -- it is sequential, not absent.
   *
   * Withdrawing the race must not withdraw the endpoint list. A blocked
   * address still has to step to the next one, or this fix would trade a
   * broken sign-in for an unreachable one on exactly the networks the
   * mirrors exist for.
   */
  it("steps to the next endpoint when a write cannot reach the first", async () => {
    const seen: string[] = [];
    tauriFetch.mockImplementation(async (url: string) => {
      const origin = new URL(url).origin;
      seen.push(origin);
      if (origin === ENDPOINTS[0]) throw new TypeError("network error");
      return jsonResponse({ token: "ok" });
    });

    const result = await publicRequest<{ token: string }>("/login", {
      method: "POST",
      body: "{}",
    });
    expect(result).toEqual({ ok: true, data: { token: "ok" } });
    expect(seen).toEqual([ENDPOINTS[0], ENDPOINTS[1]]);
  });

  /** A refusal is an answer, and must not send us hunting for a mirror
   * that says something nicer. A wrong password is a wrong password at
   * every address.
   */
  it("does not try another endpoint when the server refuses a write", async () => {
    const seen: string[] = [];
    tauriFetch.mockImplementation(async (url: string) => {
      seen.push(new URL(url).origin);
      return jsonResponse({ message: "wrong password" }, { status: 401 });
    });

    await publicRequest("/login", { method: "POST", body: "{}" });
    expect(seen).toHaveLength(1);
  });
});
