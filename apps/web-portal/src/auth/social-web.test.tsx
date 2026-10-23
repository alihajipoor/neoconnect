import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The shared code keeps its state in localStorage (src/shims/plugin-store.ts)
// and reads it as it loads; node has none, so a Map stands in.
vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@shared/lib/i18n";
import { pkcePair } from "@shared/lib/social-auth";
import {
  PENDING_KEY,
  PENDING_TTL_MS,
  beginWebSocialSignIn,
  claim,
  takeSocialReturn,
  webStartUrl,
  type BeginDeps,
  type PageEnv,
  type PendingSocial,
  type SocialReturn,
} from "./social-web";
import { SocialSignIn, settleReturn, type ReturnWords } from "./SocialSignIn";
import { COPY } from "./copy";

/** A page at /account/ with `hash`, its sessionStorage holding `pending`. */
function page(hash = "", pending?: unknown, now = 1_000_000) {
  const store = new Map<string, string>();
  if (pending !== undefined) store.set(PENDING_KEY, JSON.stringify(pending));
  const replaced: string[] = [];
  const env: PageEnv = {
    location: { hash, pathname: "/account/", search: "" },
    history: { state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    now: () => now,
  };
  return { env, store, replaced };
}

const TRIP: PendingSocial = {
  provider: "google",
  verifier: "v".repeat(43),
  screen: "register",
  voucher: "GIFT-1",
  plan: true,
  startedAt: 1_000_000 - 60_000,
};

const b64url = (buf: Buffer) => buf.toString("base64url");

describe("the PKCE pair the portal leaves with", () => {
  it("is a 43-character verifier and its S256 challenge, as the server checks it", async () => {
    const pair = await pkcePair();
    expect(pair).not.toBeNull();
    expect(pair!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair!.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The server hashes the verifier exactly this way (consumeHandoff).
    expect(pair!.challenge).toBe(b64url(createHash("sha256").update(pair!.verifier).digest()));
  });

  it("is different every time", async () => {
    const [a, b] = await Promise.all([pkcePair(), pkcePair()]);
    expect(a!.verifier).not.toBe(b!.verifier);
  });
});

describe("leaving for the provider", () => {
  function deps(over: Partial<BeginDeps> = {}) {
    const p = page();
    const navigate = vi.fn();
    const d: BeginDeps = {
      pkce: async () => ({ verifier: "the-verifier", challenge: "C".repeat(43) }),
      base: async () => "https://api.example.test/api/",
      navigate,
      env: p.env,
      locale: () => "fa",
      ...over,
    };
    return { d, navigate, store: p.store };
  }

  it("goes to the API's start with the challenge and client=web, never the verifier", async () => {
    const { d, navigate } = deps();
    expect(await beginWebSocialSignIn("facebook", { screen: "login", voucher: null, plan: false }, d)).toBe("left");
    const url = new URL(navigate.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.example.test/api/customer-auth/social/facebook/start");
    expect(url.searchParams.get("client")).toBe("web");
    expect(url.searchParams.get("challenge")).toBe("C".repeat(43));
    expect(url.searchParams.get("locale")).toBe("fa");
    expect(url.toString()).not.toContain("the-verifier");
  });

  it("keeps the verifier, the screen and what the visitor arrived with, before leaving", async () => {
    const { d, navigate, store } = deps();
    navigate.mockImplementation(() => expect(store.has(PENDING_KEY)).toBe(true));
    await beginWebSocialSignIn("google", { screen: "register", voucher: "GIFT-1", plan: true }, d);
    expect(JSON.parse(store.get(PENDING_KEY)!)).toMatchObject({
      provider: "google",
      verifier: "the-verifier",
      screen: "register",
      voucher: "GIFT-1",
      plan: true,
    });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("does not leave without a PKCE pair, or somewhere to keep its verifier", async () => {
    const noCrypto = deps({ pkce: async () => null });
    expect(await beginWebSocialSignIn("google", { screen: "login", voucher: null, plan: false }, noCrypto.d)).toBe("unsafe");
    expect(noCrypto.navigate).not.toHaveBeenCalled();

    const noStore = deps();
    noStore.d.env = { ...noStore.d.env, storage: null };
    expect(await beginWebSocialSignIn("google", { screen: "login", voucher: null, plan: false }, noStore.d)).toBe("unsafe");
    expect(noStore.navigate).not.toHaveBeenCalled();

    const full = deps();
    full.d.env = {
      ...full.d.env,
      storage: { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error("QuotaExceededError"); } },
    };
    expect(await beginWebSocialSignIn("google", { screen: "login", voucher: null, plan: false }, full.d)).toBe("unsafe");
    expect(full.navigate).not.toHaveBeenCalled();
  });

  it("builds the start URL as the apps do, plus client=web", () => {
    expect(webStartUrl("https://a.test/api", "google", "en", "C".repeat(43))).toBe(
      `https://a.test/api/customer-auth/social/google/start?locale=en&challenge=${"C".repeat(43)}&client=web`,
    );
  });
});

describe("coming back", () => {
  it("takes the handoff from the fragment, with the verifier its trip left", () => {
    const { env, store, replaced } = page("#handoff=CODE123", TRIP);
    const found = takeSocialReturn(env);
    expect(found).toEqual({ kind: "handoff", code: "CODE123", pending: TRIP });
    // Out of the address bar and out of storage: neither a copied URL nor
    // a reload carries it again.
    expect(replaced).toEqual(["/account/"]);
    expect(store.has(PENDING_KEY)).toBe(false);
  });

  it("refuses a handoff this tab did not start, without trying it", () => {
    // Someone else's sign-in in a link: nothing here can collect it, and
    // nothing should.
    const { env, replaced } = page("#handoff=THEIRS");
    expect(takeSocialReturn(env)).toEqual({ kind: "error", code: "lost", pending: null });
    expect(replaced).toEqual(["/account/"]);
  });

  it("does not trust a trip older than the server keeps one", () => {
    const { env } = page("#handoff=CODE", { ...TRIP, startedAt: 1_000_000 - PENDING_TTL_MS - 1 });
    expect(takeSocialReturn(env)).toMatchObject({ kind: "error", code: "lost" });
  });

  it("reads the server's error code, for a trip this tab made", () => {
    expect(takeSocialReturn(page("#error=disabled", TRIP).env)).toEqual({ kind: "error", code: "disabled", pending: TRIP });
    // From a link, not a trip: nothing to explain.
    expect(takeSocialReturn(page("#error=disabled").env)).toEqual({ kind: "none" });
  });

  it("treats Cancel at the provider as no failure, keeping the trip", () => {
    expect(takeSocialReturn(page("#error=cancelled", TRIP).env)).toEqual({ kind: "cancelled", pending: TRIP });
  });

  it("knows a trip that came back with nothing", () => {
    // Back pressed on a provider page that never loaded.
    const { env, replaced } = page("", TRIP);
    expect(takeSocialReturn(env)).toEqual({ kind: "unfinished", pending: TRIP });
    expect(replaced).toEqual([]);
  });

  it("leaves an ordinary visit, and a fragment that is not ours, alone", () => {
    expect(takeSocialReturn(page().env)).toEqual({ kind: "none" });
    const other = page("#plans");
    expect(takeSocialReturn(other.env)).toEqual({ kind: "none" });
    expect(other.replaced).toEqual([]);
  });

  it("is settled once, however often a screen mounts", () => {
    const found = takeSocialReturn(page("#handoff=C", TRIP).env);
    expect(claim(found)).toBe(true);
    expect(claim(found)).toBe(false);
    expect(claim({ kind: "none" })).toBe(false);
  });
});

describe("what a return comes to", () => {
  const words: ReturnWords = {
    say: (key, provider) => `${key}:${provider ?? "-"}`,
    t: (key) => key,
    failure: (result) => result.error,
  };
  const ok = async () => ({ ok: true as const, data: { accessToken: "a", refreshToken: "r" } });

  it("collects the handoff with its verifier, and only then is signed in", async () => {
    const collect = vi.fn(ok);
    const found: SocialReturn = { kind: "handoff", code: "CODE", pending: TRIP };
    expect(await settleReturn(found, words, collect)).toEqual({ signedIn: true });
    expect(collect).toHaveBeenCalledWith("CODE", TRIP.verifier);
  });

  it("says why the collection failed, in the apps' words", async () => {
    const collect = vi.fn(async () => ({ ok: false as const, error: "This sign-in has expired -- please try again" }));
    const outcome = await settleReturn({ kind: "handoff", code: "C", pending: TRIP }, words, collect);
    expect(outcome).toEqual({ signedIn: false, shown: { tone: "danger", text: "This sign-in has expired -- please try again" } });
  });

  it.each([
    ["disabled", "socialDisabled:google"],
    ["exists", "socialExists:google"],
    ["unverified", "socialUnverified:google"],
    ["no-email", "socialNoEmail:google"],
    ["expired", "socialExpired:google"],
    ["failed", "auth.socialFailed"],
    ["invalid", "auth.socialFailed"],
    ["something-new", "auth.socialFailed"],
  ])("words the server's %s", async (code, text) => {
    expect(await settleReturn({ kind: "error", code, pending: TRIP }, words)).toEqual({
      signedIn: false,
      shown: { tone: "danger", text },
    });
  });

  it("says a handoff from another tab cannot be finished here", async () => {
    const collect = vi.fn(ok);
    expect(await settleReturn({ kind: "error", code: "lost", pending: null }, words, collect)).toEqual({
      signedIn: false,
      shown: { tone: "danger", text: "socialLost:-" },
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it("says plainly that a trip which came back empty may have been blocked", async () => {
    expect(await settleReturn({ kind: "unfinished", pending: { ...TRIP, provider: "facebook" } }, words)).toEqual({
      signedIn: false,
      shown: { tone: "neutral", text: "socialNotFinished:facebook" },
    });
  });

  it("says nothing for a cancel or an ordinary visit", async () => {
    expect(await settleReturn({ kind: "cancelled", pending: TRIP }, words)).toEqual({ signedIn: false, shown: null });
    expect(await settleReturn({ kind: "none" }, words)).toEqual({ signedIn: false, shown: null });
  });
});

describe("the buttons", () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <SocialSignIn from="login" onSuccess={() => {}} />
    </I18nProvider>,
  );

  it("offer Google and Facebook, not Apple", () => {
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Facebook");
    expect(html).not.toMatch(/apple/i);
  });

  it("carry no style attribute for the page's style-src to refuse", () => {
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("draw Google's mark in its own four colours and Facebook's f in white on its blue", () => {
    for (const colour of ["#4285F4", "#34A853", "#FBBC05", "#EA4335", "#0866FF", "#ffffff"]) {
      expect(html).toContain(colour);
    }
  });

  it("have every sentence in both languages, naming the provider where the English does", () => {
    const keys = Object.keys(COPY.en).filter((k) => k.startsWith("social"));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      const en = (COPY.en as Record<string, string>)[key];
      const fa = (COPY.fa as Record<string, string>)[key];
      expect(fa.split("{provider}").length, key).toBe(en.split("{provider}").length);
    }
  });

  it("are the portal's on both sign-in screens, in place of the apps' empty ones", () => {
    for (const name of ["PortalLogin", "PortalRegister"]) {
      const source = readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
      expect(source).toContain('import { SocialSignIn, type PortalSocial } from "./SocialSignIn";');
      expect(source).toContain("<SocialSignIn social={social}");
    }
  });
});
