import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { withTimeout } from "./service-call";
import type { GameProfileSummary, GamingProfileResponse } from "./customer";
import type { TranslationKey } from "./i18n";

/** Gaming mode: namespace-scoped DNS rules for the game services a
 * customer picked, and nothing else.
 *
 * The thing to hold on to while reading anything below: **this brings up
 * no tunnel and no adapter.** It installs resolver rules for named
 * hostnames -- launcher, login, patching, store -- and the game's own
 * connections are left on the direct path by construction. The machine's
 * exit address is unchanged, which is why the exit-IP pill is not
 * rendered in this mode and why a line saying so is always on screen.
 *
 * So "Connected" has nothing it could truthfully mean here, and this
 * module deliberately does not use `ConnectionState`. It has its own
 * five-value phase, and every one of them is reported by the service
 * rather than inferred from whether the customer flipped a switch.
 */

/** Which mode the app is in.
 *
 * Persisted beside the chosen games rather than in session.json, for the
 * same reason the split-tunnel selection is: signing out should not
 * silently move somebody back to full-tunnel VPN without telling them.
 */
export type AppMode = "vpn" | "gaming";

/** What gaming mode is doing, as the *service* reports it.
 *
 * `active` is claimable only when the rules are present, the canary
 * resolved to the proxy, and the proxy answered a TCP connect. Anything
 * less is `partial`, which says so in plain words. `unknown` means the
 * service could not be asked at all and is never folded into `off` --
 * failing to ask a question is reported as not knowing the answer, not
 * as a negative answer.
 */
export type GamingPhase = "off" | "arming" | "active" | "partial" | "unknown";

export interface GamingStatus {
  state: GamingPhase;
  detail?: string;
  rulesPresent: boolean;
  canaryOk: boolean;
  proxyReachable: boolean;
  namespaces: string[];
}

/** What the service needs to install the rules. Built here from the
 * server-curated profile plus the customer's chosen games -- the client
 * invents none of it. */
export interface GamingConfig {
  dohUrl: string;
  proxyIp: string;
  proxyPort: number;
  namespaces: string[];
  excludeHostnames: string[];
  canaryHostname: string | null;
}

/** The state this app shows when it has not been able to ask. Not `off`:
 * see `GamingPhase`. */
export const UNKNOWN_STATUS: GamingStatus = {
  state: "unknown",
  rulesPresent: false,
  canaryOk: false,
  proxyReachable: false,
  namespaces: [],
};

export async function gamingArm(config: GamingConfig): Promise<GamingStatus> {
  return await withTimeout(invoke<GamingStatus>("gaming_arm", { config }), "gaming_arm");
}

export async function gamingDisarm(): Promise<void> {
  await withTimeout(invoke<void>("gaming_disarm"), "gaming_disarm");
}

export async function gamingStatus(): Promise<GamingStatus> {
  return await withTimeout(invoke<GamingStatus>("gaming_status"), "gaming_status");
}

export type GamingSettings = {
  mode: AppMode;
  /** Slugs from the server's game list, not display names -- the list is
   * curated server-side and its names can be corrected without orphaning
   * somebody's selection. */
  games: string[];
};

export const EMPTY_GAMING: GamingSettings = { mode: "vpn", games: [] };

/** A cap on the chosen list, so a runaway selection cannot hand the
 * service a namespace set large enough to matter. Every game contributes
 * several hostnames. */
export const MAX_GAMES = 16;

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process -- same reasoning as
  // split-tunnel.ts.
  storePromise ??= load("gaming.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "settings";

export async function loadGaming(): Promise<GamingSettings> {
  try {
    const store = await getStore();
    const stored = await store.get<GamingSettings>(KEY);
    if (!stored) return EMPTY_GAMING;
    // Read defensively: this file survives across versions, and a
    // malformed list would otherwise reach the service on every arm.
    return {
      mode: stored.mode === "gaming" ? "gaming" : "vpn",
      games: Array.isArray(stored.games)
        ? stored.games.filter((g): g is string => typeof g === "string")
        : [],
    };
  } catch {
    return EMPTY_GAMING;
  }
}

export async function saveGaming(settings: GamingSettings): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, settings);
    await store.save();
  } catch {
    // Best-effort, like every other preference here. Losing it costs a
    // re-pick; failing the screen over it would be out of proportion.
  }
}

/** The chosen games, in the order the server listed them.
 *
 * Resolved against the profile rather than trusted from disk: a game can
 * be withdrawn from the curated list, and a slug with nothing behind it
 * must not silently contribute an empty namespace set. */
export function chosenGames(
  profile: GamingProfileResponse | null,
  slugs: string[],
): GameProfileSummary[] {
  if (!profile) return [];
  const wanted = new Set(slugs);
  return profile.games.filter((g) => wanted.has(g.slug));
}

/** Hostnames are matched case-insensitively and a duplicate rule is just
 * a second chance to get the teardown wrong, so the set is normalised
 * and sorted before it ever reaches the service. */
function namespaceSet(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))].sort();
}

/** What the service will be asked to install, or null when there is
 * nothing honest to ask for.
 *
 * Null in two cases, both of which the UI has to state rather than
 * paper over: no resolver on this customer's server, and no game chosen.
 * Gaming mode with nothing chosen does nothing at all, and a switch that
 * looks on while redirecting nothing is the same lie as a false
 * "Connected".
 */
export function buildGamingConfig(
  profile: GamingProfileResponse | null,
  slugs: string[],
): GamingConfig | null {
  if (!profile?.resolver) return null;
  const games = chosenGames(profile, slugs);
  if (games.length === 0) return null;

  const namespaces = namespaceSet(games.flatMap((g) => g.hostnames));
  if (namespaces.length === 0) return null;

  return {
    dohUrl: profile.resolver.dohUrl,
    proxyIp: profile.resolver.proxyIp,
    proxyPort: profile.resolver.proxyPort,
    namespaces,
    excludeHostnames: namespaceSet(games.flatMap((g) => g.excludeHostnames)),
    // One canary is enough to answer "did a lookup actually reach us",
    // and the first game that offers one provides it. A profile with
    // none leaves `canaryOk` unprovable, which the service reports as
    // `partial` rather than as success.
    canaryHostname: games.find((g) => g.canaryHostname)?.canaryHostname ?? null,
  };
}

/** Whether turning gaming mode on would actually do anything. */
export function isEffective(
  profile: GamingProfileResponse | null,
  slugs: string[],
): boolean {
  return buildGamingConfig(profile, slugs) !== null;
}

/** The server's reason, turned into a sentence -- never a reason of our
 * own invention.
 *
 * `null` when the server said the customer is entitled and gave a
 * resolver, in which case there is nothing to explain. */
export function unavailableKey(profile: GamingProfileResponse | null): TranslationKey | null {
  if (!profile) return null;
  switch (profile.unavailableReason) {
    case "noSubscription":
      return "gaming.needsPlan";
    case "notEntitled":
      return "gaming.notInPlan";
    case "noResolver":
      return "gaming.noResolver";
    default:
      // Entitled with no resolver is the same dead end as `noResolver`
      // and gets the same sentence, because the customer's situation is
      // identical: there is nothing on their server to point at.
      return profile.entitled && !profile.resolver ? "gaming.noResolver" : null;
  }
}
