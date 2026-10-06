import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GamingProfileResponse } from "./customer";

/** The bug this file exists for.
 *
 * The gaming profile is held in module memory for 30 seconds.
 * `clearGamingProfileCache()` was written for "a different customer
 * signing in" and then called from nowhere, so signing out and signing
 * in as somebody else inside that window showed the second customer the
 * first one's entitlement, resolver region and proxy address.
 *
 * The ETag cannot cause this: it mixes in the customer id, so a stale
 * validator can only ever miss. Everything below is therefore about the
 * *body already in memory*, which no validator is consulted for -- which
 * is why the assertions are about what crosses the wire and what comes
 * back, never about the tag.
 */

type Reply = { kind: "unreachable" } | { kind: "respond"; status: number; body?: unknown; etag?: string };

const replies: Reply[] = [];
const calls: { url: string; headers: Record<string, string> }[] = [];
/** Resolvers for requests deliberately left open, so a sign-out can be
 * driven while one is genuinely in flight. */
let pending: (() => void)[] = [];

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

/** Set by a test that wants the next request held open rather than
 * answered immediately. */
let holdNext = false;

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const reply = replies.shift();
    const settle = () => {
      if (reply === undefined || reply.kind === "unreachable") {
        return Promise.reject(new Error(`no route to ${url}`));
      }
      return Promise.resolve(makeResponse(reply));
    };
    if (!holdNext) return settle();
    holdNext = false;
    return new Promise<Response>((resolve, reject) => {
      pending.push(() => void settle().then(resolve, reject));
    });
  },
}));

const BASE = "https://connect.neoxify.site/api";
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([BASE]),
  rememberEndpoint: () => Promise.resolve(),
}));

const cleared = { tokens: 0, snapshot: 0 };
/** Everything the session end did, in the order it did it. */
const order: string[] = [];
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => {
    cleared.tokens += 1;
    order.push("clearTokens");
    return Promise.resolve();
  },
}));
vi.mock("./credential-cache", () => ({
  clearSnapshot: () => {
    cleared.snapshot += 1;
    order.push("clearSnapshot");
    return Promise.resolve();
  },
}));

// After the mocks: the cache under test is module-level state created at
// import time, so importing earlier would bind the real transport.
const { getGamingProfile, clearGamingProfileCache } = await import("./customer");
const { endCustomerSession, sessionGeneration, setTunnelTeardown } = await import("./session-end");

/** What the platform's teardown will answer, set per test. */
let teardownAnswer: () => Promise<"down" | "unconfirmed"> = () => Promise.resolve("down");
setTunnelTeardown(() => {
  order.push("teardown");
  return teardownAnswer();
});

const TAG = 'W/"gaming-abcdefghijklmnopqrstuvwxy12"';

function profileFor(region: string, entitled = true): GamingProfileResponse {
  return {
    version: 1,
    entitled,
    unavailableReason: entitled ? null : "notEntitled",
    resolver: entitled
      ? { dohUrl: `https://${region}.example/dns-query`, proxyIp: "203.0.113.7", proxyPort: 443, nodeRegion: region }
      : null,
    games: [],
  };
}

/** Customer A: entitled, resolver in Finland. Customer B: not entitled
 * at all. Chosen so a leak is unmistakable rather than a field that
 * happens to match. */
const A = profileFor("fi");
const B = profileFor("de", false);

beforeEach(() => {
  replies.length = 0;
  calls.length = 0;
  pending = [];
  holdNext = false;
  cleared.tokens = 0;
  cleared.snapshot = 0;
  order.length = 0;
  teardownAnswer = () => Promise.resolve("down");
  clearGamingProfileCache();
});

afterEach(() => {
  replies.length = 0;
});

describe("ending a session forgets the customer it belonged to", () => {
  it("serves the cached body to the same customer inside the TTL", () => {
    // The control. Without this the tests below would pass against a
    // cache that never worked in the first place.
    replies.push({ kind: "respond", status: 200, body: A, etag: TAG });
    return getGamingProfile()
      .then(() => getGamingProfile())
      .then((second) => {
        expect(second.ok && second.data.resolver?.nodeRegion).toBe("fi");
        expect(calls).toHaveLength(1);
      });
  });

  it("does not serve one customer's entitlement to the next", async () => {
    replies.push({ kind: "respond", status: 200, body: A, etag: TAG });
    const first = await getGamingProfile();
    expect(first.ok && first.data.entitled).toBe(true);

    // Sign out. This is the call that did not exist.
    await endCustomerSession();

    // Customer B signs in well inside A's 30 s TTL.
    replies.push({ kind: "respond", status: 200, body: B, etag: TAG });
    const second = await getGamingProfile();

    expect(second.ok && second.data.entitled).toBe(false);
    expect(second.ok && second.data.resolver).toBeNull();
    // Two requests, not one: the second customer's screen asked the
    // server rather than reading A's body out of memory.
    expect(calls).toHaveLength(2);
  });

  it("sends no If-None-Match after a sign-out", async () => {
    replies.push({ kind: "respond", status: 200, body: A, etag: TAG });
    await getGamingProfile();
    await endCustomerSession();

    replies.push({ kind: "respond", status: 200, body: B, etag: TAG });
    await getGamingProfile();

    // The tag was minted over A's entitlement and A's customer id.
    // Offering it on B's behalf asks the server a question about
    // somebody else, and a server that answered 304 to it would hand
    // back a body B must never see.
    //
    // Asserted before the header check, because without it this test
    // passes for the wrong reason: a cache that was never cleared serves
    // B from memory, no second request exists, and "no If-None-Match was
    // sent" is vacuously true of a request that never happened.
    expect(calls).toHaveLength(2);
    const headers = calls[1]?.headers ?? {};
    const offered = Object.entries(headers).find(([k]) => k.toLowerCase() === "if-none-match");
    expect(offered).toBeUndefined();
  });

  it("does not hand the next customer the previous customer's open request", async () => {
    // The hole that nulling the cache alone does not close.
    // `getGamingProfile` shares one promise between every caller while a
    // request is open, so a sign-out that leaves it in place means B's
    // first read awaits A's request and renders A's answer -- without
    // ever consulting the cache.
    holdNext = true;
    replies.push({ kind: "respond", status: 200, body: A, etag: TAG });
    const aRequest = getGamingProfile();

    await endCustomerSession();

    replies.push({ kind: "respond", status: 200, body: B, etag: TAG });
    const bRequest = getGamingProfile();

    // Let A's request land, after B has already asked.
    pending.forEach((release) => release());
    pending = [];

    const b = await bRequest;
    expect(b.ok && b.data.entitled).toBe(false);
    expect(b.ok && b.data.resolver?.nodeRegion).toBeUndefined();

    // A's caller still gets its own answer; it simply stops being
    // anybody else's.
    const a = await aRequest;
    expect(a.ok && a.data.entitled).toBe(true);
  });

  it("does not let a request that was already on the wire refill the cache", async () => {
    // Same race, the other way round: A's response arrives after the
    // sign-out and with nobody else waiting. It must not become the
    // entry B reads a moment later.
    holdNext = true;
    replies.push({ kind: "respond", status: 200, body: A, etag: TAG });
    const aRequest = getGamingProfile();

    await endCustomerSession();

    pending.forEach((release) => release());
    pending = [];
    await aRequest;

    // B signs in. If A's late 200 was written to the cache, this is
    // served from memory and never reaches the transport.
    replies.push({ kind: "respond", status: 200, body: B, etag: TAG });
    const b = await getGamingProfile();

    expect(b.ok && b.data.entitled).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("clears the credential snapshot and the tokens as well", async () => {
    // `clearSnapshot` documents itself as "called on sign-out" and was
    // reached from exactly one of the three ways a session can end.
    await endCustomerSession();
    expect(cleared.snapshot).toBe(1);
    expect(cleared.tokens).toBe(1);
  });

  it("is idempotent, so a path that already cleared can call it again", async () => {
    await endCustomerSession();
    await endCustomerSession();
    expect(cleared.snapshot).toBe(2);

    replies.push({ kind: "respond", status: 200, body: B, etag: TAG });
    const after = await getGamingProfile();
    expect(after.ok && after.data.entitled).toBe(false);
  });
});

/** The bug this half exists for: an Android tester signed out and the
 * VPN stayed up, carrying traffic. The same was true on Windows, where
 * nothing on any of the three exits touched the tunnel at all. */
describe("ending a session ends the tunnel", () => {
  it("takes the tunnel down before it deletes the credentials", async () => {
    await endCustomerSession();
    // Teardown first. A session whose tokens are gone while its tunnel
    // is still up is the state that was reported.
    expect(order).toEqual(["teardown", "clearTokens", "clearSnapshot"]);
  });

  it("reports a teardown it could not confirm instead of hiding it", async () => {
    teardownAnswer = () => Promise.resolve("unconfirmed");
    const ended = await endCustomerSession();
    expect(ended.tunnel).toBe("unconfirmed");
    // And still signs out: keeping the credentials would not make the
    // tunnel any less up, and the customer asked to leave.
    expect(cleared.tokens).toBe(1);
    expect(cleared.snapshot).toBe(1);
  });

  it("treats a teardown that threw as unconfirmed, never as down", async () => {
    teardownAnswer = () => Promise.reject(new Error("vpn_disconnect did not answer in time"));
    const ended = await endCustomerSession();
    expect(ended.tunnel).toBe("unconfirmed");
    expect(cleared.tokens).toBe(1);
  });

  it("says down only when the platform did", async () => {
    const ended = await endCustomerSession();
    expect(ended.tunnel).toBe("down");
  });

  it("marks the session over before the teardown starts", async () => {
    // A connect ladder still running checks this after each engine it
    // brings up. If it only moved once the teardown had finished, a
    // ladder that finished its connect during the teardown would see its
    // session as live, keep the tunnel, and nothing would ever take it
    // down again.
    const before = sessionGeneration();
    let seenDuringTeardown = -1;
    teardownAnswer = () => {
      seenDuringTeardown = sessionGeneration();
      return Promise.resolve("down");
    };
    await endCustomerSession();
    expect(seenDuringTeardown).toBe(before + 1);
  });
});

describe("ending a session forgets this device's slot", () => {
  /** Sign-out releases the slot on the server by itself
   * (docs/device-slots.md, obligation 8), so nothing is sent -- but a
   * renewal still owed to the old session must not run, or claim, under
   * the next one. */
  it("forgets the slot without a request of its own", async () => {
    const { deviceSlot } = await import("./device-slot-session");
    deviceSlot.adopt({ subscriptionId: "6f1c2b9e-0000-4000-8000-000000000001" });
    expect(deviceSlot.standing()).toBe("unclaimed");

    await endCustomerSession();

    expect(deviceSlot.standing()).toBe("none");
    expect(calls.filter((c) => c.url.includes("/customer/vpn/"))).toEqual([]);
  });

  /** The card names the old account's devices. */
  it("clears the device limit's card", async () => {
    const { slotNoticeStore } = await import("./device-slot-session");
    slotNoticeStore.set({ kind: "displaced", by: { handle: "h", label: "Windows PC", platform: "windows" }, at: null });

    await endCustomerSession();

    expect(slotNoticeStore.current()).toBeNull();
  });

  /** The sign-out's own teardown takes the tunnel down; retries of the
   * old session's must not run on into the next account's. */
  it("forgets a teardown the device limit still owed", async () => {
    const { slotTeardown } = await import("./device-slot-session");
    await slotTeardown.begin(() => Promise.resolve(false));
    expect(slotTeardown.owed()).toBe(true);

    await endCustomerSession();

    expect(slotTeardown.owed()).toBe(false);
  });
});
