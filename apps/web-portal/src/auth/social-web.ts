import { currentLanguage } from "@shared/lib/i18n";
import { pkcePair, socialStartBase, startUrl } from "@shared/lib/social-auth";

/**
 * Google and Facebook sign-in for the web portal: the trip out and back.
 *
 * The apps open a browser and wait for it. The portal IS the browser, so
 * it leaves: to the API's /social/:provider/start with `client=web`, on
 * to the provider, back through the API's callback, and home to
 * https://neoxify.net/account/ with a one-time handoff code in the URL
 * fragment (OauthFlowService.finishUrl). A fragment is never sent to a
 * server, so the code reaches neither the site's logs nor a Referer.
 *
 * The code alone collects nothing. Before leaving, the page makes a PKCE
 * pair; the challenge goes out with the start URL and the server binds
 * the handoff to it, and the verifier waits here in sessionStorage --
 * this tab only, gone when it closes -- to collect it. A handoff pushed
 * into the page by someone else's link meets no verifier, or the wrong
 * one, and is refused.
 *
 * Navigating to the API's host is a top-level navigation, which the
 * page's Content-Security-Policy does not govern; nothing here fetches
 * anything but the API, through the same addresses sign-in uses.
 */

export type WebProvider = "google" | "facebook";

export const WEB_PROVIDERS: readonly WebProvider[] = ["google", "facebook"];

/** What the page keeps across the trip. */
export interface PendingSocial {
  provider: WebProvider;
  verifier: string;
  /** The screen the trip left from, to come back to. */
  screen: "login" | "register";
  /** A voucher or a chosen plan the visitor arrived with (App.tsx).
   * Held in memory there, which a page that leaves would otherwise lose
   * -- and with it the sale the website's Buy button started. */
  voucher: string | null;
  plan: boolean;
  startedAt: number;
}

export const PENDING_KEY = "nx.portal.social";

/** The server keeps a sign-in's state for ten minutes. A record older than
 * that is a trip that is over, not one to finish or to explain. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** What the page found on arriving. Every kind but `none` keeps the trip
 * it belongs to, when there is one, so what the visitor arrived with
 * (`voucher`, `plan`) and the screen they left from survive any ending. */
export type SocialReturn =
  | { kind: "none" }
  /** Back with a code, and the verifier it needs. */
  | { kind: "handoff"; code: string; pending: PendingSocial }
  /** Back with a refusal (the server's short code), or a handoff this tab
   * did not start: `lost`, since it has no verifier for it. */
  | { kind: "error"; code: string; pending: PendingSocial | null }
  /** Cancel pressed at the provider: not a failure, and not answered with
   * one. */
  | { kind: "cancelled"; pending: PendingSocial }
  /** A trip that left and came back with nothing: Back pressed on the
   * provider's page, or on a browser error where a blocked provider or a
   * blocked return should have been. */
  | { kind: "unfinished"; pending: PendingSocial };

export const NO_RETURN: SocialReturn = { kind: "none" };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PageEnv {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "replaceState" | "state">;
  storage: Store | null;
  now: () => number;
}

function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    // Blocked storage throws on access in some browsers.
    return null;
  }
}

export const pageEnv = (): PageEnv => ({
  location: window.location,
  history: window.history,
  storage: sessionStore(),
  now: Date.now,
});

const isProvider = (value: unknown): value is WebProvider => value === "google" || value === "facebook";

function readPending(env: PageEnv): PendingSocial | null {
  let raw: string | null = null;
  try {
    raw = env.storage?.getItem(PENDING_KEY) ?? null;
    env.storage?.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingSocial>;
    if (
      !isProvider(p.provider) ||
      typeof p.verifier !== "string" ||
      typeof p.startedAt !== "number" ||
      env.now() - p.startedAt > PENDING_TTL_MS ||
      p.startedAt > env.now()
    ) {
      return null;
    }
    return {
      provider: p.provider,
      verifier: p.verifier,
      screen: p.screen === "register" ? "register" : "login",
      voucher: typeof p.voucher === "string" ? p.voucher : null,
      plan: p.plan === true,
      startedAt: p.startedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Reads what the page arrived with, once, and clears it: the fragment
 * from the address bar (so the code is not left in history or in a URL
 * someone copies), the pending trip from storage (so a reload does not
 * explain the same trip twice).
 *
 * Call it before anything else rewrites the address -- App's
 * takeFromUrl() writes the path and query back without the fragment.
 */
export function takeSocialReturn(env: PageEnv = pageEnv()): SocialReturn {
  const fragment = new URLSearchParams(env.location.hash.replace(/^#/, ""));
  const handoff = fragment.get("handoff");
  const error = fragment.get("error");
  const ours = handoff !== null || error !== null;
  if (ours) {
    try {
      env.history.replaceState(env.history.state, "", env.location.pathname + env.location.search);
    } catch {
      // The page still works; the code is single-use and short-lived.
    }
  }
  const pending = readPending(env);

  if (handoff) {
    if (!pending) return { kind: "error", code: "lost", pending: null };
    return { kind: "handoff", code: handoff, pending };
  }
  if (error !== null) {
    // Only a trip this tab made is explained: a fragment from a link
    // someone sent is not this visitor's sign-in.
    if (!pending) return NO_RETURN;
    if (error === "cancelled") return { kind: "cancelled", pending };
    return { kind: "error", code: error, pending };
  }
  if (pending) return { kind: "unfinished", pending };
  return NO_RETURN;
}

/** The trip a return belongs to, if any. */
export const tripOf = (found: SocialReturn): PendingSocial | null => ("pending" in found ? found.pending : null);

const claimed = new WeakSet<object>();

/** True once per return: the screens may mount twice (React's strict
 * mode, a switch from Register to Sign in and back), and a handoff is
 * collected once. */
export function claim(found: SocialReturn): boolean {
  if (found.kind === "none" || claimed.has(found)) return false;
  claimed.add(found);
  return true;
}

/** The start URL for the web: the apps' (`startUrl`) with `client=web`. */
export function webStartUrl(base: string, provider: WebProvider, locale: string, challenge: string): string {
  return `${startUrl(base, provider, locale, challenge)}&client=web`;
}

export interface BeginDeps {
  pkce: typeof pkcePair;
  base: typeof socialStartBase;
  navigate: (url: string) => void;
  env: PageEnv;
  locale: () => string;
}

const browserDeps = (): BeginDeps => ({
  pkce: pkcePair,
  base: socialStartBase,
  navigate: (url) => window.location.assign(url),
  env: pageEnv(),
  locale: currentLanguage,
});

/**
 * Leaves for the provider. `left` once the browser has been sent;
 * `unsafe` when this browser cannot make the PKCE pair or keep its
 * verifier, in which case nothing is started: a web sign-in is never
 * one the code alone could collect, and the server refuses one without
 * a challenge anyway.
 *
 * The API address is the first that answers now, from the same list
 * sign-in uses (`socialStartBase`), bounded to a few seconds.
 */
export async function beginWebSocialSignIn(
  provider: WebProvider,
  carry: Pick<PendingSocial, "screen" | "voucher" | "plan">,
  deps: BeginDeps = browserDeps(),
): Promise<"left" | "unsafe"> {
  const pair = await deps.pkce();
  if (!pair || !deps.env.storage) return "unsafe";
  const base = await deps.base();
  const pending: PendingSocial = { provider, verifier: pair.verifier, ...carry, startedAt: deps.env.now() };
  try {
    deps.env.storage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    return "unsafe";
  }
  deps.navigate(webStartUrl(base, provider, deps.locale(), pair.challenge));
  return "left";
}
