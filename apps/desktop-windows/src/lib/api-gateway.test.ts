import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One broken mirror must not speak for the service.
 *
 * A node mirror whose upstream is gone answers every `/api/*` with an
 * immediate 502 -- recorded more than once in the journal. It never
 * reaches the backend, so it answers faster than a healthy endpoint, and
 * the race accepted the first answer of any status: every GET failed with
 * "Request failed (502)", the mirror was remembered, and then led every
 * write, which stopped on it. */

const MIRROR = "https://broken-mirror.example";
const CDN = "https://cdn.example";
const OTHER = "https://other.example";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

const { remembered, refreshed } = vi.hoisted(() => ({
  remembered: [] as string[],
  refreshed: [] as string[],
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([MIRROR, CDN, OTHER]),
  rememberEndpoint: (base: string) => {
    remembered.push(base);
    return Promise.resolve();
  },
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: (base: string) => {
    refreshed.push(base);
    return Promise.resolve();
  },
}));

let publicRequest: typeof import("./api").publicRequest;
let isGatewayFailure: typeof import("./api").isGatewayFailure;
let isForeignPage: typeof import("./api").isForeignPage;
let resetRaceWinnerForTests: typeof import("./api").resetRaceWinnerForTests;

beforeEach(async () => {
  vi.resetModules();
  ({ publicRequest, isGatewayFailure, isForeignPage, resetRaceWinnerForTests } = await import("./api"));
});

afterEach(() => {
  tauriFetch.mockReset();
  remembered.length = 0;
  refreshed.length = 0;
});

const gatewayPage = (status = 502) =>
  new Response("<html><body>502 Bad Gateway</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A page from something in front of the backend that is not a gateway
 * failure: a node's fallback site without the API (404), the CDN's bot
 * check (403), nginx refusing what it will not pass on (400, 405, 413),
 * its own rate limit (429), a fallback site behind a password (401). */
const page = (status: number) =>
  new Response(`<html><body>${status}</body></html>`, { status, headers: { "content-type": "text/html" } });
const PAGE_STATUSES = [400, 401, 403, 404, 405, 413, 429];

/** Answers per origin, after a delay per origin. */
function serve(routes: Record<string, { after: number; reply: () => Response } | "unreachable">) {
  tauriFetch.mockImplementation((url: string) => {
    const route = routes[new URL(url).origin];
    if (route === undefined || route === "unreachable") return Promise.reject(new Error("no route"));
    return new Promise((resolve) => setTimeout(() => resolve(route.reply()), route.after));
  });
}

describe("telling a proxy's failure page from an answer", () => {
  it("knows the backend's own JSON 503 is an answer", () => {
    expect(isGatewayFailure(gatewayPage(502))).toBe(true);
    expect(isGatewayFailure(gatewayPage(504))).toBe(true);
    expect(isGatewayFailure(gatewayPage(522))).toBe(true);
    expect(isGatewayFailure(json({ message: "database unreachable" }, 503))).toBe(false);
    expect(isGatewayFailure(json({ message: "nope" }, 500))).toBe(false);
    expect(isGatewayFailure(new Response("no", { status: 401 }))).toBe(false);
  });

  it("knows any error that is not JSON is not the backend's", () => {
    for (const status of [...PAGE_STATUSES, 500, 502, 503, 521]) {
      expect(isForeignPage(page(status)), `${status}`).toBe(true);
    }
    expect(isForeignPage(new Response("no", { status: 401 }))).toBe(true);
    // The backend's refusals are JSON, every one of them.
    expect(isForeignPage(json({ message: "Unauthorized" }, 401))).toBe(false);
    expect(isForeignPage(json({ message: "Cannot GET /x" }, 404))).toBe(false);
    expect(isForeignPage(json({ message: "ThrottlerException: Too Many Requests" }, 429))).toBe(false);
    // A success is not judged by its type: the backend's 204 has none.
    expect(isForeignPage(new Response(null, { status: 204 }))).toBe(false);
    expect(isForeignPage(new Response(null, { status: 304 }))).toBe(false);
  });
});

describe("a raced read", () => {
  it("does not let a fast gateway page beat a slower real answer, or remember it", async () => {
    serve({
      [MIRROR]: { after: 0, reply: () => gatewayPage() },
      [CDN]: { after: 30, reply: () => json({ hello: "world" }) },
      [OTHER]: "unreachable",
    });
    await expect(publicRequest<{ hello: string }>("/config")).resolves.toEqual({
      ok: true,
      data: { hello: "world" },
    });
    expect(remembered).toEqual([CDN]);
    expect(refreshed).toEqual([CDN]);
  });

  it("still reports the gateway's status when nothing better answers", async () => {
    serve({
      [MIRROR]: { after: 0, reply: () => gatewayPage() },
      [CDN]: { after: 5, reply: () => gatewayPage(503) },
      [OTHER]: "unreachable",
    });
    const result = await publicRequest("/config");
    expect(result).toMatchObject({ ok: false, status: 502 });
    // Something replied, so this is not "could not reach Neoxify".
    expect(result).not.toHaveProperty("noResponse");
    expect(remembered).toEqual([]);
  });

  /** Before: the page won in no time, the server list said "Request
   * failed (404)", and the address was remembered and asked for the
   * bundle, so every request after it started there. */
  it("does not let any other fast page beat a slower real answer, or remember it", async () => {
    for (const status of PAGE_STATUSES) {
      remembered.length = 0;
      refreshed.length = 0;
      serve({
        [MIRROR]: { after: 0, reply: () => page(status) },
        [CDN]: { after: 30, reply: () => json({ hello: "world" }) },
        [OTHER]: "unreachable",
      });
      await expect(publicRequest<{ hello: string }>("/config"), `after ${status}`).resolves.toEqual({
        ok: true,
        data: { hello: "world" },
      });
      expect(remembered, `after ${status}`).toEqual([CDN]);
      expect(refreshed, `after ${status}`).toEqual([CDN]);
    }
  });

  it("takes the backend's own JSON refusal as the answer, however it compares", async () => {
    vi.useFakeTimers();
    try {
      serve({
        // Not in before the end of its head start, so the others are asked.
        [MIRROR]: { after: 1_530, reply: () => json({ hello: "world" }) },
        [CDN]: { after: 0, reply: () => json({ message: "Cannot GET /config" }, 404) },
        [OTHER]: "unreachable",
      });
      const pending = publicRequest("/config");
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, status: 404, error: "Cannot GET /config" });
      expect(remembered).toEqual([CDN]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the first page's status when only pages answer, and remembers neither", async () => {
    serve({
      [MIRROR]: { after: 0, reply: () => page(403) },
      [CDN]: { after: 5, reply: () => page(404) },
      [OTHER]: "unreachable",
    });
    const result = await publicRequest("/config");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result).not.toHaveProperty("noResponse");
    expect(remembered).toEqual([]);
    expect(refreshed).toEqual([]);
  });
});

describe("a write, sent one endpoint at a time", () => {
  /** Every address answers the health check a write is preceded by, so
   * the write starts at the first; `write` decides what the write gets.
   * Returns the addresses the write itself was sent to. */
  function serveWrite(write: (origin: string) => Response): string[] {
    const seen: string[] = [];
    tauriFetch.mockImplementation(async (url: string) => {
      const { origin, pathname } = new URL(url);
      if (pathname === "/health") return json({ status: "ok" });
      seen.push(origin);
      return write(origin);
    });
    return seen;
  }

  it("steps past a page that says the backend was never reached, and does not remember it", async () => {
    // 503 from nginx with no live upstream; the CDN's 521-523 (origin
    // down, refused, timed out connecting), 525/526 (TLS to the origin)
    // and 530: the request never got as far as the backend.
    for (const status of [503, 521, 522, 523, 525, 526, 530]) {
      resetRaceWinnerForTests();
      remembered.length = 0;
      const seen = serveWrite((origin) => (origin === MIRROR ? gatewayPage(status) : json({ token: "ok" })));
      await expect(publicRequest("/customer-auth/login", { method: "POST", body: "{}" })).resolves.toEqual({
        ok: true,
        data: { token: "ok" },
      });
      expect(seen, `after ${status}`).toEqual([MIRROR, CDN]);
      // The mirror for its answer to the health check, and the CDN for its
      // own and for the write's. Never the mirror for its page.
      expect(remembered, `after ${status}`).toEqual([MIRROR, CDN, CDN]);
    }
  });

  it("stops where the backend may already have acted", async () => {
    // 504 and 524 are timeouts after the request went upstream. 502 is
    // also an upstream that closed the connection before answering -- a
    // backend restarting mid-request during a deploy -- and 520 an
    // origin whose answer the CDN could not read. Sending a purchase or
    // a voucher redemption on to the next endpoint after any of them can
    // run it twice.
    for (const status of [502, 504, 520, 524]) {
      resetRaceWinnerForTests();
      const seen = serveWrite((origin) => (origin === MIRROR ? gatewayPage(status) : json({ id: "second copy" }, 201)));
      const result = await publicRequest("/orders", { method: "POST", body: "{}" });
      expect(result, `after ${status}`).toMatchObject({ ok: false, status });
      expect(seen, `after ${status}`).toEqual([MIRROR]);
    }
  });

  /** Before: the write stopped on the page, failed with its status, and
   * the page's address was remembered, so the next write went there
   * first and stopped on it too. */
  it("steps past any other page from in front of the backend, and does not remember it", async () => {
    for (const status of PAGE_STATUSES) {
      resetRaceWinnerForTests();
      remembered.length = 0;
      refreshed.length = 0;
      const seen = serveWrite((origin) => (origin === MIRROR ? page(status) : json({ token: "ok" })));
      await expect(
        publicRequest("/customer-auth/login", { method: "POST", body: "{}" }),
        `after ${status}`,
      ).resolves.toEqual({ ok: true, data: { token: "ok" } });
      expect(seen, `after ${status}`).toEqual([MIRROR, CDN]);
      // The mirror for its answer to the health check only.
      expect(remembered, `after ${status}`).toEqual([MIRROR, CDN, CDN]);
      expect(refreshed, `after ${status}`).toEqual([MIRROR, CDN, CDN]);
    }
  });

  it("still answers with the page when nothing better takes the write", async () => {
    const seen = serveWrite(() => page(403));
    const result = await publicRequest("/customer/vpn/claim", { method: "POST", body: "{}" });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result).not.toHaveProperty("noResponse");
    // Each address once.
    expect(seen).toEqual([MIRROR, CDN, OTHER]);
  });

  /** It ends the write, which must not be sent twice, but it is not the
   * service. Before: remembered and asked for the bundle, so every write
   * after it went there first. */
  it("does not remember a gateway page that ends a write, or ask it for the bundle", async () => {
    for (const status of [502, 504, 520, 524]) {
      resetRaceWinnerForTests();
      remembered.length = 0;
      refreshed.length = 0;
      serveWrite((origin) => (origin === MIRROR ? gatewayPage(status) : json({ id: "second copy" }, 201)));
      await publicRequest("/orders", { method: "POST", body: "{}" });
      // For its answer to the health check, never for its page.
      expect(remembered, `after ${status}`).toEqual([MIRROR]);
      expect(refreshed, `after ${status}`).toEqual([MIRROR]);
    }
  });

  /** The token refresh changes nothing a second copy could duplicate, so
   * a page saying the backend may have seen it is no reason to stop.
   * Before: "could not renew your session" while the next address would
   * have renewed it. */
  it("sends the token refresh on past a gateway page", async () => {
    for (const status of [502, 504, 520, 524]) {
      resetRaceWinnerForTests();
      const seen = serveWrite((origin) =>
        origin === MIRROR ? gatewayPage(status) : json({ accessToken: "a2", refreshToken: "r2" }),
      );
      const result = await publicRequest("/customer-auth/refresh", { method: "POST", body: "{}" });
      expect(result, `after ${status}`).toEqual({ ok: true, data: { accessToken: "a2", refreshToken: "r2" } });
      expect(seen, `after ${status}`).toEqual([MIRROR, CDN]);
    }
  });

  it("stops at the backend's own refusal exactly as before", async () => {
    const seen = serveWrite(() => json({ message: "wrong password" }, 401));
    const result = await publicRequest("/customer-auth/login", { method: "POST", body: "{}" });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(seen).toEqual([MIRROR]);
  });
});
