/** What the app is entitled to say about the tunnel, given what it has
 * actually measured.
 *
 * Pulled out of the dashboard rather than left inline, and for the same
 * reason `connect-intent` was: the dashboard cannot be exercised without
 * a Tauri runtime, so every rule that decides whether a customer is told
 * "You're protected" was, until now, only ever checked by reading it.
 * The rules this file holds are the ones that were wrong.
 *
 * ## The defect these rules exist to close
 *
 * A running engine is not a working tunnel, and the app kept treating
 * the two as the same thing in three separate places:
 *
 *  1. `Engines::status` reports `TunnelHealth::Unknown` for Xray,
 *     OpenVPN and IKEv2 the whole time their process is alive
 *     (`service/src/engines/mod.rs`, the `Active::Child` arm) -- there
 *     is no cheap handshake to read, so it honestly reports that it
 *     knows nothing. `stateFromStatus` then turned that "I don't know"
 *     into "connected" via a `default:` arm.
 *
 *  2. The health poll's Custom-mode branch published "connected"
 *     whenever the engine was up, *discarding the probe result
 *     entirely*. The one instrument that could catch a dead tunnel was
 *     skipped precisely when it was the only evidence available.
 *
 *  3. `verifyEgress` returning `indeterminate` -- meaning "no baseline,
 *     so no comparison was possible" -- counted as carrying traffic.
 *
 * Composed, those three produce the report this file was written for: a
 * customer in Custom mode on an Xray protocol sees a green "Connected"
 * indefinitely while nothing flows. Every check either abstained or was
 * skipped, and abstention rendered as proof.
 *
 * ## The rule
 *
 * "Connected" is a claim that traffic is going through Neoxify, so it
 * requires evidence that it is. Absence of evidence is its own answer --
 * `unverified` -- and never borrows the words of either extreme. A false
 * "not protected" costs trust too, and a customer in Iran who believes
 * it may disconnect and expose themselves, so nothing here escalates to
 * `degraded` without an instrument that actually came back negative.
 */

import type { ConnectionState } from "../components/ConnectOrb";
import type { EgressVerdict } from "./egress";

/** What the helper service reports about the far end.
 *
 * `connected` only means an engine is running locally. `health` is the
 * part that required the server to participate -- and for three of the
 * four protocols it is `unknown`, which is the whole problem this file
 * addresses.
 */
export type VpnStatus = {
  connected: boolean;
  protocol: string | null;
  /** Whether Custom mode is intercepting right now, as opposed to being
   * switched on in Settings. The difference is real -- turning it on
   * mid-session cannot retrofit itself onto a tunnel already carrying
   * everything -- and the customer is told which they have. */
  splitTunnelActive?: boolean;
  /** What Custom mode's own packet counters say is wrong, already
   * phrased for the customer by the service. The only signal here
   * measured on the path a chosen app's traffic actually takes. */
  splitTunnelProblem?: string;
  /** Whether the service is holding a machine-wide IPv6 block for this
   * session.
   *
   * Read rather than inferred. Every node is IPv4-only, so a full tunnel
   * has nowhere to send IPv6 and blocks it instead of letting it out in
   * the clear -- but which sessions actually have a block is a fact
   * about the machine, not about the protocol name: WireGuard has none
   * of ours (it installs its own), Custom mode has none (the redirect
   * handles IPv6 per app), and an install that failed has none either.
   * The customer is told about the gap, so the claim has to be true. */
  ipv6Blocked?: boolean;
  /** Whether this session asked for the tunnel's DNS rule and did not
   * get it.
   *
   * `true` means the tunnel is carrying traffic and the machine's name
   * lookups are not pinned to it, so the customer's ISP resolver can
   * still answer -- which on a censored network means answer wrongly,
   * for exactly the domains they connected in order to reach.
   *
   * `false` is NOT "DNS is protected", and nothing in the UI may render
   * it as one. It means no engine reported a rule it could not install:
   * WireGuard installs its own, Custom mode deliberately leaves the
   * machine's lookups alone, and a session that succeeded is `false`
   * too. It is a complaint channel, not a green light. */
  tunnelDnsUnprotected?: boolean;
  /** Applications the customer selected while they were already open,
   * as bare file names.
   *
   * Custom mode routes what a program connects to *after* it is
   * selected. Connections it already held cannot be moved -- a live TCP
   * connection is a socket to the real destination -- so this is the
   * list the UI turns into "close it and open it again".
   *
   * Facts, not a sentence: the wording is in `i18n.tsx` in both
   * languages, because the customers this feature exists for read
   * Persian.
   *
   * Empty, or absent from an older service, means nothing to say. */
  splitTunnelRestartNeeded?: string[];
  health:
    | { state: "alive"; age_secs: number }
    | { state: "stale"; age_secs: number }
    | { state: "neverHandshaked" }
    | { state: "down" }
    | { state: "unknown" };
};

/** What the service's `health` field is worth as evidence about traffic.
 *
 * Three values rather than two, and the third is the point. `silent` is
 * not a weak `proves`: it is the service saying it gathered nothing,
 * which is what Xray, OpenVPN and IKEv2 always say. Collapsing it into
 * either neighbour is how a protocol-alive check came to stand in for a
 * traffic check.
 */
export type HandshakeEvidence =
  /** A handshake completed recently: the far end is talking to us. */
  | "proves"
  /** There is an interface and the far end is not answering through it. */
  | "refutes"
  /** No handshake evidence exists for this protocol, either way. */
  | "silent";

export function handshakeEvidence(status: VpnStatus): HandshakeEvidence {
  switch (status.health.state) {
    case "alive":
      return "proves";
    case "stale":
    case "neverHandshaked":
      return "refutes";
    // `down` only ever arrives with `connected: false`, which every
    // caller handles before reaching here. Treated as silent rather than
    // as refutation so that a status shape nobody expected cannot invent
    // an accusation.
    case "down":
    case "unknown":
      return "silent";
  }
}

/** Turns the service's two facts into the strongest honest claim.
 *
 * `stale` and `neverHandshaked` become "degraded": an interface exists
 * and nothing is reaching the other end, which is precisely the
 * situation that used to render as a confident "Connected".
 *
 * `unknown` becomes `unverified`, and that is the change. It used to
 * fall through a `default:` arm to "connected" -- which is how an Xray
 * tunnel that had stopped carrying anything stayed green. It is not
 * `degraded` either: nothing came back negative, so claiming the
 * customer is unprotected would be the same invention in the other
 * direction. The traffic checks in the dashboard are what promote this
 * to "connected", and they run within a couple of seconds of it
 * appearing.
 */
export function stateFromStatus(status: VpnStatus): ConnectionState {
  if (!status.connected) return "disconnected";
  switch (handshakeEvidence(status)) {
    case "proves":
      return "connected";
    case "refutes":
      return "degraded";
    case "silent":
      return "unverified";
  }
}

/** Combines the two independent pieces of evidence for a full tunnel.
 *
 * They answer different questions and neither alone is enough: the
 * handshake proves the *server* is talking to us, the egress check
 * proves *our traffic* is going through it. A tunnel can pass the first
 * and fail the second -- the interface is healthy but the routing table
 * never sent anything into it -- which looks perfect locally while the
 * customer is completely unprotected.
 *
 * Egress therefore wins where they disagree: it is the one measured from
 * the far side of the whole path. Where egress abstains, the handshake
 * stands -- including when the handshake abstains too, in which case
 * `fromHandshake` is already `unverified` and stays that way.
 */
export function combineEvidence(
  fromHandshake: ConnectionState,
  egress: EgressVerdict,
): ConnectionState {
  if (fromHandshake === "disconnected") return "disconnected";

  switch (egress.state) {
    case "throughTunnel":
      return "connected";
    case "bypassingTunnel":
    case "unreachable":
      return "degraded";
    case "indeterminate":
      // No comparable pair of readings, so no verdict. Falls back to
      // whatever the handshake said rather than inventing one -- and for
      // Xray, OpenVPN and IKEv2 the handshake says nothing either, so
      // this correctly comes out `unverified` instead of the "connected"
      // it used to.
      return fromHandshake;
  }
}

/** The state to show for a *full tunnel* on a routine health poll.
 *
 * Split out from the connect path's `combineEvidence` because the poll
 * has a different job: it is not choosing between candidates, it is
 * deciding what a customer who is already connected should be reading
 * right now.
 *
 * `indeterminate` is the case worth naming. It means no baseline exists
 * -- which is the normal state after the app is reopened over a tunnel
 * the service kept up, since a baseline captured through a live tunnel
 * would record the exit address as the "before" value and make every
 * later comparison read as a leak. The poll used to count that as
 * carrying traffic. It is not evidence of anything, so it now reads as
 * `unverified`: connected, not confirmed.
 */
export function fullTunnelPollState(
  fromStatus: ConnectionState,
  egress: EgressVerdict,
): ConnectionState {
  if (fromStatus === "disconnected") return "disconnected";
  return combineEvidence(fromStatus, egress);
}

/** The state to show for *Custom mode* on a routine health poll.
 *
 * Custom mode cannot be judged by the app's own egress check, and the
 * reason is structural rather than a quirk to work around: this app is
 * deliberately not one of the selected apps, so a request asking a
 * server what address it sees us from correctly leaves by the ordinary
 * route and correctly reports the tunnel bypassed. That mistake once
 * tore down a tunnel carrying a customer's game perfectly well -- 328
 * flows matched and 703 packets redirected while the UI said "not
 * carrying traffic".
 *
 * So the service answers instead, over a socket pinned to the tunnel.
 * Two rules govern what its answer is worth, and they pull in opposite
 * directions:
 *
 *  - **A failed probe is not grounds to change protocol.** It has been
 *    seen to fail while Chrome was visibly going through the tunnel.
 *    Letting a check that flaky throw away a working protocol is
 *    indefensible, so this never returns `degraded` on the strength of
 *    the probe alone.
 *
 *  - **A failed probe is also not grounds to say "protected".** This is
 *    the defect. The old branch published "connected" whenever the
 *    engine was up, which for Xray means "the process has not exited" --
 *    a condition that holds forever. The probe result was discarded, and
 *    with it the only instrument that could have caught a dead tunnel.
 *
 * Between those two sits `unverified`, which asserts neither.
 *
 * The engine's own handshake still outranks the probe when it *refutes*:
 * a WireGuard tunnel whose handshake has gone stale is genuinely not
 * carrying traffic, and that is a measurement rather than an absence.
 */
export function customModePollState(
  fromStatus: ConnectionState,
  probeCarried: boolean,
): ConnectionState {
  if (fromStatus === "disconnected") return "disconnected";
  // A measured negative from the engine outranks everything below: it is
  // the one signal here that came back saying "no" rather than saying
  // nothing.
  if (fromStatus === "degraded") return "degraded";
  return probeCarried ? "connected" : "unverified";
}

/** Whether a state means an engine is up, whatever else is unknown about
 * it.
 *
 * Exists so the several places that ask "is there a tunnel to poll,
 * disconnect or wait out" do not each re-enumerate the union and quietly
 * disagree when a member is added -- which is exactly what happened when
 * `unverified` was introduced: every one of those call sites had been
 * written as `=== "connected" || === "degraded"`.
 */
export function isTunnelUp(state: ConnectionState): boolean {
  return state === "connected" || state === "degraded" || state === "unverified";
}
