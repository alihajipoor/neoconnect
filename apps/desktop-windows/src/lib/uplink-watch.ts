/** Whether the way out a tunnel was proven over is still there.
 *
 * Measured on the VM (P3 runs n-01 and r-01, 2026-10-12): after the link
 * dropped, "You're protected" stayed about 20 s over a tunnel that could
 * carry nothing, and about 26 s after a roam. Nothing told the screen. The
 * engine was still running, so the service's status said what it always
 * says, and the one instrument that could tell -- a request through the
 * tunnel -- runs every fifteen seconds and then waits out its own walk.
 *
 * So the machine's ways out are looked at every second while a tunnel is
 * up (`network_uplinks`: each default route's interface and next hop, and
 * the addresses that interface holds), and a change is acted on at once:
 *
 *  - **no way out**, seen twice running: the tunnel cannot carry anything.
 *    It is handed to the automatic reconnect, as a drop is -- its existing
 *    "Reconnecting..." look, and "Waiting for a network connection" while
 *    there is none -- and "protected" comes back only from that
 *    reconnect's own proof;
 *  - **another way out** -- a roam, a new address, a link added or gone, a
 *    blip -- the tunnel is re-verified now, within `UPLINK_RECHECK_MS`, and
 *    what that proves is shown; a measured no, or no answer in time, is the
 *    same as no way out.
 *
 * Calm, as the owner's rule asks: nothing changes on screen for a change
 * the tunnel survives, the orb keeps its colour over a short gap
 * (`orb-caution.ts`), and a tunnel that cannot carry gets the reconnect's
 * look rather than the amber "Not carrying traffic". */

import type { ConnectionState } from "../components/ConnectOrb";

/** How often the way out is looked at. A local table read; nothing leaves
 * the machine. */
export const UPLINK_POLL_MS = 1_000;

/** Looks running that must find no way out before the tunnel is called
 * unable to carry: one could be a route being replaced. */
export const GONE_LOOKS = 2;

/** The ceiling on re-verifying after a change. A request through a tunnel
 * that has lost its way out fails at once or hangs; one through a tunnel
 * that survived the change answers well inside this, Iran included. */
export const UPLINK_RECHECK_MS = 2_500;

export interface UplinkWatch {
  /** What the session's last look found; null before its first. */
  readonly seen: string | null;
  /** Looks running that found no way out at all. */
  readonly goneLooks: number;
}

/** A session not yet looked at. */
export const NEW_UPLINK_WATCH: UplinkWatch = { seen: null, goneLooks: 0 };

/** `same`: nothing to do. `recheck`: re-verify the tunnel now. `lost`: no
 * way out -- the tunnel cannot carry. */
export type UplinkStep = "same" | "recheck" | "lost";

/** One more look, `seen` being what `network_uplinks` answered: the empty
 * string for no way out, null when it could not be asked. */
export function nextUplink(prev: UplinkWatch, seen: string | null): [UplinkWatch, UplinkStep] {
  // Not asked is not news, either way.
  if (seen === null) return [prev, "same"];
  // The first look of a session is what it was proven over.
  if (prev.seen === null) return [{ seen, goneLooks: 0 }, "same"];
  if (seen === "") {
    // A session that began with no way out this can see -- a PPP line,
    // say -- learns nothing from not seeing one.
    if (prev.seen === "") return [prev, "same"];
    const goneLooks = prev.goneLooks + 1;
    if (goneLooks >= GONE_LOOKS) return [{ seen: "", goneLooks: 0 }, "lost"];
    return [{ seen: prev.seen, goneLooks }, "same"];
  }
  // Another way out, or the same one back after a blip that may have taken
  // the tunnel's own route with it.
  if (seen !== prev.seen || prev.goneLooks > 0) return [{ seen, goneLooks: 0 }, "recheck"];
  return [prev, "same"];
}

/** A re-verification's answer: the state it measured, or no answer within
 * `UPLINK_RECHECK_MS`. */
export type RecheckVerdict = ConnectionState | "timedOut";

/** `show`: put what was measured on screen. `lost`: the tunnel cannot
 * carry. `ignore`: not this watch's to say -- a tunnel the service says is
 * gone is the liveness poll's drop, and a service that did not answer is
 * the status polls' "unknown". */
export function afterUplinkRecheck(verdict: RecheckVerdict): "show" | "lost" | "ignore" {
  switch (verdict) {
    // Proof -- or, where traffic flows and nothing could be compared, the
    // same honest middle the routine poll shows. Never "protected" without
    // the proof.
    case "connected":
    case "unverified":
      return "show";
    case "degraded":
    case "timedOut":
      return "lost";
    default:
      return "ignore";
  }
}

/** `promise`'s answer if it comes within `ms`, otherwise -- and if it
 * fails -- `fallback`. */
export function withinMs<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
