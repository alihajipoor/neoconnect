import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GamingProfileResponse } from "./customer";

/** What the next request should be answered with. Queued rather than
 * keyed by URL because every test here drives the same path and what
 * matters is the *sequence*: a body, then a 304, then whatever comes
 * after it. */
type Reply =
  | { kind: "unreachable" }
  | { kind: "respond"; status: number; body?: unknown; etag?: string };

const replies: Reply[] = [];
/** Every request that actually reached the transport, with the headers
 * it carried. The point of this file is what is on the wire and how
 * often, so both halves are recorded. */
const calls: { url: string; headers: Record<string, string> }[] = [];

/** A response shaped like the one `@tauri-apps/plugin-http` returns, to
 * the extent `api.ts` touches it: `ok`, `status`, `json`, `headers.get`.
 *
 * `headers.get` is case-insensitive, because the real `Headers.get` is
 * and `api.ts` asks for `"ETag"` while servers send `etag`. A mock that
 * matched case exactly would let a real casing bug through. */
function makeResponse(reply: Extract<Reply, { kind: "respond" }>): Response {
  const headers = new Map<string, string>();
  if (reply.etag !== undefined) headers.set("etag", reply.etag);
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: () =>
      reply.body === undefined
        ? Promise.reject(new SyntaxError("Unexpected end of JSON input"))
        : Promise.resolve(reply.body),
  } as unknown as Response;
}

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const reply = replies.shift();
    if (reply === undefined || reply.kind === "unreachable") {
      // What a filtered address looks like from here: no response at
      // all, which is the case `fetchAnyEndpoint` rotates on and then
      // throws for.
      return Promise.reject(new Error(`no route to ${url}`));
    }
    return Promise.resolve(makeResponse(reply));
  },
}));

const BASE = "https://connect.neoxify.site/api";
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([BASE]),
  rememberEndpoint: () => Promise.resolve(),
}));

vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => Promise.resolve(),
}));

// After the mocks: the cache under test is module-level state created at
// import time, so importing earlier would bind the real transport.
const { getGamingProfile, clearGamingProfileCache } = await import("./customer");

/** The exact shape the server mints: weak, `gaming-` prefixed, 27
 * characters of base64url. Reproduced literally because the server
 * compares the whole `If-None-Match` header with `===` -- stripping the
 * `W/`, dropping the quotes or sending a list all still "work", by
 * silently never matching. */
const TAG = 'W/"gaming-abcdefghijklmnopqrstuvwxy12"';
const NEXT_TAG = 'W/"gaming-zyxwvutsrqponmlkjihgfed98"';

const PROFILE: GamingProfileResponse = {
  version: 1,
  entitled: true,
  unavailableReason: null,
  resolver: { dohUrl: "https://doh.example/dns-query", proxyIp: "203.0.113.7", proxyPort: 443, nodeRegion: "fi" },
  games: [
    {
      slug: "wow",
      displayName: "World of Warcraft",
      iconKey: null,
      publisher: "Blizzard",
      hostnames: ["eu.actual.battle.net"],
      excludeHostnames: [],
      canaryHostname: null,
      processNames: ["Wow.exe"],
    },
  ],
};

/** A different answer, so "the cached body came back" cannot be
 * confused with "the second response came back". */
const CHANGED: GamingProfileResponse = { ...PROFILE, entitled: false, unavailableReason: "notEntitled" };

const START = new Date("2026-08-26T10:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  replies.length = 0;
  calls.length = 0;
  // Module-level state survives between tests in a file; each test needs
  // to start cold.
  clearGamingProfileCache();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock past the 30 s freshness window without firing the
 * per-endpoint abort timer, which is cleared as soon as a response
 * lands anyway. */
function expireTtl(): void {
  vi.setSystemTime(Date.now() + 30_001);
}

describe("gaming profile revalidation", () => {
  it("downloads the catalogue and keeps the validator that stands for it", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });

    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/customer/gaming-profile`);
    // Nothing to revalidate against yet, so nothing conditional is sent.
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
  });

  it("offers the tag back byte for byte once the window has passed", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "respond", status: 304, etag: TAG });

    // The load-bearing assertion of this whole file: a 304 is a cache
    // hit, not "Request failed (304)".
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["If-None-Match"]).toBe(TAG);
  });

  it("restarts the window on a 304, so the catalogue is not asked for again", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "respond", status: 304, etag: TAG });
    await getGamingProfile();
    expect(calls).toHaveLength(2);

    // 29 s after the revalidation. If the 304 had left the timestamp
    // where it was, this would be a third request -- and every one after
    // it too, which is the freshness window quietly switched off.
    vi.setSystemTime(Date.now() + 29_000);
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(2);
  });

  it("takes a changed catalogue and the new tag it arrives with", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: NEXT_TAG });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: CHANGED });

    expireTtl();
    replies.push({ kind: "respond", status: 304, etag: NEXT_TAG });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: CHANGED });
    expect(calls[2].headers["If-None-Match"]).toBe(NEXT_TAG);
  });

  it("serves a 304 from memory without a second request", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();
    expireTtl();
    replies.push({ kind: "respond", status: 304, etag: TAG });
    // Two requests total, and the second carried no body -- the whole
    // catalogue came out of memory. If the 304 handling fell back to
    // re-fetching there would be a third request; the body assertion is
    // here too so a 304 that merely *failed* cannot pass this.
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(2);
  });

  it("still reports a network that cannot be reached", async () => {
    replies.push({ kind: "unreachable" });
    await expect(getGamingProfile()).resolves.toEqual({
      ok: false,
      error: "Could not reach Neoxify. Check your internet connection.",
    });
  });

  it("still reports a transport failure on the revalidating request too", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "unreachable" });
    // Holding a cached body is not a licence to pretend the server
    // answered. The customer is told the truth, and the stale body is
    // not passed off as confirmed.
    await expect(getGamingProfile()).resolves.toEqual({
      ok: false,
      error: "Could not reach Neoxify. Check your internet connection.",
    });
  });

  it("still reports a server error", async () => {
    replies.push({ kind: "respond", status: 500, body: { message: "gaming catalogue is unavailable" } });
    await expect(getGamingProfile()).resolves.toEqual({
      ok: false,
      error: "gaming catalogue is unavailable",
    });
  });

  it("still reports a server error on the revalidating request too", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "respond", status: 500 });
    const result = await getGamingProfile();
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: "Request failed (500)" });
  });

  it("refuses a 304 that answers a request which asked nothing conditional", async () => {
    // A broken intermediary, not a cache hit: nothing was offered for
    // validation, so there is no body this 304 stands for. Reading it as
    // success would mean returning content nobody has.
    replies.push({ kind: "respond", status: 304, etag: TAG });
    const result = await getGamingProfile();
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: "Request failed (304)" });
  });

  it("does not carry a validator across a cleared cache", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    // A different customer signing in. The tag mixes in the customer id,
    // so offering it back would be asking about somebody else.
    clearGamingProfileCache();
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: NEXT_TAG });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: CHANGED });
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["If-None-Match"]).toBeUndefined();
  });

  it("keeps two components mounting in the same tick to one request", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    const [a, b] = await Promise.all([getGamingProfile(), getGamingProfile()]);
    expect(a).toEqual({ ok: true, data: PROFILE });
    expect(b).toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(1);
  });

  it("de-duplicates the revalidating request as well", async () => {
    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await getGamingProfile();

    expireTtl();
    replies.push({ kind: "respond", status: 304, etag: TAG });
    const [a, b] = await Promise.all([getGamingProfile(), getGamingProfile()]);
    expect(a).toEqual({ ok: true, data: PROFILE });
    expect(b).toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(2);
  });

  it("does not cache a failure, so retrying actually retries", async () => {
    replies.push({ kind: "unreachable" });
    await getGamingProfile();

    replies.push({ kind: "respond", status: 200, body: PROFILE, etag: TAG });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });
    expect(calls).toHaveLength(2);
  });

  it("tolerates a server that sends no ETag at all", async () => {
    // Then there is simply nothing to revalidate with, and the next
    // request past the window is an ordinary unconditional fetch.
    replies.push({ kind: "respond", status: 200, body: PROFILE });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: PROFILE });

    expireTtl();
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: TAG });
    await expect(getGamingProfile()).resolves.toEqual({ ok: true, data: CHANGED });
    expect(calls[1].headers["If-None-Match"]).toBeUndefined();
  });
});
