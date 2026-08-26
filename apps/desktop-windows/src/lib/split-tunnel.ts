import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

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
};

export const EMPTY_SPLIT_TUNNEL: SplitTunnelSettings = {
  enabled: false,
  apps: [],
  mode: "onlySelected",
  scopes: [],
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
export async function pushSplitTunnel(settings: SplitTunnelSettings): Promise<void> {
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
