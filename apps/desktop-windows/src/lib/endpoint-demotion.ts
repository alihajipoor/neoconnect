import { isKnownBlockPage } from "./endpoint-bundle-store";
import { networkKeyFromAsn } from "./network-identity";
import { isAddressLiteral, resolveIpv4, RESOLVE_TIMEOUT_MS } from "./tunnel-server";

/** Which control-plane addresses have recently failed on this network,
 * so that a race asks them last.
 *
 * A race gives the first address a head start and then asks the rest
 * (`staggeredRace` in api.ts). Without a memory of what failed, every
 * race on a filtered network asked the same dead addresses again: the
 * Iranian mirror that has not completed a TCP handshake since its node
 * went offline, a name the network's resolver answers with its block
 * page, the CDN where it is blackholed. Each one is a connection opened,
 * a handshake attempted, and -- when it happens to come first in the list
 * -- a head start spent waiting on it.
 *
 * Two things demote:
 *
 *  - a timeout, which demotes the address: it took the whole of its
 *    deadline without answering, the connection deadline included
 *    (`failedAs` in api.ts). That is what a blackholed address does, and
 *    the costly kind of failure. A refusal that comes back at once costs
 *    a race nothing and is not counted;
 *  - Iran's DNS block page, which demotes the name, and with it every
 *    address under it whatever the port: the resolver's answer is for the
 *    name. Censored, definitively, for as long as this network's resolver
 *    says so. Seen by a race itself (`resolvesToBlockPage`), and by the
 *    socket-level probe after a request that failed everywhere
 *    (control-plane-probe.ts).
 *
 * The block page is the common case in Iran, not an edge. Measured from
 * a server inside the country on 2026-10-10, and in testers' reports:
 * every name under the mirror domain and under neoxify.site resolved
 * into it on every resolver tried, public ones over plain DNS included
 * -- the answer is injected on the path -- and on one tester's network
 * the two CDN names did as well. Which names are blocked therefore
 * differs from one network to the next, and the memory is kept per
 * network.
 *
 * A demoted address is asked last, never not at all. A block that has
 * lifted, a network that has changed under a stale key, a failure that was
 * the device's own sleep: each costs a demoted address one head start in
 * the next race, and its first answer of any kind lifts the demotion, of
 * its name as well. And it lapses on its own after `DEMOTED_FOR_MS`.
 *
 * Kept per network, because which addresses are blocked is a property of
 * the network: what failed on mobile data says nothing about home Wi-Fi.
 * The key is the carrier (`networkKeyFromAsn`), the one network identity
 * both apps have; two Wi-Fi networks on one ISP share it. It is learned
 * from the pre-connect baseline, so a device that has changed network and
 * not connected since is still filed under the old one -- which the
 * expiry bounds, and an answer from any demoted address undoes.
 *
 * Kept in the webview's storage, so a restart -- which is what people do
 * when an app cannot reach its server -- does not ask the dead addresses
 * all over again. Best effort: without storage it lasts the run. */

/** How long an address that failed stays at the back of the order. */
export const DEMOTED_FOR_MS = 30 * 60_000;

/** How long one look at a name's DNS answer (`resolvesToBlockPage`) is
 * taken as the answer on the same network.
 *
 * A race that has gone past its first address looks at the name of every
 * address it asks, and on a filtered network that is most races. A minute
 * keeps the dashboard's three reads, a resume refresh and the picker from
 * each asking the resolver about the same sixteen names, while a block
 * that lands or lifts is noticed within it. */
export const LOOKUP_REUSED_FOR_MS = 60_000;

const STORAGE_KEY = "neoxify.endpointDemotions";

/** The bucket for a device whose network is not known. */
const UNKNOWN_NETWORK = "unknown";

/** What has failed on one network, and when (epoch ms): addresses that
 * timed out, by address, and names that resolved into the block page, by
 * name. */
interface Failures {
  bases: Record<string, number>;
  names: Record<string, number>;
}

/** Network key, then what failed on it. */
type Memory = Record<string, Failures>;

let memory: Memory = {};
let restored = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Only the entries that are a time each. */
function timesIn(value: unknown): Record<string, number> {
  const times: Record<string, number> = {};
  if (value === null || typeof value !== "object") return times;
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) times[key] = at;
  }
  return times;
}

/** Restored lazily, once a run. Anything unreadable is dropped: an
 * address wrongly kept at the back costs more than one asked too early. */
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return;
    for (const [network, failures] of Object.entries(parsed as Record<string, unknown>)) {
      if (failures === null || typeof failures !== "object") continue;
      const { bases, names } = failures as Record<string, unknown>;
      memory[network] = { bases: timesIn(bases), names: timesIn(names) };
    }
  } catch {
    memory = {};
  }
}

function persist(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // The order this run is unaffected; only a restart forgets.
  }
}

/** Whether a demotion recorded at `at` still stands at `now`. A clock set
 * back is not a recent failure. */
function stands(at: number | undefined, now: number): boolean {
  if (at === undefined) return false;
  const age = now - at;
  return age >= 0 && age < DEMOTED_FOR_MS;
}

/** Drops every demotion that has lapsed, on every network, so the memory
 * holds only the last half hour. */
function prune(now: number): void {
  for (const [network, failures] of Object.entries(memory)) {
    for (const times of [failures.bases, failures.names]) {
      for (const [key, at] of Object.entries(times)) if (!stands(at, now)) delete times[key];
    }
    if (Object.keys(failures.bases).length === 0 && Object.keys(failures.names).length === 0) delete memory[network];
  }
}

/** This network's key. Never throws: the order is advice, and a request
 * must not fail because the network could not be named. */
function networkNow(now: number): string {
  try {
    return networkKeyFromAsn(now) ?? UNKNOWN_NETWORK;
  } catch {
    return UNKNOWN_NETWORK;
  }
}

/** The name in an address, or null for one that is not a URL. */
function nameOf(base: string): string | null {
  try {
    return new URL(base).hostname || null;
  } catch {
    return null;
  }
}

function record(network: string, kind: keyof Failures, key: string, now: number): void {
  restore();
  prune(now);
  const failures = (memory[network] ??= { bases: {}, names: {} });
  failures[kind][key] = now;
  persist();
}

/** Records that `base` has just timed out on this network. */
export function demoteEndpoint(base: string, now = Date.now()): void {
  record(networkNow(now), "bases", base, now);
}

/** Records that `host` resolves into the block page on this network:
 * every address under it is asked last. */
export function demoteName(host: string, now = Date.now()): void {
  record(networkNow(now), "names", host, now);
}

/** `base` has answered on this network -- with anything, from the
 * backend or from a page in front of it. Either way the network let a
 * request through to it, so it is no longer demoted here; and its name
 * resolved to a server that holds a certificate for it, so the name is
 * not the block page here either. */
export function clearDemotion(base: string, now = Date.now()): void {
  restore();
  const name = nameOf(base);
  // A look at the name that found the block page is out of date too, and
  // would otherwise keep the race from sending to the name for the rest
  // of its minute (`knownOnBlockPage`).
  if (name !== null && currentLookup(base, now)?.found === true) lookups.delete(`${networkNow(now)} ${name}`);
  const failures = memory[networkNow(now)];
  if (failures === undefined) return;
  const hadBase = base in failures.bases;
  const hadName = name !== null && name in failures.names;
  if (!hadBase && !hadName) return;
  delete failures.bases[base];
  if (name !== null) delete failures.names[name];
  prune(now);
  persist();
}

/** `endpoints` with the addresses demoted on this network moved to the
 * end, each part in the order it had, and how many lead the list
 * undemoted.
 *
 * When every address is demoted, none is singled out: `healthy` is the
 * whole list, in the order given. That is a network on which nothing has
 * answered lately, and the list's own order is as good a guess as any. */
export function demotedLast(endpoints: readonly string[], now = Date.now()): { ordered: string[]; healthy: number } {
  restore();
  const failures = memory[networkNow(now)];
  const demoted = (base: string) => {
    if (failures === undefined) return false;
    const name = nameOf(base);
    return stands(failures.bases[base], now) || (name !== null && stands(failures.names[name], now));
  };
  const healthy = endpoints.filter((base) => !demoted(base));
  if (healthy.length === 0) return { ordered: [...endpoints], healthy: endpoints.length };
  return { ordered: [...healthy, ...endpoints.filter(demoted)], healthy: healthy.length };
}

/** One look at a name's DNS answer: when, and what it found -- or will
 * find, while it is still under way. */
interface Lookup {
  at: number;
  blocked: Promise<boolean>;
  /** Set once the answer is in. */
  found?: boolean;
}

/** Recent looks, by network and name. */
const lookups = new Map<string, Lookup>();

/** The look at `base`'s name that is still current on this network, if
 * there is one. */
function currentLookup(base: string, now: number): Lookup | undefined {
  const name = nameOf(base);
  if (name === null) return undefined;
  const look = lookups.get(`${networkNow(now)} ${name}`);
  if (look === undefined || now - look.at < 0 || now - look.at >= LOOKUP_REUSED_FOR_MS) return undefined;
  return look;
}

/** Whether a look at `base`'s name made in the last
 * `LOOKUP_REUSED_FOR_MS` on this network has already found the block page
 * and nothing else (`resolvesToBlockPage`). Then the race does not send
 * the request at all: it would only open a connection to the block page. */
export function knownOnBlockPage(base: string, now = Date.now()): boolean {
  return currentLookup(base, now)?.found === true;
}

/** Whether `base`'s name resolves, on this network, to Iran's block page
 * and nothing else (`isKnownBlockPage`). When it does, the name is
 * demoted here.
 *
 * A request to such an address goes to the block page, which can never
 * answer as us: its certificate is not ours. Until something looks, it is
 * one more address the race waits for -- in the lead, for the whole head
 * start, when it was the last to answer before the block -- and the HTTP
 * plugin reports its failure as it reports any other, or not at all when
 * the page leaves the handshake hanging. So a race looks for itself,
 * alongside the request (`staggeredRace` in api.ts), and stops the
 * request when the answer is the block page.
 *
 * Asked of the system resolver, which is what the HTTP plugin's own
 * lookup asks moments earlier or later (`resolve_ipv4`), so it sends
 * nothing a censor has not already seen and is usually answered from the
 * resolver's cache. Only whether the answer is the block page is kept,
 * never the addresses. Nothing but the block page, rather than any of it,
 * because a request is stopped on this answer, and a name that also
 * resolves somewhere real might still be reached there.
 *
 * Never rejects. False for an address literal, a build without the
 * command (the web portal), and a lookup that fails or takes longer than
 * `RESOLVE_TIMEOUT_MS`: nothing known. One look is reused for
 * `LOOKUP_REUSED_FOR_MS` on the same network, including while it is still
 * under way. */
export function resolvesToBlockPage(base: string, now = Date.now()): Promise<boolean> {
  const name = nameOf(base);
  if (name === null || isAddressLiteral(name)) return Promise.resolve(false);
  const held = currentLookup(base, now);
  if (held !== undefined) return held.blocked;
  for (const [key, look] of lookups) {
    if (now - look.at < 0 || now - look.at >= LOOKUP_REUSED_FOR_MS) lookups.delete(key);
  }
  const network = networkNow(now);
  const look: Lookup = { at: now, blocked: Promise.resolve(false) };
  look.blocked = resolveIpv4(name, RESOLVE_TIMEOUT_MS).then(
    (addresses) => {
      const found = addresses.length > 0 && addresses.every((address) => isKnownBlockPage(address));
      look.found = found;
      // Filed under the network the lookup was made on.
      if (found) record(network, "names", name, Date.now());
      return found;
    },
    () => false,
  );
  lookups.set(`${network} ${name}`, look);
  return look.blocked;
}

/** For tests: forget what this run holds, as a fresh process would. What
 * is in storage is read again on next use. */
export function resetDemotionsForTests(): void {
  memory = {};
  restored = false;
  lookups.clear();
}
