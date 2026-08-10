import { load, type Store } from "@tauri-apps/plugin-store";
import type { ProtocolUser, RouteOption, Subscription } from "./types";

/** The last known good answer from the control plane, kept so the app can
 * connect without it.
 *
 * The reason this exists is the reason protocol failover exists, one
 * layer down. A customer whose subscription has not changed in weeks, and
 * whose nodes are perfectly reachable, could not connect at all if the
 * API was unreachable -- the app asked for credentials it had already
 * been given, failed, and stopped. That happened for real: the panel's
 * address was filtered in Iran and the product was dead for everyone
 * there, on every protocol, on every node.
 *
 * An unreachable control plane should cost the things that genuinely need
 * a server -- buying a plan, seeing today's usage, switching servers --
 * and nothing else. Connecting is not one of them: since every route a
 * plan allows is provisioned up front, the credentials in hand are
 * already the whole ladder.
 *
 * On what is stored: these are the same secrets the app already writes to
 * disk to connect at all -- a WireGuard private key ends up in a config
 * file either way -- and they sit in the app's own data directory beside
 * session.json, with the same per-user file permissions. The exposure is
 * not new. What is new is that they survive the app closing, which is the
 * entire point.
 */
export interface ConnectionSnapshot {
  /** Bumped when the shape changes, so an older cache is discarded rather
   * than misread. Cheaper than migrating something that rebuilds itself
   * on the next successful fetch. */
  version: 1;
  savedAt: number;
  subscription: Subscription | null;
  protocolUsers: ProtocolUser[];
  routes: RouteOption[];
}

const VERSION = 1 as const;
const KEY = "snapshot";

/** Its own file rather than session.json.
 *
 * Signing out clears the session; it must also clear this, and keeping
 * them separate makes that an explicit decision rather than a side
 * effect of how one file happens to be written. */
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // breaks saving for the life of the process.
  storePromise ??= load("connection-cache.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** Records what the server just said. Best-effort: a cache that cannot be
 * written must never fail the fetch that succeeded. */
export async function saveSnapshot(
  snapshot: Omit<ConnectionSnapshot, "version" | "savedAt">,
): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, { ...snapshot, version: VERSION, savedAt: Date.now() });
    await store.save();
  } catch {
    // Nothing to do and nothing worth telling the customer: the app is
    // working, it simply will not have this to fall back on later.
  }
}

/** The last good answer, or null.
 *
 * Read defensively. This file survives across app versions and is the
 * input to the connect path, so a malformed or partial cache has to
 * become "no cache" rather than a half-populated object that fails
 * somewhere further in with a confusing message.
 */
export async function loadSnapshot(): Promise<ConnectionSnapshot | null> {
  try {
    const store = await getStore();
    const stored = await store.get<ConnectionSnapshot>(KEY);
    if (!stored || stored.version !== VERSION) return null;
    if (!Array.isArray(stored.protocolUsers) || stored.protocolUsers.length === 0) return null;
    // A credential with no connection block cannot build a tunnel, and
    // one that got that far would fail with a missing-field error rather
    // than an honest "no saved servers".
    if (!stored.protocolUsers.every((u) => u && u.connection && u.protocol)) return null;
    return {
      version: VERSION,
      savedAt: typeof stored.savedAt === "number" ? stored.savedAt : 0,
      subscription: stored.subscription ?? null,
      protocolUsers: stored.protocolUsers,
      routes: Array.isArray(stored.routes) ? stored.routes : [],
    };
  } catch {
    return null;
  }
}

/** Forgets everything. Called on sign-out: leaving one customer's
 * credentials on the machine for the next person to connect with is not
 * a cache, it is a leak. */
export async function clearSnapshot(): Promise<void> {
  try {
    const store = await getStore();
    await store.delete(KEY);
    await store.save();
  } catch {
    // Same reasoning as save: nothing useful to do about it here.
  }
}
