import type { ConnectionState } from "@shared/components/ConnectOrb";
import { verifyEgress, type BaselineIp, type EgressVerdict, type TunnelServer } from "@shared/lib/egress";
import type { VpnStatus } from "./vpn";

/** What the phone is entitled to say about its tunnel, given what it has
 * measured.
 *
 * Out of the dashboard for the reason `connection-evidence.ts` is out of
 * the Windows one: the screen cannot run without a Tauri runtime, so the
 * rules deciding whether a customer reads "You're protected" were only
 * ever checked by reading them -- and the one that was wrong had been
 * read many times.
 *
 * That rule counted an `indeterminate` egress reading as carrying
 * traffic. `indeterminate` means no comparison was possible: no baseline
 * at all, or two readings from different endpoints. A tunnel adopted on
 * relaunch never has a baseline, so it read "indeterminate" on every
 * poll and was shown as protected forever -- including the Android Xray
 * tunnel whose stale state file claimed it was up after a reboot, when
 * nothing was running and everything left in the clear.
 *
 * Absence of evidence now has its own word, `unverified` ("Connected,
 * not confirmed"), as it does on Windows. It never borrows "protected",
 * and it never escalates to "degraded" either: nothing came back
 * negative.
 */

/** Seconds without a WireGuard handshake before the tunnel is treated as
 * dead. Matches the Windows service's own threshold -- WireGuard
 * rehandshakes about every two minutes under traffic, so three is late
 * enough not to cry wolf and early enough to be useful. */
export const HANDSHAKE_STALE_SECS = 180;

/** How long a fresh tunnel gets to prove it carries traffic.
 *
 * More patient than the Windows client's six seconds, and for a reason
 * that only applies here: a phone's radio may be idle when the tunnel
 * comes up, and the first packet after that pays for waking it. */
export const VERIFY_TIMEOUT_MS = 12_000;
export const VERIFY_INTERVAL_MS = 1_200;

/** Turns what the plugin reports into the state its own evidence allows.
 *
 * `lastHandshakeAgeSecs` is null for protocols with no handshake to read
 * (Xray, IKEv2). That used to be "connected", which made "an engine says
 * it is up" stand in for "traffic is going through it". It is
 * `unverified` now: the egress check is what promotes it, and it runs on
 * every connect and every health poll. A fresh WireGuard handshake does
 * prove the far end is answering, so it stays "connected"; a stale one
 * is a measured negative and stays "degraded". */
export function stateFromStatus(status: VpnStatus): ConnectionState {
  if (!status.connected) return "disconnected";
  if (status.lastHandshakeAgeSecs === null) return "unverified";
  return status.lastHandshakeAgeSecs <= HANDSHAKE_STALE_SECS ? "connected" : "degraded";
}

/** Whether a state means a tunnel is up, whatever else is unknown about
 * it. One place, so the gates that ask "is there a tunnel to poll or to
 * take down" cannot disagree when a state is added -- which is how
 * `unverified` would otherwise have been missed by every
 * `=== "connected" || === "degraded"` in the screen. */
export function tunnelUp(state: ConnectionState): boolean {
  return state === "connected" || state === "degraded" || state === "unverified";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ConfirmOptions = {
  /** Ask only the baseline's endpoint. Any other endpoint can at best
   * answer `indeterminate`, which on a rung with another protocol still
   * to try is no reason to stop -- see `rungOutcome`. */
  sameEndpointOnly?: boolean;
  /** The rung's server. An endpoint on it is reached around the tunnel
   * and answers with the phone's own address however well the tunnel
   * works, so its answers are passed over. See `TunnelServer` in the
   * shared egress.ts. */
  tunnelServer?: TunnelServer;
  cancelled?: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
};

/** Waits for proof that traffic leaves through the tunnel, rather than
 * asking once, and returns the last verdict -- or null when the customer
 * stopped the connect.
 *
 * Returns as soon as there is proof, so a working connection stays
 * fast. It used to return as soon as a reading was `indeterminate` too,
 * and the caller called that "connected". Now an indeterminate reading
 * is kept waiting for the comparable one, except with no baseline at
 * all, where asking again cannot produce one. */
export async function confirmEgress(
  // A `BaselineIp`, not a bare address. `verifyEgress` refuses to compare
  // two readings from different endpoints -- a node mirror answers
  // `/health/ip` with the node's own address, which is indistinguishable
  // from a working tunnel -- so the endpoint has to travel with it.
  baseline: BaselineIp | null,
  options: ConfirmOptions = {},
): Promise<EgressVerdict | null> {
  const {
    sameEndpointOnly = false,
    tunnelServer,
    cancelled = () => false,
    timeoutMs = VERIFY_TIMEOUT_MS,
    intervalMs = VERIFY_INTERVAL_MS,
  } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Checked every pass, not only at the end: this loop is most of the
    // time a hanging protocol spends in "checking connection", so a
    // cancel that is not honoured here is a button that does nothing.
    if (cancelled()) return null;
    const verdict = await verifyEgress(baseline, { sameEndpointOnly, tunnelServer });
    if (cancelled()) return null;
    if (verdict.state === "throughTunnel") return verdict;
    if (baseline === null && verdict.state === "indeterminate") return verdict;
    if (Date.now() >= deadline) return verdict;
    await sleep(intervalMs);
  }
}

/** What one rung of the connect ladder comes to.
 *
 *  - `connected`: the exit address changed. Proof, and the only outcome
 *    remembered as working on this network or reported as carried.
 *  - `unverified`: up, nothing measured either way. Lands the pass --
 *    with no baseline no rung could ever prove anything, and on the last
 *    rung there is nothing left to try -- but is shown as "Connected,
 *    not confirmed", never "You're protected".
 *  - `notCarrying`: the rung is torn down and the next one tried.
 *
 * An `indeterminate` reading on a rung with a baseline and another
 * protocol still to try is `notCarrying`, as on Windows: that rung asks
 * only the baseline's endpoint, so it can only get there when nothing
 * comparable answered, and the next protocol may yet prove itself. */
export type RungOutcome = "connected" | "unverified" | "notCarrying";

export function rungOutcome(
  verdict: EgressVerdict,
  { baselineTaken, isLast }: { baselineTaken: boolean; isLast: boolean },
): RungOutcome {
  switch (verdict.state) {
    case "throughTunnel":
      return "connected";
    case "indeterminate":
      return isLast || !baselineTaken ? "unverified" : "notCarrying";
    case "bypassingTunnel":
    case "unreachable":
      return "notCarrying";
  }
}

/** Whether a rung the ladder moved on from is evidence against its
 * route.
 *
 * Only a measured negative is: the old address came back
 * (`bypassingTunnel`), or nothing answered at all (`unreachable`). An
 * `indeterminate` rung was set aside because nothing could be compared
 * -- since the shared egress check learned to call an error page from
 * our own API "indeterminate", that includes a backend being redeployed
 * under a tunnel that works. Remembered as a failing route, or reported
 * to the per-ISP data as one that carried nothing, it would be a claim
 * about a server that nothing measured. */
export function rejectionIsEvidence(verdict: EgressVerdict): boolean {
  return verdict.state === "bypassingTunnel" || verdict.state === "unreachable";
}

/** Our nodes' public addresses, as far as this customer's credentials
 * name them: each one's `connection.host`, which the server fills with
 * the node's `publicIp`.
 *
 * For `captureBaselineIp`'s `nodeAddresses`. A pre-connect reading of one
 * of these is never this phone's own address; it is a node mirror that
 * answers `/health/ip` with its node's address to everyone (or a tunnel
 * not yet gone). Taken as the baseline, every comparison through that
 * mirror afterwards came back "the same address" -- `bypassingTunnel`,
 * which the ladder holds against the route and the poll shows as "Your
 * traffic is NOT protected" -- over a tunnel that worked.
 *
 * The mirrors this app derives from its own credentials (`mirrorsFrom`)
 * live on exactly these nodes. One from the signed bundle on a node this
 * customer has no credential for is not covered: its address is not
 * known here. */
export function nodeAddressesOf(users: readonly { connection?: { host?: string } | null }[]): Set<string> {
  const addresses = new Set<string>();
  for (const user of users) {
    const host = user.connection?.host?.trim();
    if (host) addresses.add(host);
  }
  return addresses;
}

/** The egress reading for a health poll.
 *
 * The baseline's own endpoint first: it is the only one whose answer can
 * prove anything, and the API client races endpoints and remembers the
 * winner, so the head of the list moves more often than a baseline does.
 * The whole list only when that endpoint does not answer, so a blocked
 * mirror reads as "no comparison" rather than as a dead tunnel.
 *
 * Asking the baseline's endpoint is only as good as the baseline: one
 * from a mirror that reports its own node's address would make this
 * "bypassingTunnel" on every poll of a working tunnel. The dashboard
 * keeps those out of baselines; see `nodeAddressesOf`.
 *
 * `tunnelServer` is the connected rung's server: an endpoint on it is
 * reached around the tunnel, so it is passed over on every walk here,
 * and a baseline from one is never asked alone. See `TunnelServer` in
 * the shared egress.ts. */
export async function pollEgress(baseline: BaselineIp | null, tunnelServer?: TunnelServer): Promise<EgressVerdict> {
  if (baseline === null) return verifyEgress(null, { tunnelServer });
  const own = await verifyEgress(baseline, { sameEndpointOnly: true, tunnelServer });
  if (own.state !== "unreachable") return own;
  return verifyEgress(baseline, { tunnelServer });
}

/** The state a health poll shows for a tunnel that is still up.
 *
 * A stale WireGuard handshake is a measured negative and outranks the
 * egress reading. Otherwise the egress check decides, and where it
 * abstains (`indeterminate`) the handshake stands: a fresh one keeps
 * "connected", and a protocol with none to read is `unverified`. It used
 * to be "connected" for all of them. */
export function pollState(fromStatus: ConnectionState, egress: EgressVerdict): ConnectionState {
  if (fromStatus === "disconnected") return "disconnected";
  if (fromStatus === "degraded") return "degraded";
  switch (egress.state) {
    case "throughTunnel":
      return "connected";
    case "bypassingTunnel":
    case "unreachable":
      return "degraded";
    case "indeterminate":
      return fromStatus === "connected" ? "connected" : "unverified";
  }
}
