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

/** An answer, JSON unless `page` gives the HTML of something in front of
 * the backend instead, and sent only once `after` has settled when it is
 * given. */
type Reply = { status: number; body?: unknown; page?: string; after?: Promise<unknown> } | "unreachable";
const replies: Record<string, Reply[]> = {};
const requested: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = url.replace("https://a.example", "");
    requested.push(path);
    const reply = replies[path]?.shift();
    if (reply === undefined || reply === "unreachable") return Promise.reject(new Error(`no route to ${url}`));
    const after = reply.after ?? Promise.resolve();
    if (reply.page !== undefined) {
      const page = reply.page;
      return after.then(() => new Response(page, { status: reply.status, headers: { "content-type": "text/html" } }));
    }
    return after.then(
      () =>
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

const { apiRequest, resetRaceWinnerForTests } = await import("./api");
const { newTrace, renderTrace } = await import("./endpoint-trace");
const { onSessionRevoked } = await import("./session-revoked");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

beforeEach(() => {
  // Forgets which addresses the backend has answered from, which decides
  // whether a refused refresh is believed.
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
  requested.length = 0;
  stored = { accessToken: "old-access", refreshToken: "refresh" };
  announced = 0;
});

const REVOKED = { statusCode: 401, message: "Refresh token has been revoked", error: "Unauthorized" };
const HEALTHY = { status: "ok", timestamp: "2026-10-09T00:00:00.000Z" };

describe("a refresh the server refuses", () => {
  /** The app starts with an expired access token and a revoked session:
   * the only answers so far are 401s, so the address is asked for the
   * health check before its refusal is believed. */
  it("ends the session and tells the whole app", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];
    replies["/health"] = [{ status: 200, body: HEALTHY }];

    const result = await apiRequest("/customer/me");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionExpired).toBe(true);
    expect(stored).toBeNull();
    expect(announced).toBe(1);
    expect(requested).toEqual(["/customer/me", "/customer-auth/refresh", "/health"]);
  });

  /** The backend's own 503 from the health check is still the backend. */
  it("believes it from an address whose health check says the database is down", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];
    replies["/health"] = [{ status: 503, body: { statusCode: 503, message: "database unreachable" } }];

    const result = await apiRequest("/customer/me");

    expect(!result.ok && result.sessionExpired).toBe(true);
    expect(announced).toBe(1);
  });

  it("does not ask for the health check where the backend has already answered", async () => {
    replies["/customer/subscriptions"] = [{ status: 200, body: [] }];
    await apiRequest("/customer/subscriptions");
    requested.length = 0;
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];

    const result = await apiRequest("/customer/me");

    expect(!result.ok && result.sessionExpired).toBe(true);
    expect(announced).toBe(1);
    expect(requested).toEqual(["/customer/me", "/customer-auth/refresh"]);
  });
});

/** A 401 from something that is not the backend says nothing about the
 * session. In a simulated network, one broken address answering 401 --
 * as a page, or as JSON -- signed the customer out, and signing out takes
 * the tunnel down. */
describe("a 401 that is not the backend's", () => {
  const signedOutNothing = (result: Awaited<ReturnType<typeof apiRequest>>) => {
    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionExpired).toBeFalsy();
    expect(stored).toEqual({ accessToken: "old-access", refreshToken: "refresh" });
    expect(announced).toBe(0);
  };

  it("does not send the refresh when the request was answered by a page", async () => {
    replies["/customer/me"] = [{ status: 401, page: "<html><body>401 Authorization Required</body></html>" }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];

    const result = await apiRequest("/customer/me");

    signedOutNothing(result);
    expect(!result.ok && result.status).toBe(401);
    expect(requested).toEqual(["/customer/me"]);
  });

  it("ends nothing when the refresh is answered by a page", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, page: "<html><body>401 Authorization Required</body></html>" }];
    replies["/health"] = [{ status: 200, body: HEALTHY }];

    signedOutNothing(await apiRequest("/customer/me"));
  });

  /** An address that answers 401 to everything, the health check
   * included, which is public: that is not the backend refusing a token. */
  it("ends nothing when the address answers the health check with a 401 too", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];
    replies["/health"] = [{ status: 401, body: { message: "Unauthorized" } }];

    signedOutNothing(await apiRequest("/customer/me"));
  });

  it("ends nothing when the address does not answer the health check", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];
    replies["/health"] = ["unreachable"];

    signedOutNothing(await apiRequest("/customer/me"));
  });

  it("ends nothing when the address answers the health check with a page", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401, body: REVOKED }];
    replies["/health"] = [{ status: 200, page: "<html><body>It works!</body></html>" }];

    signedOutNothing(await apiRequest("/customer/me"));
  });

  /** A page with a success status is not a new pair of tokens. It used to
   * be read as one, and the JSON parse threw out of the request. */
  it("does not take a page for a renewed session", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 200, page: "<html><body>Welcome</body></html>" }];

    signedOutNothing(await apiRequest("/customer/me"));
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

/** The pre-connect refresh's report names which leg of this chain a
 * failure happened in. After fifteen idle minutes the access token has
 * expired, so a refresh is then all three legs, each a separate
 * connection -- and "the GET answered, the token refresh did not" is a
 * different problem from "nothing answered at all". */
describe("the endpoint trace of an authenticated request", () => {
  it("records the request, the token refresh and the retry as separate legs", async () => {
    replies["/customer/me"] = [{ status: 401 }, { status: 200, body: { id: "c1" } }];
    replies["/customer-auth/refresh"] = [{ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } }];
    const trace = newTrace();

    await apiRequest("/customer/me", undefined, trace);

    expect(renderTrace(trace)).toMatch(
      /^req: a\.example=h401@\d+; refresh: a\.example=h200@\d+; retry: a\.example=h200@\d+$/,
    );
  });

  it("shows the leg that could not be completed", async () => {
    replies["/customer/me"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = ["unreachable"];
    const trace = newTrace();

    await apiRequest("/customer/me", undefined, trace);

    expect(renderTrace(trace)).toMatch(/^req: a\.example=h401@\d+; refresh: a\.example=net@\d+$/);
  });

  /** Tracing is an observer: with one, nothing extra is sent. */
  it("sends exactly the requests it would without a trace", async () => {
    replies["/customer/me"] = [{ status: 401 }, { status: 200, body: { id: "c1" } }];
    replies["/customer-auth/refresh"] = [{ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } }];
    await apiRequest("/customer/me", undefined, newTrace());
    expect(requested).toEqual(["/customer/me", "/customer-auth/refresh", "/customer/me"]);
  });
});

/** One expiry, met by several requests at once: the dashboard's three
 * reads and a claim, on the test VM, which sent four refreshes within 0.6
 * s. Each request still gets what it got before -- a retry with the new
 * token, a failure in its own words, a sign-out -- from one refresh. */
describe("requests that find the token expired at once", () => {
  /** A refresh held until the test lets it be answered, so the requests'
   * refusals all come back while it is under way. */
  function held(reply: Exclude<Reply, "unreachable"> | "unreachable") {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer: Exclude<Reply, "unreachable"> =
      reply === "unreachable" ? { status: 0, after: gate.then(() => Promise.reject(new Error("no route"))) } : { ...reply, after: gate };
    return { answer, release };
  }
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const READS = ["/customer/me", "/customer/subscriptions", "/customer/protocol-users"];
  const refreshes = () => requested.filter((path) => path === "/customer-auth/refresh").length;

  it("send one refresh, and each is retried with the new token", async () => {
    for (const path of READS) replies[path] = [{ status: 401 }, { status: 200, body: { path } }];
    const refresh = held({ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } });
    replies["/customer-auth/refresh"] = [refresh.answer];

    const results = Promise.all(READS.map((path) => apiRequest<{ path: string }>(path)));
    await settle();
    refresh.release();

    expect(await results).toEqual(READS.map((path) => ({ ok: true, data: { path } })));
    expect(refreshes()).toBe(1);
    expect(stored).toEqual({ accessToken: "new-access", refreshToken: "r2" });
    expect(announced).toBe(0);
  });

  /** The unanswered reports are made from these traces, and one of a
   * request that only waited for the refresh has to say what the refresh
   * did as much as the one that sent it. */
  it("each record the one refresh in their own trace", async () => {
    for (const path of READS) replies[path] = [{ status: 401 }, { status: 200, body: { path } }];
    const refresh = held({ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } });
    replies["/customer-auth/refresh"] = [refresh.answer];
    const traces = READS.map(() => newTrace());

    const results = Promise.all(READS.map((path, i) => apiRequest(path, undefined, traces[i])));
    await settle();
    refresh.release();
    await results;

    expect(refreshes()).toBe(1);
    for (const trace of traces) {
      expect(renderTrace(trace)).toMatch(/^req: a\.example=h401@\d+; refresh: a\.example=h200@\d+; retry: a\.example=h200@\d+$/);
    }
  });

  /** A failure shared, not tried again by each request in turn. */
  it("share a refresh that could not be completed, and end nothing", async () => {
    for (const path of READS) replies[path] = [{ status: 401 }];
    const refresh = held("unreachable");
    // Answers for any further refresh, which none should send.
    replies["/customer-auth/refresh"] = [refresh.answer, { status: 200, body: { accessToken: "x", refreshToken: "y" } }];

    const results = Promise.all(READS.map((path) => apiRequest(path)));
    await settle();
    refresh.release();

    for (const result of await results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.sessionExpired).toBeFalsy();
    }
    expect(refreshes()).toBe(1);
    expect(stored).toEqual({ accessToken: "old-access", refreshToken: "refresh" });
    expect(announced).toBe(0);
  });

  /** The sign-out rules are each request's, as they were. */
  it("each end the session when the backend refuses the one refresh", async () => {
    replies["/customer/subscriptions"] = [{ status: 200, body: [] }];
    await apiRequest("/customer/subscriptions");
    requested.length = 0;
    for (const path of READS) replies[path] = [{ status: 401 }];
    const refresh = held({ status: 401, body: REVOKED });
    replies["/customer-auth/refresh"] = [refresh.answer];

    const results = Promise.all(READS.map((path) => apiRequest(path)));
    await settle();
    refresh.release();

    for (const result of await results) expect(!result.ok && result.sessionExpired).toBe(true);
    expect(refreshes()).toBe(1);
    expect(stored).toBeNull();
    expect(announced).toBeGreaterThan(0);
  });

  /** A refusal that comes back after another request has already renewed
   * the session -- on the VM, the claim's, which sent a fourth refresh. */
  it("retry a request refused after the session was renewed with the new token, sending no refresh", async () => {
    replies["/customer/me"] = [{ status: 401 }, { status: 200, body: { id: "c1" } }];
    replies["/customer-auth/refresh"] = [{ status: 200, body: { accessToken: "new-access", refreshToken: "r2" } }];
    let releaseLate: () => void = () => undefined;
    const lateRefusal = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    replies["/customer/subscriptions"] = [{ status: 401, after: lateRefusal }, { status: 200, body: [] }];

    const late = apiRequest("/customer/subscriptions");
    await settle();
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: { id: "c1" } });
    releaseLate();

    expect(await late).toEqual({ ok: true, data: [] });
    expect(refreshes()).toBe(1);
    expect(stored).toEqual({ accessToken: "new-access", refreshToken: "r2" });
  });
});
