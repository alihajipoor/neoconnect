import type { ReconnectOutcome, ReconnectStop } from "@shared/lib/auto-reconnect";
import type { TunnelReading, VpnAccess } from "./vpn";

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
 *    for the device to be out of every VPN (`waitOutTeardown`). Android
 *    reports any VPN network, not only ours, so a takeover by another app
 *    is seen here -- a VPN still up at the end of the wait while none of
 *    our engines is -- and the attempt stops before the permission is so
 *    much as asked about, because on Android asking (`VpnService.prepare`) can itself
 *    move the VPN back to an app the customer once allowed. That is read
 *    from AOSP's `Vpn.prepare`, not observed on a device.
 *
 *    iOS shows an app only its own connections, so there the wait sees
 *    nothing of another app's VPN. What iOS does show is which
 *    configuration is enabled: one of each kind at a time -- tunnel
 *    providers one kind, NEVPNManager profiles such as our IKEv2 another
 *    -- and enabling another of a kind (another VPN app connecting, or a
 *    pick in Settings) turns ours of that kind off. One of ours turned off
 *    (`VpnAccess.chosenElsewhere`, which comes with the permission's
 *    answer -- asking it on iOS changes nothing) stops the attempt the
 *    same way: dialling would switch ours back on, and the device off the
 *    other app's VPN. Asked per kind, since our own code turns nothing
 *    off; read from Apple's documentation, not observed on a device.
 *    Across kinds -- another app's personal VPN connecting over our packet
 *    tunnel turns nothing of ours off -- the sign is why the system
 *    stopped our tunnel: `superceded`, which the extension records for
 *    the app (`TunnelLastStop` in the plugin). Also from the
 *    documentation, also unobserved. And asked again before every rung of
 *    a pass, not only as it begins (`rungAccess`).
 *  - **The permission is gone.** A system that took the VPN away, or an
 *    iOS profile the customer deleted, leaves this app without one. An
 *    automatic attempt never raises the consent dialog -- that is a
 *    question for somebody who pressed Connect -- so it stops.
 *
 *    iOS has a second consent of the same kind: IKEv2 is its own
 *    configuration, with its own "Add VPN Configurations" prompt, removed
 *    at every sign-out and never installed for somebody who has not yet
 *    landed on IKEv2. Without it the attempt still dials, but passes over
 *    the IKEv2 rungs (`ReconnectClearance.ikev2`): dialling one would
 *    install it, and raise the prompt, passcode and all.
 *
 * What neither can see -- a disconnect from Android's VPN settings that
 * left the permission in place, or the iOS Settings toggle -- is
 * reconnected the next time the app is in front, like a crash. That is a
 * known gap, written down in the journal, not a decision this file hides.
 */
export interface ReconnectPreflight {
  /** What the screen knows rules a reconnect out right now. */
  exclusion: () => ReconnectStop | null;
  /** Waits, bounded, for the device to be out of every VPN, and says whose
   * is still up when it is not (`waitOutTeardown`). */
  vpnGone: () => Promise<TeardownWait>;
  /** What this app may start without asking (`vpnAccess`). Must never
   * raise a dialog. */
  access: () => Promise<VpnAccess>;
  /** Whether the attempt is still the episode's current one
   * (`ReconnectAttempt.live`). */
  live: () => boolean;
  /** Told which check ended a preflight that did not clear, for the report. */
  noted?: (note: PreflightNote) => void;
}

/** A preflight that found nothing in the way, and what the pass it lets
 * through may dial. */
export interface ReconnectClearance {
  readonly kind: "clear";
  /** Whether the pass may dial IKEv2. False on iOS while IKEv2's own
   * configuration is not installed: an automatic pass passes over those
   * rungs, a press of Connect dials them, prompt and all. */
  readonly ikev2: boolean;
}

/** What a preflight answers for an attempt that was ended while it asked.
 * The episode has already moved on and ignores it; what matters is that
 * nothing is dialled. */
const OVERTAKEN: ReconnectOutcome = { kind: "stop", why: "customer" };

/** What the wait for the device to be out of every VPN found.
 *
 * `ours` says whose VPN was still up when the wait ended: true, a
 * connection of ours still on its way down; false, a VPN that is none of
 * ours; null, not known. Only false is a sign of another app's VPN. An
 * iPhone sees only its own connections, so there a tunnel not gone is
 * always ours -- and reading it as another VPN is what stopped iPhone
 * reconnects after one attempt, nothing dialled, behind an extension stuck
 * between up and down (five of five such stops in production followed an
 * Xray landing). */
export interface TeardownWait {
  gone: boolean;
  ours: boolean | null;
  /** The state the platform named (iOS), for the report. */
  state: string | null;
}

/** Waits, up to `timeoutMs`, for the device to be out of every VPN, and
 * if it is not, asks whose VPN is still up. `read` is `tunnelReading`;
 * `ownUp` whether one of our own engines is up (`vpnStatus`), asked
 * only where the reading sees other apps' VPNs too (Android). A reading
 * that could not be made is not knowing, never "gone". */
export async function waitOutTeardown(deps: {
  read: () => Promise<TunnelReading>;
  ownUp: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}): Promise<TeardownWait> {
  const deadline = deps.now() + deps.timeoutMs;
  let last: TunnelReading | null = null;
  while (deps.now() < deadline) {
    try {
      last = await deps.read();
      if (last.gone) return { gone: true, ours: null, state: last.state ?? null };
    } catch {
      // Not knowing is not the same as knowing it is down.
    }
    await deps.sleep(deps.pollMs);
  }
  if (last === null) return { gone: false, ours: null, state: null };
  const state = last.state ?? null;
  if (last.seesOthers === false) return { gone: false, ours: true, state };
  let ours: boolean | null;
  try {
    ours = await deps.ownUp();
  } catch {
    ours = null;
  }
  return { gone: false, ours, state };
}

/** Which check a preflight that did not clear its attempt stopped at, for
 * the report it sends (run-diagnostics.ts `preflightReason`): the branch,
 * what came of it, and the tunnel state the wait saw. */
export interface PreflightNote {
  branch:
    | "otherVpnUp"
    | "ownStillStopping"
    | "unknownStillUp"
    | "waitFailed"
    | "permission"
    | "chosenElsewhere"
    | "accessFailed";
  outcome: "stop" | "retry";
  state: string | null;
}

/** A clearance to go ahead and dial; otherwise the attempt's outcome. A
 * check that could not be made is a failed attempt rather than a reason
 * to stop: the next attempt asks again, and the episode is bounded.
 *
 * Whether the attempt is still live is asked again after every answer.
 * Each question is a call to the platform -- the wait for the device to
 * be out of every VPN can run to seconds -- and "Stop reconnecting", a
 * Connect, a sign-out or the device limit pressed meanwhile used to be
 * overridden: the pass dialled once these came back, and the tunnel came
 * up after the customer had said stop. */
export async function reconnectPreflight(deps: ReconnectPreflight): Promise<ReconnectOutcome | ReconnectClearance> {
  if (!deps.live()) return OVERTAKEN;
  const excluded = deps.exclusion();
  if (excluded !== null) return { kind: "stop", why: excluded };

  const note = (branch: PreflightNote["branch"], outcome: PreflightNote["outcome"], state: string | null) => {
    try {
      deps.noted?.({ branch, outcome, state });
    } catch {
      // A report is never a reason to change what the attempt does.
    }
  };

  let wait: TeardownWait;
  try {
    wait = await deps.vpnGone();
  } catch {
    if (!deps.live()) return OVERTAKEN;
    note("waitFailed", "retry", null);
    return { kind: "failed" };
  }
  if (!deps.live()) return OVERTAKEN;
  if (!wait.gone) {
    // Another VPN only on a sign of one: a VPN up, and none of it ours.
    if (wait.ours === false) {
      note("otherVpnUp", "stop", wait.state);
      return { kind: "stop", why: "otherVpn" };
    }
    // Our own tunnel not yet down, or not known whose: the next attempt,
    // on the episode's next step, waits again. The episode is bounded.
    note(wait.ours === true ? "ownStillStopping" : "unknownStillUp", "retry", wait.state);
    return { kind: "failed" };
  }

  let access: VpnAccess;
  try {
    access = await deps.access();
  } catch {
    if (!deps.live()) return OVERTAKEN;
    note("accessFailed", "retry", wait.state);
    return { kind: "failed" };
  }
  if (!deps.live()) return OVERTAKEN;
  if (!access.granted) {
    note("permission", "stop", wait.state);
    return { kind: "stop", why: "permission" };
  }
  if (access.chosenElsewhere === true) {
    note("chosenElsewhere", "stop", wait.state);
    return { kind: "stop", why: "otherVpn" };
  }
  // Only a platform that says IKEv2 is not installed holds it back;
  // Android says nothing of it.
  return { kind: "clear", ikev2: access.ikev2 !== false };
}

/** What an automatic pass on an iPhone does with the rung it is about to
 * dial, on the platform's answer asked right then (`vpnAccess`; null when
 * it could not be read).
 *
 * The preflight asks once, as the attempt begins. A pass then walks its
 * rungs for minutes on a filtered network, and the app can be left and
 * come back to in that time, so what the preflight cleared can be untrue
 * by the next rung:
 *
 *  - another VPN app connected meanwhile (`chosenElsewhere`). The next Xray
 *    or WireGuard rung set our configuration enabled again and started it,
 *    switching the device off that app's working VPN with nobody pressing
 *    anything -- and if the rung then failed, leaving it with none;
 *  - our configuration was deleted in Settings meanwhile (`granted` false,
 *    or `ikev2` false). The next rung saved a new one, and up came the
 *    "Add VPN Configurations" prompt, passcode and all.
 *
 * So asked again before every dial. `"skip"` passes over an IKEv2 rung
 * whose configuration is gone, as the clearance does; `"permission"` and
 * `"otherVpn"` end the episode as the preflight would; `"unknown"` -- the
 * answer could not be read -- dials nothing more on this pass, which ends
 * as failed, and the next attempt's preflight asks again. Not Android:
 * asking there (`VpnService.prepare`) can itself move the VPN back to this
 * app, and `tunnelGone` sees every VPN anyway. */
export type RungAccess = "dial" | "skip" | "unknown" | "permission" | "otherVpn";

export function rungAccess(access: VpnAccess | null, protocol: string): RungAccess {
  if (access === null) return "unknown";
  if (!access.granted) return "permission";
  if (access.chosenElsewhere === true) return "otherVpn";
  if (protocol === "IKEV2" && access.ikev2 === false) return "skip";
  return "dial";
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
