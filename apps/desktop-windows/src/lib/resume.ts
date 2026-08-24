import { useEffect, useRef } from "react";
import { isSnapshotStale, loadSnapshot } from "./credential-cache";

/** Refetching account data when the app comes back to the foreground.
 *
 * This is the Android half of the stale-config problem, and it is the
 * half that makes the window unbounded rather than merely long.
 *
 * On Windows the app is a window: closing it ends the process, and the
 * next launch runs `loadAll` and picks up whatever the server now says.
 * On Android nothing of the sort happens. The activity is destroyed and
 * the WebView is kept, the VpnService goes on running with its own
 * notification, and re-opening the app restores the *same* React tree
 * with the same state it had a week ago. `loadAll` runs on mount, and
 * there is no new mount. So a customer who has never force-stopped the
 * app is dialling whatever the control plane said the first time they
 * installed it -- and toggling the VPN off and on does not help, because
 * the credentials it re-dials are the ones already in memory.
 *
 * `visibilitychange` is the event that fires in both cases: Android's
 * WebView reports hidden/visible around backgrounding, and a desktop
 * window reports it around minimise and tab-level occlusion. `focus` is
 * listened for as well because a window restored from the tray does not
 * always change visibility, and `online` because a device that has just
 * regained a network is the other moment where what is held is most
 * likely to be wrong.
 *
 * ## Why this is not a poll
 *
 * It fires on a transition a person made, not on a timer, and then only
 * when the cache is past its freshness horizon. A customer who
 * background/foregrounds the app six times in a minute costs one
 * request, not six. A customer who leaves it open costs none at all.
 * That was the constraint: the cheapest thing that closes an unbounded
 * window, not a background refresh loop that spends a censored
 * network's bandwidth on questions nobody asked.
 */
export function useRefreshOnResume(refresh: () => void | Promise<void>): void {
  // Held in a ref so a caller passing an inline closure -- which is
  // every caller -- does not tear down and re-register three listeners
  // on every render.
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    let running = false;

    async function maybeRefresh() {
      // Re-entrancy guard rather than a debounce. The three events below
      // commonly fire together (an Android resume raises `visibilitychange`
      // and `focus` within a few milliseconds), and two refreshes racing
      // each other would write the cache twice and, worse, could land in
      // either order.
      if (running) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // The whole check, and the reason this is cheap: an app resumed
      // twenty seconds after it was backgrounded asks nothing.
      if (!isSnapshotStale(await loadSnapshot())) return;
      running = true;
      try {
        await latest.current();
      } catch {
        // A refresh that failed is the case the connect path's fallback
        // already handles. Nothing here should surface as an error --
        // the customer did not ask for this.
      } finally {
        running = false;
      }
    }

    const handler = () => void maybeRefresh();
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("focus", handler);
    window.addEventListener("online", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("focus", handler);
      window.removeEventListener("online", handler);
    };
  }, []);
}
