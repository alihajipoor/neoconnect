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
    return `neoxify:${this.name}:${key}`;
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

export async function load(name: string, _options?: unknown): Promise<Store> {
  return new Store(name);
}
