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
let resetRaceWinnerForTests: typeof import("./api").resetRaceWinnerForTests;

beforeEach(async () => {
  vi.resetModules();
  ({ publicRequest, isGatewayFailure, resetRaceWinnerForTests } = await import("./api"));
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

  it("stops at the backend's own refusal exactly as before", async () => {
    const seen = serveWrite(() => json({ message: "wrong password" }, 401));
    const result = await publicRequest("/customer-auth/login", { method: "POST", body: "{}" });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(seen).toEqual([MIRROR]);
  });
});
