import { invoke } from "@tauri-apps/api/core";

import { API_BASE_URL } from "./config";

/** Getting a customer through a provider's sign-in, per platform.
 *
 * This module is only the trip out to the provider and back. What comes
 * home is one of two things, and neither is a session:
 *
 *  - Apple on iOS hands back an identity token from the native sheet,
 *    which `socialSignIn()` in auth.ts posts to /customer-auth/social.
 *  - Google and Facebook hand back a one-time handoff code, because the
 *    exchange that produced the session happened on our server -- see
 *    OauthFlowService for why the client never touches those.
 *
 * The split is not cosmetic. Apple's native sheet needs no browser, no
 * client secret and no round trip; Google and Facebook need a client
 * secret that must not ship in a binary anyone can unzip.
 */

export type SocialProvider = "google" | "apple" | "facebook";

export type SocialOutcome =
  | { kind: "apple-token"; token: string }
  | { kind: "handoff"; code: string };

/** Which platform this build is running on.
 *
 * The same user-agent test `apps/mobile/src/lib/platform.ts` uses, and
 * for the same reason: both clients run in a system webview and a wrong
 * guess here costs a button that opens the wrong kind of browser, not a
 * broken connection. Repeated rather than imported because that file
 * lives in the mobile app and this one is shared with the desktop
 * build, which cannot see it.
 */
const isAndroid = (): boolean => /android/i.test(navigator.userAgent);

const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const isMobile = (): boolean => isAndroid() || isIOS();

/** Whether Sign in with Apple can be offered here.
 *
 * iOS only, and not because of preference. The native sheet is an iOS
 * API; everywhere else Sign in with Apple means the web flow, which
 * needs a Services ID and a signing key we have not set up. A button
 * that opens a flow we cannot complete is worse than no button, so the
 * check is positive -- "is this the platform where it works" -- rather
 * than a list of platforms to exclude, which silently says yes on the
 * next platform added.
 */
export const appleSignInAvailable = (): boolean => isIOS();

/** How long to wait for the customer to finish at the provider.
 *
 * Generous on purpose: this covers reading a consent screen, signing in
 * to an account they are not signed in to, and answering a two-factor
 * prompt. It exists so a browser the customer abandoned without
 * cancelling does not leave the button spinning forever, not to hurry
 * anyone. Comfortably inside the server's own ten-minute state window,
 * so a flow that survives this one is still redeemable.
 */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** The URL that starts the browser flow.
 *
 * Deliberately pointed at whichever API base the app is already talking
 * to, so a client on a mirror does not send the customer to an endpoint
 * its network cannot reach.
 */
function startUrl(provider: "google" | "facebook", locale: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/customer-auth/social/${provider}/start?locale=${encodeURIComponent(locale)}`;
}

/** Pulls the result out of the callback the browser came back with.
 *
 * `neoconnect://social-callback?handoff=...` on success, `?error=...`
 * on anything else. A cancelled sheet is reported as a cancellation
 * rather than a failure, because telling somebody their sign-in went
 * wrong immediately after they pressed Cancel is both wrong and
 * alarming.
 */
export function readCallback(raw: string): SocialOutcome | null {
  const url = new URL(raw);
  const error = url.searchParams.get("error");
  if (error) {
    if (error === "cancelled") return null;
    const detail = url.searchParams.get("detail");
    throw new Error(detail ?? "That sign-in did not work. Please try again.");
  }
  const code = url.searchParams.get("handoff");
  if (!code) throw new Error("That sign-in did not work. Please try again.");
  return { kind: "handoff", code };
}

/** Opens the provider's page and waits for the callback.
 *
 * Three different mechanisms, one signature:
 *
 *  - iOS uses ASWebAuthenticationSession, which is the only way to get
 *    a browser with the customer's existing provider cookies and still
 *    catch the custom-scheme callback. It needs nothing registered in
 *    Info.plist; the scheme is passed in and the system intercepts it.
 *  - Android uses a Custom Tab over the same scheme, claimed by an
 *    intent filter in the manifest.
 *  - Windows opens the real browser, because it has no equivalent, and
 *    listens for the `neoconnect://` link the deep-link plugin already
 *    registers and forwards -- the same path the "Open in Neoxify"
 *    button in the verification email takes.
 */
async function openAuthSession(url: string): Promise<string | null> {
  if (isMobile()) {
    // Returns null when the customer dismissed the sheet.
    return await invoke<string | null>("vpn_open_auth_session", {
      url,
      scheme: "neoconnect",
    });
  }
  return await openAuthSessionDesktop(url);
}

async function openAuthSessionDesktop(url: string): Promise<string | null> {
  const [{ openUrl }, { onOpenUrl }] = await Promise.all([
    import("@tauri-apps/plugin-opener"),
    import("@tauri-apps/plugin-deep-link"),
  ]);

  return await new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      resolve(value);
    };

    onOpenUrl((urls) => {
      const hit = urls.find((u) => u.startsWith("neoconnect://social-callback"));
      if (hit) finish(hit);
    })
      .then((stop) => {
        unlisten = stop;
        // Only listen first, then open. Opening first is a race the
        // browser can win on a fast local redirect, and the callback
        // would arrive before anything was listening for it.
        if (settled) {
          stop();
          return;
        }
        timer = setTimeout(() => finish(null), AUTH_TIMEOUT_MS);
        return openUrl(url);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unlisten?.();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** Runs the provider's sign-in and returns what came back.
 *
 * `null` means the customer cancelled, which is not an error and must
 * not be shown as one.
 */
export async function startSocialSignIn(
  provider: SocialProvider,
  locale: string,
): Promise<SocialOutcome | null> {
  if (provider === "apple") {
    if (!appleSignInAvailable()) {
      throw new Error("Sign in with Apple is not available on this device.");
    }
    const result = await invoke<{ identityToken: string | null }>("vpn_sign_in_with_apple");
    // The sheet was dismissed. Apple reports that as an error code
    // rather than a result, and the plugin turns it into a null token.
    if (!result.identityToken) return null;
    return { kind: "apple-token", token: result.identityToken };
  }

  const callback = await openAuthSession(startUrl(provider, locale));
  if (callback === null) return null;
  return readCallback(callback);
}
