import { beforeEach, describe, expect, it, vi } from "vitest";

/** What an authenticated request hands back when the server says no.
 *
 * Every failure used to be reduced to its message. That was enough while
 * the only refusal anyone acted on was a 401, and it stopped being enough
 * with device slots: a 409 `DEVICE_LIMIT` carries who is using the plan's
 * devices, and the screen has to tell it apart from a network failure
 * (dial anyway) and from a sign-out (it is not one). See
 * docs/device-slots.md, "Client obligations" 4.
 */

const ENDPOINTS = ["https://a.example", "https://b.example", "https://c.example"];

type Reply = { status: number; body?: unknown } | "hang" | "unreachable";
const replies: Record<string, Reply[]> = {};
const seen: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    // The health race a write runs first (`sendWrite` in api.ts):
    // answered everywhere unless a test says otherwise, and not counted in
    // `seen`, which is about where the request itself went.
    if (path === "/health" && !replies[path]?.length) {
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    if (path !== "/health") seen.push(url);
    const reply = replies[path]?.shift();
    if (reply === undefined || reply === "unreachable") return Promise.reject(new TypeError("network error"));
    if (reply === "hang") {
      // A blackholed address: never answers, only gives up when aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
}));

let stored: { accessToken: string; refreshToken: string } | null = null;
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve(stored),
  setTokens: (t: { accessToken: string; refreshToken: string }) => {
    stored = t;
    return Promise.resolve();
  },
  clearTokens: () => {
    stored = null;
    return Promise.resolve();
  },
}));

const { apiRequest, resetRaceWinnerForTests, STOPPED_ANSWERING } = await import("./api");
const { onSessionRevoked } = await import("./session-revoked");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

beforeEach(() => {
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
  seen.length = 0;
  stored = { accessToken: "access", refreshToken: "refresh" };
  announced = 0;
});

const DEVICE_LIMIT = {
  statusCode: 409,
  code: "DEVICE_LIMIT",
  message: "Your plan allows 1 device at a time.",
  limit: 1,
  holders: [
    {
      handle: "Zm9vYmFyYmF6",
      label: "Windows PC",
      platform: "windows",
      since: "2026-10-06T10:32:04.120Z",
      lastSeen: "2026-10-06T10:55:41.004Z",
    },
  ],
};

describe("a refusal keeps what it said", () => {
  it("keeps the status, the code and the body of a 409", async () => {
    replies["/customer/vpn/claim"] = [{ status: 409, body: DEVICE_LIMIT }];

    const result = await apiRequest("/customer/vpn/claim", { method: "POST", body: "{}" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("DEVICE_LIMIT");
    expect(result.error).toBe("Your plan allows 1 device at a time.");
    expect(result.body).toEqual(DEVICE_LIMIT);
  });

  /** The apps end the session on 401. A device-limit refusal must never
   * be read that way: it would sign somebody out, and take their tunnel
   * down, for pressing Connect on a second device. */
  it("does not treat a 409 as a sign-out", async () => {
    replies["/customer/vpn/claim"] = [{ status: 409, body: DEVICE_LIMIT }];

    const result = await apiRequest("/customer/vpn/claim", { method: "POST", body: "{}" });

    expect(!result.ok && result.sessionExpired).toBeFalsy();
    expect(stored).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(announced).toBe(0);
    // Asked once. A refusal is an answer, not a reason to try a mirror.
    expect(seen).toHaveLength(1);
  });

  it("keeps the status of a refusal that carries no code", async () => {
    replies["/customer/subscriptions"] = [{ status: 503 }];

    const result = await apiRequest("/customer/subscriptions");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe("Request failed (503)");
  });

  it("reports a request that never arrived without a status", async () => {
    replies["/health"] = ["unreachable", "unreachable", "unreachable"];
    replies["/customer/vpn/claim"] = ["unreachable", "unreachable", "unreachable"];

    const result = await apiRequest("/customer/vpn/claim", { method: "POST", body: "{}" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBeUndefined();
    expect(result.noResponse).toBe(true);
    expect(result.error).toMatch(/^Could not reach Neoxify/);
    // Nothing answered the health race, so the write was never sent.
    expect(seen).toEqual([]);
  });

  /** Neoxify answered the health race, so it was reached: the write
   * that then got no answer is not "could not reach Neoxify". Still no
   * status, and still `noResponse`: this request was not answered. */
  it("says Neoxify stopped responding when it answered moments before", async () => {
    replies["/customer/vpn/claim"] = ["unreachable", "unreachable", "unreachable"];

    const result = await apiRequest("/customer/vpn/claim", { method: "POST", body: "{}" });

    expect(result).toEqual({ ok: false, error: STOPPED_ANSWERING, noResponse: true });
    // Every address answered the health check, and each was then sent the
    // write once.
    expect(seen).toEqual([
      "https://a.example/customer/vpn/claim",
      "https://b.example/customer/vpn/claim",
      "https://c.example/customer/vpn/claim",
    ]);
  });
});

describe("a caller's own deadline", () => {
  /** The release on Disconnect has a second and a half, not eight
   * seconds per mirror. A write walks the mirrors one at a time, so
   * without the caller's signal a blackholed first address alone would
   * hold it for eight seconds and then go on to the next. */
  it("stops a write walking the endpoints once the caller gives up", async () => {
    replies["/customer/vpn/release"] = ["hang", "hang", "hang"];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const started = Date.now();
    const result = await apiRequest("/customer/vpn/release", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The first address only: once the caller has given up, no further
    // mirror is dialled on its behalf.
    expect(seen).toEqual(["https://a.example/customer/vpn/release"]);
  });

  it("stops a raced read on every endpoint at once", async () => {
    replies["/customer/subscriptions"] = ["hang", "hang", "hang"];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const started = Date.now();
    const result = await apiRequest("/customer/subscriptions", { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not send anything for a caller that had already given up", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await apiRequest("/customer/vpn/release", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
