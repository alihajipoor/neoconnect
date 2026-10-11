import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What becomes of the pages a write walks past.
 *
 * Under the HTTP plugin a response is parked on the Rust side, with its
 * connection, until its body is read to the end or cancelled; aborting the
 * request releases it too, and every race aborts its losers. A write's
 * walk aborted nothing: a page from in front of the backend -- a CDN's 403
 * -- was kept as the answer of last resort, any second one was simply
 * left, and when a later address took the write the kept one was never
 * read either. Each stayed parked with its connection open, with
 * keep-alives by the physical adapter if it had been sent on the bare line
 * before a connect.
 *
 * Driven through the real api.ts against a network stood in for per
 * address and path, with a fake clock. Addresses are stand-ins. */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([A, B, C]),
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

const { publicRequest, resetRaceWinnerForTests, LEAD_MS } = await import("./api");
const { resetDemotionsForTests } = await import("./endpoint-demotion");

/** Origins whose page had its body let go of. */
let released: string[];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** A CDN's 403 page, whose body records being cancelled. */
const page = (origin: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      cancel: () => {
        released.push(origin);
      },
    }),
    { status: 403, headers: { "content-type": "text/html" } },
  );

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  resetDemotionsForTests();
  released = [];
  tauriFetch.mockImplementation((url: string) => {
    const { origin, pathname } = new URL(url);
    // Each answers its health check, one after another so each health race
    // has one winner: A, then B, then C.
    if (pathname === "/health") {
      const after = { [A]: 10, [B]: LEAD_MS + 10, [C]: 2 * LEAD_MS + 10 }[origin] ?? 0;
      return new Promise((resolve) => setTimeout(() => resolve(json({ status: "ok" })), after));
    }
    // The write: a page from A and from B, an answer from C.
    return Promise.resolve(origin === C ? json({ ok: true }) : page(origin));
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("a write that walks past pages", () => {
  it("lets go of every page it does not return", async () => {
    const pending = publicRequest("/customer/devices/claim", { method: "POST", body: "{}" });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(released.sort()).toEqual([A, B]);
  });
});
