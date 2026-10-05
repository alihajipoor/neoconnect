import { beforeEach, describe, expect, it, vi } from "vitest";

/** When a refused or failed token refresh ends the session.
 *
 * Two halves, and they pull in opposite directions.
 *
 * A refresh the server refuses has to end the session everywhere, not
 * just for the one request that hit it. Most callers dropped the
 * `sessionExpired` flag, so the app was signed out on disk and signed in
 * on screen with the tunnel up until the next restart.
 *
 * And a refresh that merely failed to complete must end nothing. It used
 * to clear the tokens on any failure at all -- an unreachable endpoint,
 * a 5xx, a throttle -- and now that ending a session takes the tunnel
 * down, that would disconnect somebody in Iran because one request was
 * dropped.
 */

type Reply = { status: number; body?: unknown } | "unreachable";
const replies: Record<string, Reply[]> = {};
const requested: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = url.replace("https://a.example", "");
    requested.push(path);
    const reply = replies[path]?.shift();
    if (reply === undefined || reply === "unreachable") return Promise.reject(new Error(`no route to ${url}`));
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(["https://a.example"]),
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

const { apiRequest } = await import("./api");
const { onSessionRevoked } = await import("./session-revoked");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

beforeEach(() => {
  for (const key of Object.keys(replies)) delete replies[key];
  requested.length = 0;
  stored = { accessToken: "old-access", refreshToken: "refresh" };
  announced = 0;
});

describe("a refresh the server refuses", () => {
  it("ends the session and tells the whole app", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: { message: "Refresh token has been revoked" } }];

    const result = await apiRequest("/customer/me");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionExpired).toBe(true);
    expect(stored).toBeNull();
    expect(announced).toBe(1);
  });
});

describe("a refresh that did not complete", () => {
  it.each<[string, Reply]>([
    ["unreachable", "unreachable"],
    ["a server error", { status: 503 }],
    ["the throttle", { status: 429 }],
    ["a CDN's bot check", { status: 403 }],
  ])("ends nothing when the refresh met %s", async (_label, reply) => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [reply];

    const result = await apiRequest("/customer/me");

    expect(result.ok).toBe(false);
    // Not reported as expired, so no screen drops to sign-in over it...
    expect(!result.ok && result.sessionExpired).toBeFalsy();
    // ...the tokens survive for the next attempt...
    expect(stored).toEqual({ accessToken: "old-access", refreshToken: "refresh" });
    // ...and nobody is told the session ended, which is what would take
    // the tunnel down.
    expect(announced).toBe(0);
  });
});

describe("a request from a session that has already ended", () => {
  it("is not announced as the session ending", async () => {
    // A request made just before sign-out, answered just after. There
    // is nothing left to refresh, and "your session ended" over the
    // sign-in screen somebody reached by signing out would be wrong.
    replies["/customer/me"] = [{ status: 401 }];
    const finishing = apiRequest("/customer/me");
    stored = null;
    const result = await finishing;
    expect(result.ok).toBe(false);
    expect(announced).toBe(0);
  });
});

describe("a refresh that works", () => {
  it("retries with the new token and ends nothing", async () => {
    replies["/customer/me"] = [{ status: 401 }, { status: 200, body: { id: "c1" } }];
    replies["/customer-auth/refresh"] = [{ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } }];

    const result = await apiRequest<{ id: string }>("/customer/me");

    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(stored).toEqual({ accessToken: "new-access", refreshToken: "r2" });
    expect(announced).toBe(0);
  });
});
