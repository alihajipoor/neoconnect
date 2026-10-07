import type { ReconnectOutcome, ReconnectStop } from "@shared/lib/auto-reconnect";

/** The phone's half of the automatic reconnect after a drop.
 *
 * The episode itself -- when to try, how often, when to stop -- is the
 * shared `autoReconnect`, the same one the Windows client runs. What
 * lives here is what only a phone has to ask before an attempt may
 * dial, kept out of the dashboard so it can be tested without a tunnel.
 *
 * ## What a phone cannot tell, and what it does about it
 *
 * Android ends a VpnService the same way whether its engine died, the
 * customer pressed Disconnect in the system's own VPN settings, or
 * another VPN app took over (`onRevoke`). iOS stops the extension the
 * same way for a crash as for the toggle in Settings. The app sees one
 * thing in every case: the tunnel is down. Two of those were the
 * customer's own doing, outside this app, and reconnecting over them
 * would be fighting them. Two checks narrow it, and neither raises
 * anything on screen:
 *
 *  - **Another VPN holds the device.** Asked first, by waiting (bounded)
 *    for the device to be out of every VPN. Android reports any VPN
 *    network, not only ours, so a takeover by another app is seen here,
 *    and the attempt stops -- before the permission is so much as asked
 *    about, because on Android asking (`VpnService.prepare`) can itself
 *    move the VPN back to an app the customer once allowed. That is read
 *    from AOSP's `Vpn.prepare`, not observed on a device.
 *  - **The permission is gone.** A system that took the VPN away, or an
 *    iOS profile the customer deleted, leaves this app without one. An
 *    automatic attempt never raises the consent dialog -- that is a
 *    question for somebody who pressed Connect -- so it stops.
 *
 * What neither can see -- a disconnect from Android's VPN settings that
 * left the permission in place, or the iOS Settings toggle -- is
 * reconnected the next time the app is in front, like a crash. That is a
 * known gap, written down in the journal, not a decision this file hides.
 */
export interface ReconnectPreflight {
  /** What the screen knows rules a reconnect out right now. */
  exclusion: () => ReconnectStop | null;
  /** Waits, bounded, for the device to be out of every VPN. False when
   * one is still up at the end of the wait. */
  vpnGone: () => Promise<boolean>;
  /** Whether this app may start a VPN without asking. Must never raise a
   * dialog. */
  hasPermission: () => Promise<boolean>;
}

/** Null to go ahead and dial; otherwise the attempt's outcome. A check
 * that could not be made is a failed attempt rather than a reason to
 * stop: the next attempt asks again, and the episode is bounded. */
export async function reconnectPreflight(deps: ReconnectPreflight): Promise<ReconnectOutcome | null> {
  const excluded = deps.exclusion();
  if (excluded !== null) return { kind: "stop", why: excluded };

  let gone: boolean;
  try {
    gone = await deps.vpnGone();
  } catch {
    return { kind: "failed" };
  }
  if (!gone) return { kind: "stop", why: "otherVpn" };

  let granted: boolean;
  try {
    granted = await deps.hasPermission();
  } catch {
    return { kind: "failed" };
  }
  if (!granted) return { kind: "stop", why: "permission" };
  return null;
}

/** Whether a screen mounting -- back from Settings, a new location, the
 * retry button -- has found a drop nobody saw: the app was vouching for a
 * tunnel, the platform answered, and the answer is that nothing is up.
 *
 * Not while a teardown is owed, the device limit's or the customer's:
 * that tunnel is coming down because somebody asked. And not when the
 * platform did not answer, which this screen has always read as
 * "disconnected" for want of anything better -- not knowing is not a
 * drop. */
export function droppedWhileAway({
  vouching,
  answered,
  connected,
  tearingDown,
}: {
  vouching: boolean;
  answered: boolean;
  connected: boolean;
  tearingDown: boolean;
}): boolean {
  return vouching && answered && !connected && !tearingDown;
}
