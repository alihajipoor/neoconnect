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

/** The addresses that never connect: the CDN name is blocked, and every
 * other address answers, unless a test says otherwise. */
const { down, stalled } = vi.hoisted(() => ({ down: new Set<string>(), stalled: new Set<string>() }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => {
    if ([...stalled].some((base) => url.startsWith(base))) {
      // Connected, and never answers: given up on only when stopped.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Request cancelled")));
      });
    }
    return [...down].some((base) => url.startsWith(base))
      ? Promise.reject(new TypeError("error sending request"))
      : Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
  },
}));

/** The list `apiEndpoints` hands back. */
let listed: string[];

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

let social: typeof import("./social-auth");
let api: typeof import("./api");
let config: typeof import("./config");

/** The URL the native browser session was asked to open. */
let opened: string | null;

beforeEach(async () => {
  files.clear();
  store.failing = false;
  opened = null;
  down.clear();
  down.add(CDN);
  stalled.clear();
  listed = [CDN, MIRROR];
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
    apiEndpoints: () => Promise.resolve([...listed]),
  }));
  await import("./api-endpoints");
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

  it("is the first compiled-in address when nothing answers", async () => {
    down.add(MIRROR);

    await social.startSocialSignIn("google", "en");

    expect(opened!.startsWith(`${config.API_BASE_URL.replace(/\/$/, "")}/customer-auth/social/google/start?`)).toBe(
      true,
    );
  });

  /** Nothing answers, slowly. Before this asked, the browser opened at
   * once; asked without a limit, it would have waited out a race with
   * nothing answering, twenty-odd seconds of a spinning button. */
  it("is the first compiled-in address once eight seconds have gone without an answer", async () => {
    vi.useFakeTimers();
    try {
      stalled.add(CDN);
      stalled.add(MIRROR);
      let base: string | null = null;
      void social.socialStartBase().then((found) => (base = found));
      await vi.advanceTimersByTimeAsync(social.START_BASE_BUDGET_MS);
      expect(base).toBe(config.API_BASE_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is never a plain http address, which goes to the customer's browser", async () => {
    listed = ["http://mirror.example/api"];

    await expect(social.socialStartBase()).resolves.toBe(config.API_BASE_URL);
  });

  /** The address remembered from an earlier run, on another network,
   * that does not answer on this one -- a mirror blocked here, or retired.
   * Before: the browser was sent there, with no second try, and Google
   * sign-in could not open while the mirror below would have started it. */
  it("is not an address remembered from before that does not answer now", async () => {
    const DEAD = "https://dead.example:2053/api";
    files.set("api-endpoints.json", new Map([["lastGood", DEAD]]));
    down.add(DEAD);
    listed = [DEAD, CDN, MIRROR];

    await social.startSocialSignIn("google", "en");

    expect(opened!.startsWith(`${MIRROR}/customer-auth/social/google/start?`)).toBe(true);
  });

  /** Where the CDN answers, the whole flow can go through it, and a start
   * there is not counted against a mirror's address, which every customer
   * on that node shares. Before: the remembered mirror, whatever the CDN
   * did. */
  it("asks the compiled-in address first, ahead of a remembered mirror", async () => {
    vi.resetModules();
    vi.doMock("./config", async (original) => ({
      ...(await original<typeof import("./config")>()),
      API_BASE_URLS: [CDN],
      API_BASE_URL: CDN,
    }));
    down.clear();
    files.set("api-endpoints.json", new Map([["lastGood", MIRROR]]));
    listed = [MIRROR, CDN];
    social = await import("./social-auth");

    await expect(social.socialStartBase()).resolves.toBe(CDN);
    vi.doUnmock("./config");
  });
});

describe("a browser sign-in on Windows", () => {
  /** The deep-link listener, and the browser it opens, stood in for. */
  let deliver: ((urls: string[]) => void) | null;
  let browserOpened: string | null;

  beforeEach(async () => {
    deliver = null;
    browserOpened = null;
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 0, language: "en-US" });
    vi.doMock("@tauri-apps/plugin-deep-link", () => ({
      onOpenUrl: async (handler: (urls: string[]) => void) => {
        deliver = handler;
        return () => {
          deliver = null;
        };
      },
    }));
    vi.doMock("@tauri-apps/plugin-opener", () => ({
      openUrl: async (url: string) => {
        browserOpened = url;
      },
    }));
    vi.resetModules();
    social = await import("./social-auth");
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-deep-link");
    vi.doUnmock("@tauri-apps/plugin-opener");
  });

  /** Closing the browser tells the app nothing, so the wait was the whole
   * five minutes, buttons spinning. Cancel ends it at once, and a callback
   * that comes after is not taken. */
  it("ends at once when cancelled, and takes no callback after", async () => {
    const controller = new AbortController();
    const outcome = social.startSocialSignIn("google", "en", controller.signal);
    await vi.waitFor(() => expect(browserOpened).not.toBeNull());

    controller.abort();

    await expect(outcome).resolves.toBeNull();
    expect(deliver).toBeNull();
  });

  it("still hands back the callback when not cancelled", async () => {
    const controller = new AbortController();
    const outcome = social.startSocialSignIn("google", "en", controller.signal);
    await vi.waitFor(() => expect(deliver).not.toBeNull());
    deliver!(["neoconnect://social-callback?handoff=the-code"]);

    await expect(outcome).resolves.toMatchObject({ kind: "handoff", code: "the-code" });
  });
});

describe("the provider buttons", () => {
  /** Read from the source: the component has no harness of its own. The
   * flow is cancelled when the screen goes -- an email sign-in that
   * succeeded meanwhile -- so a late Google callback cannot store another
   * account's session under the dashboard; and a Cancel is offered on
   * Windows while the browser is out. */
  it("cancels the flow when the screen goes, and offers Cancel while it waits", () => {
    const source = readFileSync(new URL("../components/SocialSignIn.tsx", import.meta.url), "utf8");
    expect(source).toContain("useEffect(() => () => flow.current?.abort(), [])");
    expect(source).toContain("await socialSignIn(provider, controller.signal)");
    expect(source).toContain('{t("auth.socialCancel")}');
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
    const signIn = body.indexOf("await socialSignIn(provider, controller.signal)");
    const cancelled = body.indexOf("if (result === null) return;");
    const answered = body.indexOf("setCloudflareNote(false)");
    expect(opens).toBeGreaterThan(-1);
    expect(opens).toBeLessThan(signIn);
    expect(cancelled).toBeGreaterThan(signIn);
    expect(answered).toBeGreaterThan(cancelled);
    expect(source).toContain('{t("auth.socialNeedsCloudflare")}');
  });
});
