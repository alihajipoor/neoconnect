import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints } from "./api-endpoints";

/** Proving a tunnel actually carries traffic, rather than merely existing.
 *
 * The obvious check -- "can I reach 8.8.8.8 / google.com after
 * connecting?" -- looks right and is not sufficient. It proves the
 * internet works, not that it works *through the VPN*. A tunnel that
 * came up but is carrying nothing leaves the normal route intact, so the
 * probe succeeds and the app reports success: precisely the false
 * "Connected" this exists to catch.
 *
 * Comparing the public IP before and after closes that hole. If the
 * world sees a different address afterwards, the packets provably left
 * via somewhere else. If it sees the same one, traffic is bypassing the
 * tunnel no matter how healthy the interface looks.
 *
 * That argument holds only while both readings came from the same
 * endpoint, which this file did not used to check. `/health/ip` reports
 * the last untrusted hop before the backend, and the node mirrors in the
 * fallback list report a different one from the CDN -- so two readings
 * taken through different endpoints can differ with nothing having
 * changed about the route. See `IpReading` and `verifyEgress`.
 *
 * It closes that hole for **IPv4 and nothing else**, which this file
 * used to claim was no hole at all. The comparison is done over
 * whichever family reached `/health/ip`, and on every node that is
 * IPv4 -- so a machine leaking IPv6 alongside a perfectly good IPv4
 * tunnel reads as "throughTunnel". That combination was measured, on
 * three of the four protocols tested. The IPv6 check at the bottom of
 * this file exists because of it.
 */

/** Short: this runs while the customer is watching a spinner, and a
 * server that will not answer quickly has already failed the check. */
const EGRESS_TIMEOUT_MS = 6000;

/** One answer to "what address does the world see", together with who
 * gave it.
 *
 * The `from` half is not bookkeeping. `/health/ip` does not report the
 * caller's egress address; it reports **the last untrusted hop before
 * the backend**, and which hop that is depends on which endpoint
 * answered. Some nodes run an API mirror that proxies to the
 * Cloudflare-fronted panel, and Cloudflare then overwrites
 * `cf-connecting-ip` with the *node's* address -- so those mirrors
 * return the node's own IP, which is exactly what a working tunnel looks
 * like (HANDOVER-2026-08-22 §6 item 4; measured, turkey-1 answering
 * `130.94.0.27` where finland1 answered the real client address).
 *
 * `publicIp` used to discard this, and the comparison at the heart of
 * the whole file was therefore between two numbers that were not
 * necessarily measuring the same thing. A baseline taken via the CDN and
 * an after-reading taken via a node mirror differ with no routing change
 * whatsoever -- a fabricated "throughTunnel" out of two honest answers
 * to two different questions.
 */
type IpReading = { ip: string; from: string };

async function publicIp(): Promise<IpReading | null> {
  // The same endpoint list the rest of the app uses, and for a sharper
  // reason here: this check decides whether the customer is told they
  // are protected. Pinned to one address, a blocked control plane would
  // report a perfectly working tunnel as carrying nothing -- turning a
  // reachability problem into a false accusation against the VPN.
  //
  // Each endpoint gets its own budget rather than sharing one. A first
  // address that is blocked burns the whole timeout doing nothing, and a
  // shared deadline would leave the working one no time to answer.
  for (const base of await apiEndpoints()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EGRESS_TIMEOUT_MS);
      const res = await fetch(`${base}/health/ip`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = (await res.json()) as { ip?: string };
      if (body.ip) return { ip: body.ip, from: base };
    } catch {
      // Try the next one. Exhausting the list returns null, which the
      // caller already treats as "no evidence" rather than as failure.
    }
  }
  return null;
}

/** The address the world saw before connecting, and who reported it.
 *
 * Null means we could not establish a baseline. That is not a failure to
 * report to anyone -- it just means the after-check has nothing to
 * compare against and must not claim the tunnel is broken.
 */
export type BaselineIp = IpReading;
export const captureBaselineIp = publicIp;

export type EgressVerdict =
  /** The exit address changed: traffic is provably leaving via the VPN. */
  | { state: "throughTunnel"; exitIp: string }
  /** Reachable, but from the same address as before -- the tunnel is not
   * carrying this traffic. The leak case. */
  | { state: "bypassingTunnel"; exitIp: string }
  /** Nothing answered. Either the tunnel is black-holing traffic or the
   * connection is genuinely down; both mean the customer is not working. */
  | { state: "unreachable" }
  /** No comparison was possible: either there is no baseline at all, or
   * the two readings did not come from the same endpoint and so are not
   * measuring the same thing. Reported rather than guessed, so the UI
   * can withhold a verdict instead of inventing one in either
   * direction. */
  | { state: "indeterminate"; exitIp: string | null };

/** Compares the address the world sees now against the one it saw before
 * connecting.
 *
 * Two readings only mean something together when they were taken through
 * the same endpoint. `/health/ip` answers "what is the last untrusted hop
 * before the backend", and the node mirrors in the fallback list answer
 * it differently from the CDN -- see `IpReading`. A pair that straddles
 * two endpoints is therefore not a before-and-after at all, and the
 * difference between them says nothing about where packets went.
 *
 * That mismatch is reported as `indeterminate` rather than as either
 * verdict. Calling it `throughTunnel` was the false positive that made
 * this guard necessary; calling it `bypassingTunnel` would be a false
 * accusation built on the same non-comparison.
 *
 * In practice the endpoints match on essentially every check -- the list
 * is tried in a fixed order and the first entry answers -- so the guard
 * costs nothing until the fallback actually shifts, which is exactly the
 * moment the comparison stops being valid.
 */
export async function verifyEgress(baseline: BaselineIp | null): Promise<EgressVerdict> {
  const reading = await publicIp();

  if (reading === null) return { state: "unreachable" };
  if (baseline === null) return { state: "indeterminate", exitIp: reading.ip };
  if (reading.from !== baseline.from) return { state: "indeterminate", exitIp: reading.ip };
  return reading.ip === baseline.ip
    ? { state: "bypassingTunnel", exitIp: reading.ip }
    : { state: "throughTunnel", exitIp: reading.ip };
}

/* ------------------------------------------------------------------ *
 * IPv6, which everything above is blind to.
 *
 * The check at the top of this file compares one address against
 * another. That is a complete answer for IPv4 and no answer at all for
 * IPv6, because a machine can have both families and they can behave
 * differently: `/health/ip` is reached over IPv4, returns the node's
 * address, and the comparison says "throughTunnel" -- while the same
 * machine's IPv6 walks out of the physical NIC in clear text.
 *
 * That is not hypothetical. It is what was measured on client 0.9.25
 * with plain full tunnel and split tunnel off, on OpenVPN, IKEv2 and
 * Xray VLESS-REALITY, with a packet capture taken outside the guest. In
 * every case this file said the customer was protected.
 *
 * So the leak has its own instrument. The question it asks is not "does
 * the internet work" but the narrower one that can actually come back
 * negative: **can this machine still reach a public IPv6 address while
 * connected?** Every Neoxify node is IPv4-only, so a yes means those
 * packets did not go through the tunnel -- there is no tunnel for them
 * to have gone through. A yes is a leak.
 * ------------------------------------------------------------------ */

/** Whether a public IPv6 destination is reachable from here, right now.
 *
 * Answered by a socket in the Rust side rather than by `fetch` here, and
 * that is not a style choice. The app's HTTP permission is scoped to
 * `*.neoxify.site` (see `src-tauri/capabilities/default.json`), so a
 * request to any probe address would be refused by Tauri's own ACL
 * before a packet left -- producing a check that always answers "no
 * IPv6" and can therefore never report the leak it exists to find. This
 * project has shipped enough tests that could not fail.
 *
 * See `vpn::probe_ipv6_egress` for which addresses and why.
 *
 * Never throws: a command that could not be reached is reported as no
 * evidence, not as an accusation.
 */
async function ipv6Reaches(): Promise<boolean> {
  return invoke<boolean>("probe_ipv6_egress").catch(() => false);
}

/** Whether this machine has public IPv6 at all, taken before connecting.
 *
 * The reason to take a baseline rather than just probing once while
 * connected is the common case: **most Windows machines cannot reach
 * public IPv6 to begin with**. Without a baseline, "the probe failed" is
 * indistinguishable between a machine that has no IPv6 and a machine
 * whose IPv6 we successfully blocked, and reporting either as a finding
 * would be inventing evidence.
 *
 * Cheap enough to sit beside the IPv4 baseline: on a machine with no
 * IPv6 the connection fails at once with no route.
 */
export const captureIpv6Baseline = ipv6Reaches;

export type Ipv6Verdict =
  /** Public IPv6 is still getting out while connected. Every node is
   * IPv4-only, so this traffic is provably not in the tunnel. */
  | "escaping"
  /** This machine had IPv6 before connecting and does not now: the block
   * is doing its job, and the customer is told the gap exists. */
  | "blocked"
  /** No public IPv6 here either way. Nothing to report, and nothing to
   * alarm about -- this is what most machines look like. */
  | "absent";

/** Checks IPv6 against the baseline taken before the tunnel came up.
 *
 * `hadIpv6` null means no baseline was taken -- adopting a tunnel that
 * was already up when the app opened, for instance. That is treated as
 * "absent" rather than guessed at: a probe that succeeds with no
 * baseline still means IPv6 is reaching the internet outside an
 * IPv4-only tunnel, but a probe that fails proves nothing, and claiming
 * a block we did not observe would be the same lie in the other
 * direction.
 */
export async function checkIpv6(hadIpv6: boolean | null): Promise<Ipv6Verdict> {
  const reaches = await ipv6Reaches();
  if (reaches) return "escaping";
  return hadIpv6 === true ? "blocked" : "absent";
}
