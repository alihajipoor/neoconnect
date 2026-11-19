import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A 304 carrying the tag the app sent counts as the backend answering.
 *
 * Express drops `Content-Type` on a 304, so the JSON test that decides
 * "this address reaches the backend" never passed it, and relay mode and
 * doors-first stayed on until their next probe although the names already
 * worked (review of the config-refresh revalidation, 2026-11-19). */

const ENDPOINTS = ["https://a.example"];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => tauriFetch(...args) }));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve(), isKnownBlockPage: () => false }));
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "a", refreshToken: "r" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => Promise.resolve(),
}));

const noteNormalRouteAnswered = vi.fn();
const noteNameAnswered = vi.fn();
vi.mock("./last-resort", async (orig) => ({ ...(await orig<Record<string, unknown>>()), noteNormalRouteAnswered: () => noteNormalRouteAnswered() }));
vi.mock("./server-doors", async (orig) => ({ ...(await orig<Record<string, unknown>>()), noteNameAnswered: () => noteNameAnswered() }));

let api: typeof import("./api");

beforeEach(async () => {
  vi.resetModules();
  noteNormalRouteAnswered.mockReset();
  noteNameAnswered.mockReset();
  api = await import("./api");
});

afterEach(() => tauriFetch.mockReset());

const notModified = (etag: string | null) =>
  new Response(null, { status: 304, headers: etag === null ? {} : { etag } });

describe("a revalidation answered 304", () => {
  it("with the tag the app sent: the names reach the backend again", async () => {
    tauriFetch.mockResolvedValue(notModified('W/"pu-abc"'));
    const answer = await api.apiRequestRevalidated("/customer/protocol-users", 'W/"pu-abc"');
    expect(answer).toMatchObject({ ok: true, notModified: true });
    expect(noteNormalRouteAnswered).toHaveBeenCalled();
    expect(noteNameAnswered).toHaveBeenCalled();
  });

  it("without the tag: still a cache hit, but not taken as proof of the backend", async () => {
    tauriFetch.mockResolvedValue(notModified(null));
    const answer = await api.apiRequestRevalidated("/customer/protocol-users", 'W/"pu-abc"');
    expect(answer).toMatchObject({ ok: true, notModified: true });
    expect(noteNormalRouteAnswered).not.toHaveBeenCalled();
  });
});
