/** The server's "this session is over", delivered to whoever owns the
 * screen.
 *
 * A refused token refresh used to clear the stored tokens and then tell
 * only the request that happened to trip over it. One caller -- the
 * Dashboard's first load -- turned that into a sign-out; every other one
 * (the pre-connect config refresh, the refresh on resume, the gaming
 * profile) swallowed it. The app was then signed out on disk and signed
 * in on screen, with the tunnel up, until it was next restarted.
 *
 * A listener rather than an import of the App's handler, because
 * `api.ts` sits under every screen and must not depend on any of them.
 * Its own module so that it has no imports at all, which keeps it out of
 * every cycle between api.ts and the modules that call it.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onSessionRevoked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceSessionRevoked(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others hearing it.
    }
  }
}
