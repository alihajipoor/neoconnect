import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

/** Custom mode on Android: route only the chosen apps through the tunnel.
 *
 * The same feature as the Windows client's, and almost none of the same
 * code. There it needed WinDivert, a packet-rewriting redirector, a
 * transparent proxy and sockets pinned with IP_UNICAST_IF -- weeks of
 * work, and three failed mechanisms before one held. Here the platform
 * does it: `VpnService.Builder.addAllowedApplication(pkg)` tells the OS
 * which apps the TUN device receives traffic from, and everything else
 * keeps using the normal connection.
 *
 * One consequence worth stating, because it is a genuine improvement
 * rather than a difference: the Windows implementation had to fail open
 * while reconnecting, since a redirector with no tunnel to redirect into
 * has to let packets past. Android's allow-list is a property of the TUN
 * device, so when there is no tunnel there is nothing to leak through --
 * selected apps simply have no VPN, exactly as if it were switched off.
 *
 * The selection is local, like the Windows one, and for a stronger
 * reason: it is a list of what the customer has installed. That belongs
 * on their device and nowhere else.
 */
export interface InstalledApp {
  packageName: string;
  label: string;
  /** A data: URI of the launcher icon, or null when the app has none.
   * Built on the Kotlin side because reading a package's icon needs the
   * PackageManager. */
  icon: string | null;
}

export interface PerAppSettings {
  enabled: boolean;
  /** Package names, e.g. "com.mojang.minecraftpe". Never paths -- Android
   * apps do not have a stable executable path the way Windows ones do,
   * and the package name is the identity the platform's own API takes. */
  packages: string[];
}

export const EMPTY_PER_APP: PerAppSettings = { enabled: false, packages: [] };

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process.
  storePromise ??= load("per-app.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

const KEY = "settings";

export async function loadPerApp(): Promise<PerAppSettings> {
  try {
    const store = await getStore();
    const stored = await store.get<PerAppSettings>(KEY);
    if (!stored) return EMPTY_PER_APP;
    // Read defensively: this file survives between versions, and a
    // malformed list would otherwise reach the VpnService builder, where
    // an unknown package name throws and takes the whole connect with it.
    return {
      enabled: Boolean(stored.enabled),
      packages: Array.isArray(stored.packages)
        ? stored.packages.filter((p) => typeof p === "string")
        : [],
    };
  } catch {
    return EMPTY_PER_APP;
  }
}

export async function savePerApp(settings: PerAppSettings): Promise<void> {
  const store = await getStore();
  await store.set(KEY, settings);
  await store.save();
}

/** The packages to hand the tunnel, or an empty list meaning "everything".
 *
 * Enabled with nothing selected resolves to a full tunnel rather than to
 * an empty allow-list. An empty allow-list on Android is not "no apps" --
 * it is a VpnService that routes nothing, which looks from the outside
 * exactly like a tunnel that silently stopped working.
 */
export async function loadAllowedApps(): Promise<string[]> {
  const settings = await loadPerApp();
  return settings.enabled && settings.packages.length > 0 ? settings.packages : [];
}

/** What the customer can choose from.
 *
 * Only apps that can actually reach the network -- the launcher shows
 * plenty that never open a socket, and offering those is a list to scroll
 * past rather than a choice to make. Filtered on the Kotlin side by
 * INTERNET permission, where the PackageManager already has the answer.
 */
export const listInstalledApps = () => invoke<{ apps: InstalledApp[] }>("vpn_list_apps").then((r) => r.apps);
