import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { exitsForGames, groupMembers, type GameExitGroup } from "./game-apps";

/** Custom mode: route only the chosen applications through the tunnel.
 *
 * The selection lives on this machine and nowhere else. It is a local
 * preference about local software, not account state -- syncing it to
 * the backend would mean uploading a list of what the customer has
 * installed, for a feature that gains nothing from the server knowing.
 *
 * Its own store file rather than session.json, for the same reason
 * failover.json is: signing out should not erase which game someone
 * picked. */
/** Which way round the chosen list reads.
 *
 * Two opposite answers to "does this app use the VPN", so the wording in
 * the UI has to be unambiguous -- a customer who reads it backwards
 * sends the traffic they wanted hidden out in the clear. */
export type SplitTunnelMode = "onlySelected" | "allExcept";

/** The destinations one chosen application's traffic is narrowed to.
 *
 * Only ever built from a catalogue game whose prefix list the server
 * vouches for as complete -- see `canRouteByDestination`. There is no
 * way for a customer to type one of these in, and deliberately so: a
 * hand-written prefix list is a partial prefix list, and a partial list
 * splits a game's own connections across two source addresses. */
export type AppScope = {
  /** The executable this narrows, spelled exactly as it appears in
   * `apps`. */
  app: string;
  /** CIDR prefixes, IPv4 and IPv6 alike. */
  destinations: string[];
};

/** Which exit one chosen application's traffic should leave from.
 *
 * Path-keyed like `AppScope`, because that is what the service matches
 * on -- but unlike a scope it is **never built from a path**. The only
 * producer is `exitsForGames`, which emits every binary of one game or
 * none of them, and `group` carries the game it came from so the
 * service can hold the same rule independently.
 *
 * There is deliberately no per-application exit anywhere in this
 * client's persisted state. A customer cannot put a game's launcher and
 * its client on two exits because there is no field in which to say it.
 * `docs/design/ban-safety.md` mechanism 4: one game's connections
 * arriving from two source addresses at the same instant is the
 * account-sharing signature. */
export type AppExit = {
  /** The executable, spelled exactly as it appears in `apps`. */
  app: string;
  /** The exit identifier, as the backend spells it. Opaque here and
   * opaque in the service, which only ever compares it for equality. */
  exit: string;
  /** The catalogue slug of the game this binary belongs to. Always
   * present from this client: an entry with no group is a preference
   * for one executable that claims nothing about a game, which is
   * exactly what must not be expressible. */
  group: string;
};

export type SplitTunnelSettings = {
  enabled: boolean;
  /** Absolute paths to executables, as the picker returned them. */
  apps: string[];
  mode: SplitTunnelMode;
  /** Per-app destination narrowing, for the apps that have any.
   *
   * Sparse: an app absent from here is carried in full, which is what
   * this feature has always done and what every app added by hand will
   * keep doing. Kept alongside `apps` rather than inside it so that an
   * older build reading this file sees a selection it fully
   * understands, and a scope it simply ignores. */
  scopes: AppScope[];
  /** The games behind the chosen paths, and the exit each one should
   * leave from.
   *
   * Kept because `apps` alone has forgotten it. A game is routinely
   * several binaries -- Rust is its EAC wrapper plus `RustClient.exe`,
   * VALORANT is the Riot client plus the game plus two Vanguard
   * binaries -- and once a game's resolved paths are flattened into one
   * list, nothing can put those binaries on one exit together because
   * nothing knows they belong together any more.
   *
   * Sparse and additive on exactly the terms `scopes` is: apps added by
   * hand are in no group and simply have no preference, and an older
   * build reading this file sees a selection it fully understands and a
   * group list it ignores. */
  games: GameExitGroup[];
};

export const EMPTY_SPLIT_TUNNEL: SplitTunnelSettings = {
  enabled: false,
  apps: [],
  mode: "onlySelected",
  scopes: [],
  games: [],
};

/** Matches the service's own cap, so an over-long list is refused here
 * with an explanation rather than there with a validation error. */
export const MAX_APPS = 64;

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process.
  storePromise ??= load("split-tunnel.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "settings";

/** Reads stored scopes, taking each one whole or not at all.
 *
 * The all-or-nothing rule is the point. Everywhere else in this file a
 * malformed entry is filtered out and the rest kept, because a missing
 * app in a list of apps costs the customer a re-pick. A missing
 * *prefix* in a scope costs something else entirely: the app is still
 * carried, but now to only part of the address space it should reach,
 * so the game's own connections leave by two different paths from two
 * different addresses. Dropping the whole scope returns the app to
 * being carried in full, which is the state this feature shipped in for
 * a year and is safe by definition. */
function readScopes(stored: unknown): AppScope[] {
  if (!Array.isArray(stored)) return [];
  const out: AppScope[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    const { app, destinations } = entry as Partial<AppScope>;
    if (typeof app !== "string" || !app) continue;
    if (!Array.isArray(destinations) || destinations.length === 0) continue;
    if (!destinations.every((d) => typeof d === "string" && d.length > 0)) continue;
    out.push({ app, destinations });
  }
  return out;
}

/** Reads stored game groups, taking each one whole or not at all.
 *
 * The same all-or-nothing rule `readScopes` follows, for a sharper
 * version of the same reason. A scope that survives with half its
 * prefixes splits one game across two paths. A **group** that survives
 * with half its executable names is worse: it would read as complete,
 * and a complete group is exactly what earns a per-game exit. The
 * binaries the truncated read dropped would then be carried somewhere
 * else entirely while the group reported itself whole.
 *
 * So a malformed entry drops the whole group, which returns that game
 * to having no exit preference -- the state every game was in before
 * this existed, and safe by definition. */
export function readGames(stored: unknown): GameExitGroup[] {
  if (!Array.isArray(stored)) return [];
  const out: GameExitGroup[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    const { slug, displayName, names, exit } = entry as Partial<GameExitGroup>;
    if (typeof slug !== "string" || !slug) continue;
    if (typeof displayName !== "string" || !displayName) continue;
    if (!Array.isArray(names) || names.length === 0) continue;
    if (!names.every((n) => typeof n === "string" && n.length > 0)) continue;
    // `null` and a string are the two things this may be. Anything else
    // is a file this build did not write, and reading an unknown value
    // as an exit identifier would name an exit nobody chose.
    if (exit !== null && (typeof exit !== "string" || exit.length === 0)) continue;
    // One row per game. A duplicate slug would put one game in two
    // groups, which is the split this whole feature refuses, arriving
    // through the store file.
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, displayName, names: [...names], exit: exit ?? null });
  }
  return out;
}

/** The groups that still have a chosen app in them.
 *
 * A game whose every binary the customer removed is not a game they
 * chose any more, and leaving the group behind would silently reapply
 * its exit the day they re-added one of those binaries by hand.
 *
 * A group that loses *some* of its binaries is deliberately kept. It is
 * now partial, and `exitsForGames` withholds its exit for that reason
 * and says so -- which is the honest outcome, and better than
 * forgetting the customer ever chose an exit for that game. */
export function gamesFor(apps: string[], games: GameExitGroup[]): GameExitGroup[] {
  return games.filter((game) => groupMembers(game, apps).length > 0);
}

/** The scopes that still describe a chosen app.
 *
 * Removing an app has to remove its scope with it. Left behind, the
 * scope is inert today -- the service drops scopes naming an app that
 * is not selected -- but it would come back to life the moment the
 * customer re-added that app by hand, silently narrowing a selection
 * they made expecting the ordinary behaviour. */
export function scopesFor(apps: string[], scopes: AppScope[]): AppScope[] {
  const chosen = new Set(apps.map((a) => a.toLowerCase()));
  return scopes.filter((s) => chosen.has(s.app.toLowerCase()));
}

/** Whether this chosen app is narrowed to particular destinations. */
export function scopeOf(settings: SplitTunnelSettings, path: string): AppScope | undefined {
  const lowered = path.toLowerCase();
  return settings.scopes.find((s) => s.app.toLowerCase() === lowered);
}

export async function loadSplitTunnel(): Promise<SplitTunnelSettings> {
  try {
    const store = await getStore();
    const stored = await store.get<SplitTunnelSettings>(KEY);
    if (!stored) return EMPTY_SPLIT_TUNNEL;
    // Read defensively: this file is on disk between versions, and a
    // malformed `apps` would otherwise reach the service as a bad
    // request on every connect.
    return {
      enabled: Boolean(stored.enabled),
      apps: Array.isArray(stored.apps) ? stored.apps.filter((a) => typeof a === "string") : [],
      // An upgrade reads a file written before the direction existed,
      // and the only safe reading is the behaviour that file was saved
      // under.
      mode: stored.mode === "allExcept" ? "allExcept" : "onlySelected",
      // Read at least as defensively as `apps`, and for a sharper
      // reason. A malformed entry here does not merely fail
      // validation -- a scope that survives with half its prefixes is
      // exactly the partial list that splits a game across two source
      // addresses. So an entry is taken whole or not at all: any
      // non-string destination and the entire scope is dropped, which
      // returns that app to being carried in full.
      scopes: readScopes(stored.scopes),
      // Whole or not at all, and for a sharper reason than `scopes`.
      // See `readGames`.
      games: readGames(stored.games),
    };
  } catch {
    return EMPTY_SPLIT_TUNNEL;
  }
}

export async function saveSplitTunnel(settings: SplitTunnelSettings): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, settings);
    await store.save();
  } catch {
    // Best-effort, like every other preference here. Losing it costs the
    // customer a re-pick, and failing the screen over it would be out of
    // proportion.
  }
}

/** Tells the helper service the current selection.
 *
 * Called when the setting changes *and* before every connect. The second
 * is not redundant: the service is a Windows service with its own
 * lifetime, so it can restart underneath a running app and come back
 * knowing nothing. Re-sending is cheap and removes the whole class of
 * "Custom mode silently stopped applying". */
export async function pushSplitTunnel(
  settings: SplitTunnelSettings,
  /** The exit the tunnel that is about to carry -- or is already
   * carrying -- this traffic actually leaves from, named with the same
   * opaque handle a `GameExitGroup` holds.
   *
   * `null` is the honest default and the value every caller sends
   * before a connection exists. It is not "unknown, assume fine": the
   * service reports a preference it cannot compare as `Unknown`, never
   * as a match, and naming an egress here while nothing is established
   * would be asserting a fact nobody checked.
   *
   * Only the connect path, once a candidate has actually come up,
   * passes one. The service knows which adapter is up and which address
   * is on it; it does not know and cannot work out which node the far
   * end egresses from, and on a relayed route those are different
   * machines. */
  egress: string | null = null,
): Promise<void> {
  await invoke("vpn_set_split_tunnel", {
    enabled: settings.enabled,
    apps: settings.apps,
    mode: settings.mode,
    // Filtered on the way out as well as when an app is removed. The
    // service ignores a scope naming an app it was not given, so this
    // is belt and braces -- but the two lists disagreeing is precisely
    // the kind of thing that is harmless until one day it is not, and
    // this is the last place either of them can be checked against the
    // other.
    scopes: scopesFor(settings.apps, settings.scopes),
    // Derived, never stored. `exitsForGames` is the only producer of an
    // `AppExit` in this client and it emits a game's binaries together
    // or not at all, so there is no path from here to a config that
    // puts one game's launcher and its client on two exits.
    //
    // What it withholds is not reported from here -- this function is
    // called before every connect and a notice raised here would fire
    // at a moment the customer is not looking at the screen. The card
    // asks `exitsForGames` for the same answer when the selection
    // changes, which is when they are.
    exits: exitsForGames(settings.games, settings.apps).exits,
    // The other half of the comparison, and the reason it travels with
    // the selection rather than separately: two values that have to
    // agree should not be able to arrive out of step.
    //
    // Re-sent on every push, so it is *replaced* rather than merged --
    // which is what the service does with it. A push naming none means
    // this client is not asserting an egress now, and keeping the last
    // one would report a stale exit for a tunnel that may have been
    // rebuilt against a different node entirely.
    egress,
  });
}

/** One running application, as the service reports it. */
export type RunningApp = {
  /** The executable shown for this entry. */
  path: string;
  /** The product's name, not the file's. */
  name: string;
  /** Every executable belonging to the same product.
   *
   * Choosing an app has to mean the whole of it. Discord runs
   * `Discord.exe` and `Update.exe`, and someone who picks "Discord"
   * means both -- picking one and getting half the program routed is
   * indistinguishable from the feature not working. */
  paths?: string[];
  /** The executable's icon as a base64 PNG -- the same one the taskbar
   * shows. Absent when the shell had none, in which case the picker
   * draws a placeholder rather than a broken image. */
  icon?: string;
};

/** What is running right now, for choosing from a list.
 *
 * Asked of the service rather than gathered here: this app is not
 * elevated and cannot read the image path of a process it does not own,
 * and the path is what a selection is made of. */
export async function listRunningApps(): Promise<RunningApp[]> {
  return await invoke<RunningApp[]>("vpn_list_running_apps");
}

/** Whether the setting will actually change how the next tunnel behaves.
 *
 * On with nothing chosen is a real state -- the customer flipped the
 * toggle and has not picked an app yet -- and it deliberately does
 * nothing rather than tunnelling everything. The UI has to say so, or
 * the toggle reads as broken. */
export function isEffective(settings: SplitTunnelSettings): boolean {
  return settings.enabled && settings.apps.length > 0;
}

/** The last path segment, for display. Full paths are far too long for
 * a list and their interesting part is at the end. */
export function appName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}
