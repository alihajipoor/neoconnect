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
export type SplitTunnelSettings = {
  enabled: boolean;
  /** Absolute paths to executables, as the file picker returned them. */
  apps: string[];
};

export const EMPTY_SPLIT_TUNNEL: SplitTunnelSettings = { enabled: false, apps: [] };

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
  await invoke("vpn_set_split_tunnel", { enabled: settings.enabled, apps: settings.apps });
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
