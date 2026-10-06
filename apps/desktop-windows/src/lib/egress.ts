import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints } from "./api-endpoints";
import { rememberNetwork } from "./network-identity";

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
 * used to claim was no hole at all. A machine leaking IPv6 alongside a
 * perfectly good IPv4 tunnel reads as "throughTunnel". That combination
 * was measured, on three of the four protocols tested. The IPv6 check at
 * the bottom of this file exists because of it.
 *
 * And the comparison is only IPv4 at all where something makes it so.
 * This file used to assume `/health/ip` was always reached over IPv4,
 * which holds for a reading taken through a node -- every node is
 * IPv4-only, and a full tunnel blocks IPv6 machine-wide -- and not for
 * the baseline: on a machine with native IPv6, an endpoint with an AAAA
 * record is reached over IPv6 first, so the baseline was the customer's
 * IPv6 address. Against that, any IPv4 reading differs, and the check
 * said "throughTunnel" whatever IPv4 was doing -- including going round
 * the tunnel in the clear. Two things now stop that: the Windows client
 * asks over IPv4 only (`setHealthIpTransport`, `health-ip-v4.ts`), and a
 * pair of different families is never compared (`verifyEgress`).
 */

/** Short: this runs while the customer is watching a spinner, and a
 * server that will not answer quickly has already failed the check. */
export const EGRESS_TIMEOUT_MS = 6000;

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
 * its own address -- shown here as `203.0.113.20`, an RFC 5737 stand-in;
 * node addresses are not committed, see docs/node-address-hygiene.md --
 * where finland1 answered the real client address).
 *
 * `publicIp` used to discard this, and the comparison at the heart of
 * the whole file was therefore between two numbers that were not
 * necessarily measuring the same thing. A baseline taken via the CDN and
 * an after-reading taken via a node mirror differ with no routing change
 * whatsoever -- a fabricated "throughTunnel" out of two honest answers
 * to two different questions.
 */
type IpReading = { ip: string; from: string };

async function publicIp(onBody?: (body: Record<string, unknown>) => void): Promise<IpReading | null> {
  // The same endpoint list the rest of the app uses, and for a sharper
  // reason here: this check decides whether the customer is told they
  // are protected. Pinned to one address, a blocked control plane would
  // report a perfectly working tunnel as carrying nothing -- turning a
  // reachability problem into a false accusation against the VPN.
  return (await readFrom(await apiEndpoints(), EGRESS_TIMEOUT_MS, onBody)).reading;
}

/** What asking the list produced: a reading, and -- whether or not there
 * was one -- whether anything answered at all.
 *
 * The second half is the difference between "our API is having a bad
 * day" and "nothing gets through this tunnel", and the two used to be
 * the same `null`. Every base is https, so an HTTP status of any kind --
 * the 502 every mirror and the CDN return while the backend container is
 * being rebuilt, say -- can only have come from our own CDN, mirror or
 * panel, after a TLS handshake with one of our names. A censor cannot
 * forge one, and packets that made that round trip were not black-holed.
 */
type ReadResult = { reading: IpReading | null; answered: boolean };

/** What one `/health/ip` request came back with: the HTTP status, and
 * the parsed body when there was a JSON one. */
export type HealthIpAnswer = { status: number; body: unknown };

/** How one `/health/ip` request is made. Resolves with whatever HTTP
 * answer came back, of any status; rejects only when none did -- that
 * difference is `ReadResult.answered`. */
export type HealthIpTransport = (base: string, timeoutMs: number) => Promise<HealthIpAnswer>;

/** The default: tauri-plugin-http's fetch, which lets the system choose
 * the address family. What the mobile app, which shares this file, uses. */
const fetchTransport: HealthIpTransport = async (base, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health/ip`, { signal: controller.signal });
    const body: unknown = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

let transport: HealthIpTransport = fetchTransport;

/** Replaces how `/health/ip` is asked. The Windows client installs an
 * IPv4-only transport at startup (`health-ip-v4.ts`, from `main.tsx`), so
 * the baseline and every later reading are the same family. */
export function setHealthIpTransport(next: HealthIpTransport): void {
  transport = next;
}

/** Which family an address reported by `/health/ip` belongs to. An
 * IPv4-mapped IPv6 literal is the IPv4 address it carries. */
function familyOf(ip: string): 4 | 6 {
  return plainAddress(ip).includes(":") ? 6 : 4;
}

/** An address as compared: an IPv4-mapped IPv6 literal is the IPv4
 * address it carries, so one server writing the same address two ways
 * cannot read as a change of route. */
function plainAddress(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** The first answer from `bases`, tried in order.
 *
 * Each endpoint gets its own budget rather than sharing one. A first
 * address that is blocked burns the whole timeout doing nothing, and a
 * shared deadline would leave the working one no time to answer.
 */
async function readFrom(
  bases: string[],
  timeoutMs: number,
  onBody?: (body: Record<string, unknown>) => void,
): Promise<ReadResult> {
  let answered = false;
  for (const base of bases) {
    try {
      const res = await transport(base, timeoutMs);
      // Set before the status is looked at: an error page is still an
      // answer, and it is the only thing that tells an outage of ours
      // apart from a tunnel carrying nothing.
      answered = true;
      if (res.status < 200 || res.status >= 300) continue;
      const body = res.body;
      if (body !== null && typeof body === "object" && typeof (body as { ip?: unknown }).ip === "string") {
        const ip = (body as { ip: string }).ip;
        if (ip) {
          onBody?.(body as Record<string, unknown>);
          return { reading: { ip, from: base }, answered };
        }
      }
    } catch {
      // Try the next one. Exhausting the list returns no reading, which
      // the caller already treats as "no evidence" rather than as
      // failure.
    }
  }
  return { reading: null, answered };
}

/** The address the world saw before connecting, and who reported it.
 *
 * Null means we could not establish a baseline. That is not a failure to
 * report to anyone -- it just means the after-check has nothing to
 * compare against and must not claim the tunnel is broken.
 */
export type BaselineIp = IpReading;

/** Takes the baseline, and keeps what the server said about the
 * network while it is at it.
 *
 * Only here, never in the after-connect check: a baseline is taken with
 * no tunnel up, so it is the one reading whose network is the customer's
 * own. See network-identity.ts. A baseline that could not be taken at
 * all leaves the held network alone -- no answer is not evidence of a
 * different network. */
export const captureBaselineIp = (): Promise<IpReading | null> => publicIp((body) => rememberNetwork(body));

export type EgressVerdict =
  /** The exit address changed: traffic is provably leaving via the VPN. */
  | { state: "throughTunnel"; exitIp: string }
  /** Reachable, but from the same address as before -- the tunnel is not
   * carrying this traffic. The leak case. */
  | { state: "bypassingTunnel"; exitIp: string }
  /** Nothing answered. Either the tunnel is black-holing traffic or the
   * connection is genuinely down; both mean the customer is not working. */
  | { state: "unreachable" }
  /** No comparison was possible: either there is no baseline at all, the
   * two readings did not come from the same endpoint and so are not
   * measuring the same thing, or our API answered but with no address
   * to compare (an outage of ours, not of the tunnel). Reported rather
   * than guessed, so the UI can withhold a verdict instead of inventing
   * one in either direction. */
  | { state: "indeterminate"; exitIp: string | null };

export type VerifyOptions = {
  /** How long each endpoint gets. Defaults to the full
   * `EGRESS_TIMEOUT_MS`; the connect path passes what is left of its
   * budget when that is less. */
  attemptMs?: number;
  /** Ask only the baseline's endpoint, with no fallback.
   *
   * Any other endpoint can at best answer `indeterminate`, and while
   * another protocol is waiting to be tried that is rejected exactly as
   * "unreachable" is -- so the fallback can only spend time. Where
   * `indeterminate` does change the outcome (the ladder's last rung, the
   * health poll) the fallback stays.
   */
  sameEndpointOnly?: boolean;
};

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
 *
 * With `sameEndpointOnly`, the baseline's endpoint is the only one asked.
 * It is the only one whose answer can prove anything, and its name was
 * resolved moments ago for the baseline, so it is also the one request
 * that does not have to wait on DNS. That second point was measured, not
 * assumed: in OpenVPN's first seconds -- the new adapter's address still
 * settling, every connection refused for about two seconds -- the first
 * endpoint failed at once, the second hung for the full six-second
 * timeout, and the third answered with the node's address from the
 * wrong endpoint. The tunnel had been carrying traffic for four of those
 * seconds and the ladder threw it away.
 *
 * Without it the list keeps its fixed order rather than moving the
 * baseline's endpoint to the front. A baseline can come from a mirror
 * that reports its own node's address to everyone; asked again it
 * answers the same, and comparing those two would accuse a working
 * tunnel of leaking where the list order lets the CDN answer and the
 * guard above say, correctly, that nothing was compared.
 */
export async function verifyEgress(
  baseline: BaselineIp | null,
  options: VerifyOptions = {},
): Promise<EgressVerdict> {
  const { attemptMs = EGRESS_TIMEOUT_MS, sameEndpointOnly = false } = options;
  const bases =
    sameEndpointOnly && baseline !== null ? [baseline.from] : await apiEndpoints();
  const { reading, answered } = await readFrom(bases, attemptMs);

  // Our API answered -- with a 502 while the backend is being redeployed,
  // a 503 from a mirror whose upstream is gone -- and said nothing about
  // addresses. That is an outage of ours, and the round trip itself
  // shows packets are getting through. Calling it `unreachable` turned
  // it into "degraded" on every connected customer at once, and two of
  // those in a row ran the automatic ladder: a working tunnel torn down,
  // every protocol then rejected against the same 502, the customer left
  // disconnected and failing open. The tunnel's health is not ours to
  // borrow from the control plane's.
  if (reading === null && answered) return { state: "indeterminate", exitIp: null };
  // Nothing of ours answered at all: every request timed out or was
  // refused. That is what a black-holing tunnel looks like -- and also
  // what our panel host being down, or our CDN refusing the node's exit
  // address, looks like from a tunnel that is fine. A second, independent
  // instrument tells them apart: if the public internet answers, traffic
  // is flowing and the silence is ours, so there is no verdict. Only
  // when that fails too is it the tunnel.
  if (reading === null) {
    return (await ipv4Reaches()) ? { state: "indeterminate", exitIp: null } : { state: "unreachable" };
  }
  if (baseline === null) return { state: "indeterminate", exitIp: reading.ip };
  if (reading.from !== baseline.from) return { state: "indeterminate", exitIp: reading.ip };
  // Two families are two different questions, like two endpoints. An
  // IPv6 baseline -- a dual-stack machine reaching an endpoint with an
  // AAAA record before connecting -- against the IPv4 reading every full
  // tunnel produces differs whatever IPv4 did, and called that
  // "throughTunnel" with the customer's own IPv4 address on screen as
  // the exit. The Windows client now asks over IPv4 only, so this does
  // not fire there; it is what keeps the mobile app, and anything that
  // ever skips that, from reading a non-comparison as proof.
  if (familyOf(reading.ip) !== familyOf(baseline.ip)) {
    return { state: "indeterminate", exitIp: reading.ip };
  }
  return plainAddress(reading.ip) === plainAddress(baseline.ip)
    ? { state: "bypassingTunnel", exitIp: reading.ip }
    : { state: "throughTunnel", exitIp: reading.ip };
}

/** Whether the public IPv4 internet answers from here, asked only when
 * none of our own endpoints did. See `vpn::probe_ipv4_egress`.
 *
 * A socket in the Rust side, for the reason `ipv6Reaches` gives: the
 * HTTP permission would refuse any address that is not ours.
 *
 * Never throws. A command that could not be reached -- the mobile app,
 * which shares this file and does not register it -- is no evidence, and
 * leaves the verdict exactly where it was before this existed. */
async function ipv4Reaches(): Promise<boolean> {
  try {
    return (await invoke<boolean>("probe_ipv4_egress")) === true;
  } catch {
    return false;
  }
}

/** How often a new attempt starts while a tunnel is being checked. */
export const VERIFY_INTERVAL_MS = 1_500;

/** Waits up to `budgetMs` for proof that traffic leaves through the
 * tunnel, rather than asking once.
 *
 * Retries even on a definite-looking "bypassing" answer, because early in
 * a connection it is not definite at all: OpenVPN's routes arrive from
 * the server partway through negotiation, so traffic genuinely does go
 * around the tunnel for a moment before it goes through it.
 *
 * Returns as soon as it has proof, so a fast protocol stays fast.
 * Otherwise it returns the most recent answer once the budget is spent.
 *
 * **Attempts overlap.** A new one starts every `intervalMs` whether or
 * not the previous one has finished, and none is cancelled for being
 * slow; each is bounded only by what is left of the budget. This is the
 * whole of the change from asking in sequence, and the reason was
 * measured on a Windows 11 guest. For two or three seconds after
 * OpenVPN's routes appear, the new adapter's address is still settling:
 * a request made then is refused outright or, worse, stalls -- its SYN
 * is lost, Windows retransmits at three seconds and next at nine, so it
 * sits there long after the tunnel has started carrying traffic. Asked
 * in sequence, that one stalled request was the whole six-second
 * failover check, and a working OpenVPN was rejected every time on a
 * first connect. Cutting it off sooner does not help either; a fresh
 * request made after the address settles is what succeeds, and starting
 * one every interval guarantees there is one.
 *
 * The cost is a few extra `/health/ip` requests during a connect, to our
 * own API.
 */
export function confirmEgressWithin(
  baseline: BaselineIp | null,
  budgetMs: number,
  options: { sameEndpointOnly?: boolean; intervalMs?: number } = {},
): Promise<EgressVerdict> {
  const { sameEndpointOnly = false, intervalMs = VERIFY_INTERVAL_MS } = options;
  const deadline = Date.now() + budgetMs;
  let last: EgressVerdict = { state: "unreachable" };

  return new Promise((resolve) => {
    let done = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    const finish = (verdict: EgressVerdict) => {
      if (done) return;
      done = true;
      clearTimeout(next);
      clearTimeout(cutoff);
      resolve(verdict);
    };
    const cutoff = setTimeout(() => finish(last), budgetMs);

    const attempt = () => {
      const remaining = deadline - Date.now();
      if (done || remaining <= 0) return;
      verifyEgress(baseline, {
        attemptMs: Math.min(EGRESS_TIMEOUT_MS, remaining),
        sameEndpointOnly,
      })
        .then((verdict) => {
          if (verdict.state === "throughTunnel") finish(verdict);
          // With no baseline there is no proof to wait for: the best any
          // later attempt can say is this. Waiting out the budget only
          // held a customer whose network will not let us take one --
          // our API down, or every address filtered -- on a spinner for
          // thirty seconds before the handshake was even asked.
          else if (baseline === null && verdict.state === "indeterminate") finish(verdict);
          else last = verdict;
        })
        // A rejection is no evidence either way; the next attempt is
        // already scheduled.
        .catch(() => undefined);
      next = setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

/* ------------------------------------------------------------------ *
 * IPv6, which everything above is blind to.
 *
 * The check at the top of this file compares one address against
 * another. That is a complete answer for IPv4 and no answer at all for
 * IPv6, because a machine can have both families and they can behave
 * differently: through a full tunnel `/health/ip` is reached over IPv4
 * (on Windows it is only ever asked over IPv4; see the note at the top),
 * returns the node's address, and the comparison says "throughTunnel" --
 * while the same machine's IPv6 walks out of the physical NIC in clear
 * text.
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
