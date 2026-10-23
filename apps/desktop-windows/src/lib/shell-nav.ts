import type { Language, TranslationKey } from "./i18n";
import { formatNumber } from "./locale-format";

/** What the signed-in shell's pages share with the main page, in memory.
 *
 * The main page (Dashboard) reads the account and the plan; the other pages
 * of the shell -- Activity, Settings, Plans, Support, Invite friends -- show
 * the same avatar line without reading them again, so they take the last
 * thing the main page showed. Kept as values, not as the sentence: worded
 * as each page renders (`planLineText`), so a language switched in
 * Settings, inside the shell, re-words it at once. Nothing here is stored
 * or sent.
 *
 * "Locations" pressed on one of those pages leads back to the main page,
 * which shows its Locations page once it has loaded: the request waits
 * here for it. */

/** What the line under the avatar is made of: the days left, and whether
 * the plan has no data cap. */
export interface ShellPlan {
  daysLeft: number | null;
  unlimited: boolean;
}

export interface ShellProfile {
  email: string | null;
  /** The plan as under the avatar; null with no subscription. */
  plan: ShellPlan | null;
  /** The network the main page's map reads this device's history for
   * (lib/map-network.ts): null when it is not known; absent before the main
   * page has said. The Activity page falls back on it -- only while the way
   * out is the one the main page last saw (`lastWayOut`) -- when it cannot
   * read the network itself. */
  network?: string | null;
}

let profile: ShellProfile = { email: null, plan: null };
let wayOut: string | null = null;
let locationsRequested = false;

/** The sidebar's line under the email: the days left first -- the useful
 * part, which a narrow sidebar used to cut off -- then "Unlimited" when it
 * says something; "Plan" when neither is known. Null with no plan. */
export function planLineText(
  plan: ShellPlan | null,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  language: Language,
): string | null {
  if (!plan) return null;
  const parts = [
    plan.daysLeft !== null ? t(plan.daysLeft === 1 ? "tr.dayLeft" : "tr.daysLeft", { n: formatNumber(plan.daysLeft, language) }) : null,
    plan.unlimited ? t("dash.unlimited") : null,
  ].filter(Boolean);
  return parts.join(" · ") || t("tr.plan");
}

export function rememberShellProfile(next: ShellProfile): void {
  profile = next;
}

export function shellProfile(): ShellProfile {
  return profile;
}

/** Forgotten at sign-out, so the next account never shows the last one's. */
export function forgetShellProfile(): void {
  profile = { email: null, plan: null };
  wayOut = null;
}

/** The main page's latest look at the machine's ways out
 * (`network_uplinks`), under a tunnel or with nothing up. A look that could
 * not be made is not news. */
export function noteWayOut(seen: string | null): void {
  if (seen !== null) wayOut = seen;
}

/** What the main page last saw of the ways out; null before it has looked. */
export function lastWayOut(): string | null {
  return wayOut;
}

/** Which network the pages outside the main page may read this device's
 * history under (Activity).
 *
 * Asked again, not taken from the main page: the main page is not drawn
 * while another page is, so a roam meanwhile went unseen, and its network
 * was the old one's. Only when the network cannot be read now -- under a
 * tunnel, which owns the default route, the fingerprint cannot be read at
 * all -- is the main page's taken, and then only while the way out is the
 * one it last saw: another one, or none, is a network nobody has asked
 * about, and nothing is shown for it. */
export async function currentNetwork(
  readNetwork: () => Promise<string | null>,
  readWayOut?: () => Promise<string | null>,
): Promise<string | null> {
  const fresh = await readNetwork().catch(() => null);
  if (fresh !== null) return fresh;
  const said = profile.network;
  const seen = wayOut;
  if (said === undefined || said === null || seen === null || seen === "" || !readWayOut) return null;
  const now = await readWayOut().catch(() => null);
  return now === seen ? said : null;
}

/** The screens of the signed-in shell, as the apps' screen machines name
 * them: the main page and the pages drawn in its shell. */
export const SIGNED_IN_SCREENS: readonly string[] = ["dashboard", "settings", "activity", "plans", "referrals", "support"];

export function isSignedInScreen(screen: string): boolean {
  return SIGNED_IN_SCREENS.includes(screen);
}

/** What the transition between screens (ScreenTransition) is keyed by:
 * every screen of the signed-in shell as the main page. The main page's
 * screen draws the others in its own shell and stays mounted under them,
 * so a change between them is never a remount -- which put "Loading..."
 * over the whole window, then "Connected, not confirmed", no route and no
 * location list over a tunnel that had not changed (VM, 2026-10-20). The
 * app animates those changes itself (`swapView`). */
export function transitionKey(screen: string): string {
  return isSignedInScreen(screen) ? "dashboard" : screen;
}

export function requestLocations(): void {
  locationsRequested = true;
}

/** Whether a request is waiting, clearing it. */
export function takeLocationsRequest(): boolean {
  const asked = locationsRequested;
  locationsRequested = false;
  return asked;
}
