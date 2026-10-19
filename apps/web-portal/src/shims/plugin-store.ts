/**
 * Browser stand-in for @tauri-apps/plugin-store.
 *
 * The shared screens persist session tokens, the remembered API
 * endpoint, the chosen route and a few preferences through this API.
 * On the desktop it is a JSON file in the app's data directory; here it
 * is localStorage, namespaced by the store name so two stores cannot
 * collide.
 *
 * Session tokens therefore live in localStorage, which is readable by
 * any script that manages to run on this origin. That is the standard
 * trade for a browser client and is worth stating plainly rather than
 * leaving implied: the page loads no third-party scripts and has no
 * user-generated HTML, which is what keeps it reasonable. The tokens
 * are also short-lived and revocable (tokenVersion), so the blast
 * radius is a session rather than an account.
 */
export class Store {
  constructor(private readonly name: string) {}

  private key(key: string): string {
    return storageKey(this.name, key);
  }

  // `undefined`, not `null`, for a missing key -- that is what Tauri's
  // real Store returns, and the shared code is typed against it. Getting
  // this wrong compiled here but failed the portal's own `tsc -b`, which
  // is what `pnpm build` runs.
  async get<T>(key: string): Promise<T | undefined> {
    const raw = localStorage.getItem(this.key(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value written by an older build, or hand-edited. Treated as
      // absent rather than thrown, matching the desktop store's
      // behaviour of degrading to "no session" instead of trapping the
      // app on its loading screen.
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    localStorage.setItem(this.key(key), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.key(key));
  }

  /** No-op: localStorage is already durable. Kept so shared callers can
   * go on calling save() unchanged. */
  async save(): Promise<void> {}
}

function storageKey(name: string, key: string): string {
  return `neoxify:${name}:${key}`;
}

/** What a store holds under a key, read at once rather than through the
 * async API the shared code uses.
 *
 * For the portal's own first paint only: the sign-in page reads the
 * language the visitor chose, so it can wait for the shared provider to
 * restore it instead of drawing a frame in the other language first.
 * Never throws; anything unreadable is `undefined`, as in get(). */
export function peek<T>(name: string, key: string): T | undefined {
  try {
    const raw = localStorage.getItem(storageKey(name, key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export async function load(name: string, _options?: unknown): Promise<Store> {
  return new Store(name);
}
