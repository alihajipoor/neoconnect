import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Where Google and Facebook sign-in opens the browser, and what the
 * sign-in screen says about the part of it the app cannot move.
 *
 * The browser used to be sent to the first compiled-in address, a CDN
 * name, no matter which address the app was actually reaching, so where
 * that name was blocked these buttons could not even open while email
 * sign-in got through on a mirror. Run against a simulated network and a
 * stand-in for the native browser session; no provider and no server. */

const CDN = "https://cdn.example/api";
const MIRROR = "https://mirror.example:2053/api";

/** The store, in memory, as `api-endpoints-remembered.test.ts` has it. */
const files = new Map<string, Map<string, unknown>>();
const store = { failing: false };
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    if (store.failing) throw new Error("store unavailable");
    let data = files.get(name);
    if (!data) {
      data = new Map<string, unknown>();
      files.set(name, data);
    }
    const kept = data;
    return {
      get: async (key: string) => kept.get(key),
      set: async (key: string, value: unknown) => void kept.set(key, value),
      save: async () => undefined,
    };
  },
}));

/** The CDN name is blocked: it never connects. The mirror answers. */
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) =>
    url.startsWith(CDN)
      ? Promise.reject(new TypeError("error sending request"))
      : Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })),
}));

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

let social: typeof import("./social-auth");
let api: typeof import("./api");
let endpoints: typeof import("./api-endpoints");
let config: typeof import("./config");

/** The URL the native browser session was asked to open. */
let opened: string | null;

beforeEach(async () => {
  files.clear();
  store.failing = false;
  opened = null;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "vpn_open_auth_session") throw new Error(`unexpected ${cmd}`);
    opened = String(args?.url);
    return "neoconnect://social-callback?handoff=the-code";
  });
  // Android: the native session, which `invoke` stands in for.
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14)", maxTouchPoints: 5, language: "en-US" });
  // A fresh module is a fresh process: nothing remembered in memory.
  vi.resetModules();
  vi.doMock("./api-endpoints", async (original) => ({
    ...(await original<typeof import("./api-endpoints")>()),
    apiEndpoints: () => Promise.resolve([CDN, MIRROR]),
  }));
  endpoints = await import("./api-endpoints");
  api = await import("./api");
  social = await import("./social-auth");
  config = await import("./config");
  api.resetRaceWinnerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./api-endpoints");
});

describe("the address the browser sign-in starts at", () => {
  it("is the one the backend answered from last, not the first compiled-in one", async () => {
    // The plan list is a read: the CDN never connects, the mirror answers.
    const plans = await api.publicRequest("/plans", { method: "GET" });
    expect(plans.ok).toBe(true);

    await social.startSocialSignIn("google", "fa");

    expect(opened).not.toBeNull();
    expect(opened!.startsWith(`${MIRROR}/customer-auth/social/google/start?locale=fa&challenge=`)).toBe(true);
  });

  it("is the address remembered in an earlier run, before anything has answered in this one", async () => {
    files.set("api-endpoints.json", new Map([["lastGood", MIRROR]]));

    await social.startSocialSignIn("facebook", "en");

    expect(opened!.startsWith(`${MIRROR}/customer-auth/social/facebook/start?`)).toBe(true);
  });

  it("is the first compiled-in address when nothing has ever answered", async () => {
    await social.startSocialSignIn("google", "en");

    expect(opened!.startsWith(`${config.API_BASE_URL.replace(/\/$/, "")}/customer-auth/social/google/start?`)).toBe(
      true,
    );
  });

  it("is the first compiled-in address when the memory cannot be read", async () => {
    store.failing = true;

    await expect(social.socialStartBase()).resolves.toBe(config.API_BASE_URL);
  });

  it("is never a plain http address, which goes to the customer's browser", async () => {
    await endpoints.rememberEndpoint("http://mirror.example/api");

    await expect(social.socialStartBase()).resolves.toBe(config.API_BASE_URL);
  });
});

describe("what the sign-in screen says about the way back", () => {
  it("is said for the providers whose sign-in comes back through the backend's fixed address", () => {
    expect(social.finishesBehindCloudflare("google")).toBe(true);
    expect(social.finishesBehindCloudflare("facebook")).toBe(true);
    // Apple's native sheet hands its token to the app, which sends it
    // through any address it can reach.
    expect(social.finishesBehindCloudflare("apple")).toBe(false);
  });

  it("names Cloudflare and points to email sign-in, in both languages", async () => {
    const { DICTIONARIES } = await import("./i18n");
    expect(DICTIONARIES.en["auth.socialNeedsCloudflare"]).toMatch(/Cloudflare/);
    expect(DICTIONARIES.en["auth.socialNeedsCloudflare"]).toMatch(/email/);
    expect(DICTIONARIES.fa["auth.socialNeedsCloudflare"]).toMatch(/Cloudflare|کلادفلر/);
    expect(DICTIONARIES.fa["auth.socialNeedsCloudflare"]).toContain("ایمیل");
    // Formal «شما», like the rest of the dictionary.
    expect(DICTIONARIES.fa["auth.socialNeedsCloudflare"]).toContain("خود");
    expect(DICTIONARIES.fa["auth.socialNeedsCloudflare"]).not.toMatch(/تو/);
  });

  /** Read from the source: the component has no test harness of its own.
   * What matters is the order -- the note is set when the browser opens,
   * survives a browser closed without a result, which is the only moment
   * a phone can show it, and goes once an answer came back. */
  it("shows the note while the browser is open and after it closes without a result", () => {
    const source = readFileSync(new URL("../components/SocialSignIn.tsx", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function start("));
    const opens = body.indexOf("setCloudflareNote(finishesBehindCloudflare(provider))");
    const signIn = body.indexOf("await socialSignIn(provider)");
    const cancelled = body.indexOf("if (result === null) return;");
    const answered = body.indexOf("setCloudflareNote(false)");
    expect(opens).toBeGreaterThan(-1);
    expect(opens).toBeLessThan(signIn);
    expect(cancelled).toBeGreaterThan(signIn);
    expect(answered).toBeGreaterThan(cancelled);
    expect(source).toContain('{t("auth.socialNeedsCloudflare")}');
  });
});
