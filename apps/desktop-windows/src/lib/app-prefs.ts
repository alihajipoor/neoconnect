import { load, type Store } from "@tauri-apps/plugin-store";

/** The device's own preferences for how the app behaves, from Settings:
 *
 *  - `autoConnect`: "Connect when Neoxify starts" (lib/auto-connect.ts);
 *  - `notifications`: "Notify me when the connection changes"
 *    (lib/connection-notify.ts);
 *  - `blockWhileReconnecting`: "Block the internet while reconnecting"
 *    (lib/reconnect-hold.ts), Windows only.
 *
 * The defaults are the owner's: nothing connects or blocks unless asked
 * (fail open, docs in desktop-full-capture), and notifications are on.
 *
 * In their own store, not the session's: they are this device's, not the
 * account's, and outlive a sign-out the way the language does. Read once
 * per run, then held here so every screen reads the same answer; a write
 * lands here at once and on disk best-effort. "Start with Windows" is not
 * here: Windows itself holds it (lib/autostart.ts). */

export interface AppPrefs {
  readonly autoConnect: boolean;
  readonly notifications: boolean;
  readonly blockWhileReconnecting: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  autoConnect: false,
  notifications: true,
  blockWhileReconnecting: false,
};

const STORE_FILE = "preferences.json";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise is not kept: one failed open must not break every
  // later save for the life of the process (failover-store.ts).
  storePromise ??= load(STORE_FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

let prefs: AppPrefs = DEFAULT_PREFS;
let loaded = false;
let loading: Promise<AppPrefs> | null = null;
/** Changes made before the store was read, which win over what it held. */
let changedMeanwhile: Partial<AppPrefs> = {};
const listeners = new Set<() => void>();

function publish(next: AppPrefs): void {
  prefs = next;
  for (const listener of [...listeners]) listener();
}

/** Only the three booleans, each only when it is one: a value of another
 * shape on disk reads as the default rather than as on. */
export function readPrefs(raw: unknown): AppPrefs {
  const from = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof AppPrefs) => (typeof from[key] === "boolean" ? (from[key] as boolean) : DEFAULT_PREFS[key]);
  return {
    autoConnect: flag("autoConnect"),
    notifications: flag("notifications"),
    blockWhileReconnecting: flag("blockWhileReconnecting"),
  };
}

export const appPrefs = {
  current(): AppPrefs {
    return prefs;
  },

  /** Whether the store has been read in this run. Until then `current`
   * is the defaults, which is what a decision taken at launch must not
   * act on (`load`). */
  loaded(): boolean {
    return loaded;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Reads the store once per run. An unreadable one is the defaults. */
  load(): Promise<AppPrefs> {
    if (loaded) return Promise.resolve(prefs);
    loading ??= getStore()
      .then((store) => store.get<unknown>("prefs"))
      .then(readPrefs, () => DEFAULT_PREFS)
      .then((read) => {
        // A change made while it was read wins over what was on disk.
        if (!loaded) {
          loaded = true;
          publish({ ...read, ...changedMeanwhile });
        }
        return prefs;
      });
    return loading;
  },

  /** Changes one, at once here and best-effort on disk. */
  async set<K extends keyof AppPrefs>(key: K, value: AppPrefs[K]): Promise<void> {
    if (!loaded) changedMeanwhile = { ...changedMeanwhile, [key]: value };
    publish({ ...prefs, [key]: value });
    try {
      const store = await getStore();
      await store.set("prefs", prefs);
      await store.save();
    } catch {
      // Kept for this run; the next one starts from what was saved.
    }
  },

  /** For tests: a fresh run. */
  resetForTests(): void {
    prefs = DEFAULT_PREFS;
    loaded = false;
    loading = null;
    storePromise = null;
    changedMeanwhile = {};
    listeners.clear();
  },
};

