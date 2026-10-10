import { isKnownBlockPage } from "./endpoint-bundle-store";
import { networkKeyFromAsn } from "./network-identity";
import { isAddressLiteral, resolveAddresses, RESOLVE_TIMEOUT_MS } from "./tunnel-server";

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
  // A look at the name still under way is out of date before it lands:
  // whatever it finds, the name has just been reached. Left to land, a
  // look that found the block page demoted the name, and the next race
  // asked last the address that had answered first -- the shape of a name
  // whose IPv4 answer is the block page and whose IPv6 answer is real, on
  // a network that reaches it over IPv6.
  if (name !== null) {
    for (const look of lookups.values()) if (look.name === name) look.overruled = true;
  }
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
  const demoted = (base: string) => isDemoted(base, now);
  const healthy = endpoints.filter((base) => !demoted(base));
  if (healthy.length === 0) return { ordered: [...endpoints], healthy: endpoints.length };
  return { ordered: [...healthy, ...endpoints.filter(demoted)], healthy: healthy.length };
}

/** Whether `base` is demoted on this network: it timed out here in the
 * last `DEMOTED_FOR_MS`, or its name was found on the block page. */
export function isDemoted(base: string, now = Date.now()): boolean {
  restore();
  const failures = memory[networkNow(now)];
  if (failures === undefined) return false;
  const name = nameOf(base);
  return stands(failures.bases[base], now) || (name !== null && stands(failures.names[name], now));
}

/** One look at a name's DNS answer, while it is under way. */
interface Lookup {
  name: string;
  blocked: Promise<boolean>;
  /** Set when an address under the name answers before the look lands
   * (`clearDemotion`). The look then finds nothing, whatever the resolver
   * said. */
  overruled: boolean;
}

/** Looks under way, by network and name. Only while under way: a race
 * that asks about a name another race is already asking about shares the
 * look, and once it has landed the next race looks again. */
const lookups = new Map<string, Lookup>();

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
 * never the addresses.
 *
 * Nothing but the block page, rather than any of it, because a request is
 * stopped on this answer, and a name that also resolves somewhere real
 * might still be reached there. Its IPv6 addresses count: the HTTP plugin
 * tries them too, and the block page has none. Only IPv4 was looked at
 * before, so a name whose A record was poisoned and whose AAAA record was
 * not had its request stopped before it could connect over IPv6. Whether
 * Iran's injector leaves IPv6 alone is not known; where it does, such a
 * name is left to the request to find out about, as every name was before
 * the lookup existed.
 *
 * Looked at afresh by every race, never remembered once it has landed. A
 * look from a minute ago may describe another path. Before a tunnel comes
 * up the resolver answers with the block page; through the tunnel it
 * answers for real. Remembered for a minute, a look that had found the
 * block page before a connect kept every request for the minute after it
 * from being sent at all -- the slot claim through the tunnel, a server
 * switch -- and the screen said Neoxify could not be reached with nothing
 * dialled. Looked at again, the answer is what the resolver says now,
 * which is also what the request's own lookup is about to be told: from
 * the resolver's cache, usually, so the cost is a call into the app and
 * not a query on the network. Two races asking about one name at once
 * share the look.
 *
 * Never rejects. False for an address literal, a build without the
 * command (the web portal), a lookup that fails or takes longer than
 * `RESOLVE_TIMEOUT_MS`, and a look overtaken by an answer from an address
 * under the name: nothing known. */
export function resolvesToBlockPage(base: string, now = Date.now()): Promise<boolean> {
  const name = nameOf(base);
  if (name === null || isAddressLiteral(name)) return Promise.resolve(false);
  const network = networkNow(now);
  const key = `${network} ${name}`;
  const held = lookups.get(key);
  if (held !== undefined) return held.blocked;
  const look: Lookup = { name, blocked: Promise.resolve(false), overruled: false };
  const landed = () => {
    if (lookups.get(key) === look) lookups.delete(key);
  };
  look.blocked = resolveAddresses(name, RESOLVE_TIMEOUT_MS).then(
    (addresses) => {
      landed();
      if (look.overruled) return false;
      const found = addresses.length > 0 && addresses.every((address) => isKnownBlockPage(address));
      // Filed under the network the lookup was made on.
      if (found) record(network, "names", name, Date.now());
      return found;
    },
    () => {
      landed();
      return false;
    },
  );
  lookups.set(key, look);
  return look.blocked;
}

/** For tests: forget what this run holds, as a fresh process would. What
 * is in storage is read again on next use. */
export function resetDemotionsForTests(): void {
  memory = {};
  restored = false;
  lookups.clear();
}
