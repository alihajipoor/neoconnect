import { beforeEach, describe, expect, it, vi } from "vitest";

/** The device-slot release sent again after a Disconnect's teardown, on
 * the bare line (`ReleaseOptions` in device-slot-session.ts), through the
 * real `apiRequest` with only the transport stood in for -- per address,
 * since which address it goes to is the thing under test.
 *
 * While the tunnel was up, the backend answered from address A, through
 * the tunnel. Once it is down, the bare line drops A and reaches B. A
 * write with a deadline went straight to A, and a health race led with A
 * alone for `LEAD_MS`; either way the release's second and a half went on
 * A, and B, which would have taken it at once, was never asked. Nothing
 * here has been seen on a real network. */

const A = "https://a.example";
const B = "https://b.example";

/** Addresses the bare line drops: nothing comes back until the request is
 * stopped. */
const dropped = new Set<string>();
/** Where each release was sent. */
const releasedAt: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url);
    if (dropped.has(origin)) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (pathname === "/customer/vpn/release") {
      releasedAt.push(origin);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([A, B]),
  rememberEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve(), isKnownBlockPage: () => false }));
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => Promise.resolve(),
}));

const { releaseSlot } = await import("./device-slots");
const { apiRequest, resetRaceWinnerForTests } = await import("./api");
const { resetDemotionsForTests } = await import("./endpoint-demotion");

const REQUEST = { subscriptionId: "6f1c2b9e-0000-4000-8000-000000000001", handle: "Zm9vYmFyYmF6" };

beforeEach(async () => {
  resetRaceWinnerForTests();
  resetDemotionsForTests();
  dropped.clear();
  releasedAt.length = 0;
  // Answered from A while the tunnel was up: A is the last winner.
  const read = await apiRequest("/customer/me");
  expect(read.ok).toBe(true);
  // The tunnel comes down, and the bare line drops A.
  dropped.add(A);
});

describe("the release sent again after a teardown", () => {
  it("reaches an address the bare line does reach, within its budget", async () => {
    const started = Date.now();
    await expect(releaseSlot(REQUEST, 1_500, { afterTeardown: true })).resolves.toBe(true);
    expect(releasedAt).toEqual([B]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /** The release on the press, through the tunnel, keeps going straight to
   * the address that answered last: there the shortcut is right, and it is
   * what lets a release fit in a second and a half at all on a slow link. */
  it("leaves the release on the press going straight to the address that answered last", async () => {
    await expect(releaseSlot(REQUEST, 300)).resolves.toBe(false);
    expect(releasedAt).toEqual([]);
  });
});
