import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/** The running version, in the corner of every screen.
 *
 * Asked for after 0.9.39 shipped a sign-in bug: when a customer says
 * "it is broken", the first thing worth knowing is which build they are
 * looking at, and the only place that answered was the Support screen --
 * which is two taps away and the last place somebody goes when the app
 * will not let them in. On the login screen, where this now shows, it
 * costs nothing and settles the question from a screenshot.
 *
 * Deliberately quiet: it is metadata, not interface. Muted foreground
 * rather than a hardcoded grey so it follows the theme instead of
 * fighting it, and `pointer-events-none` because an overlay spanning
 * the whole window must never be the thing that swallows a click on the
 * Connect button underneath it.
 *
 * `getVersion` reads the value Tauri compiled in from
 * `tauri.conf.json`, so it is the real build rather than anything the
 * UI believes about itself. Failure renders nothing at all: a version
 * stamp is not worth an error state, and "unknown" in the corner of a
 * working app invites a support ticket of its own.
 */
export function VersionStamp() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getVersion().then(
      (v) => {
        if (alive) setVersion(v);
      },
      () => {
        // Nothing. See above.
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (!version) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-2 right-3 z-10 select-none text-[11px] tabular-nums text-muted-foreground/70"
      // Kept clear of the home indicator on the phones that share this
      // component through `@shared`; a no-op on desktop.
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      v{version}
    </div>
  );
}
