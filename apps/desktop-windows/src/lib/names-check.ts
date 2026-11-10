import { invoke } from "@tauri-apps/api/core";
import { networkKeyFromAsn } from "./network-identity";

/** Whether Neoxify's own names resolve to public addresses on the network
 * the device is on -- and a small memory of the last time they did not.
 *
 * Some networks answer for our names themselves, with an address of
 * their own on a private range, where the connection then hangs. A
 * request by name there fails only at its connection deadline,
 * ten seconds and more (`CONNECT_TIMEOUT_MS` in api.ts), and the backup
 * route gets its turn after that. Anything with a shorter budget of its
 * own -- the config refresh on resume has six seconds -- gave up before
 * the backup route was ever asked.
 *
 * So api.ts looks, beside a request the backup route may carry
 * (`withLastResort`): the names it is about to ask, through the system
 * resolver, a second and a half at most (`names_resolve_public` in
 * src-tauri/src/names_check.rs). When none of them resolves to a public
 * address, and at least one resolves to an address that is not public,
 * the request stops waiting for them and goes to the backup route then.
 * When any of them resolves to a public address, or the resolver has
 * simply not answered yet, nothing changes -- which is every network the
 * names work on.
 *
 * What is said here is only ever about names: "did not resolve to a
 * public address on this network". Never that a server could not be
 * reached; nothing was dialled to find this out. The command returns a
 * class per name and no address, and nothing here holds one.
 *
 * This file is the look and its memory. When to look, and what to do
 * about the answer, are api.ts's; whether the backup route may be used at
 * all is last-resort.ts's, unchanged.
 */

/** What the resolver said about one name (`NameClass` in names_check.rs).
 * `unknown` is a name the look says nothing about: an address literal,
 * this machine's own name, or one whose requests go through a proxy that
 * resolves it at its own end. */
export type NameClass = "public" | "not-public" | "no-answer" | "unknown";

const CLASSES: ReadonlySet<string> = new Set(["public", "not-public", "no-answer", "unknown"]);

/** All the time one look takes, at most: the command's own cap
 * (`NAMES_CHECK_CAP` in names_check.rs; names-check.test.ts holds the two
 * together). */
export const NAMES_CHECK_MS = 1_500;

/** How long a request by name is left alone before anything looks.
 *
 * Where the names work, the first address has usually answered by then,
 * and for that request nothing is asked of the resolver, the tunnel or
 * anything else: it runs exactly as it did before this file existed. Only
 * a request still unanswered after this is looked at, and where the
 * resolver then gives a public address for any name, that is all that
 * happens. */
export const NAMES_CHECK_AFTER_MS = 500;

/** How long a verdict stands with no newer look: as long as relay mode
 * does (`RELAY_MODE_MS` in last-resort.ts). While relay mode holds,
 * requests go to the backup route first and no look is made, so the two
 * lapse together unless something looks again. */
export const NAMES_VERDICT_MS = 15 * 60_000;

/** How long past its own cap the command may take to return before the
 * look is given up on. */
const CALL_GRACE_MS = 250;

/** The most names one look is given (`MAX_NAMES` in names_check.rs). */
const MAX_NAMES = 64;

const UNKNOWN_NETWORK = "unknown";

type Resolver = (hosts: string[]) => Promise<unknown>;

const viaCommand: Resolver = (hosts) => invoke<unknown>("names_resolve_public", { hosts });

let resolver: Resolver = viaCommand;
let clock: () => number = () => Date.now();
let afterMs = NAMES_CHECK_AFTER_MS;

/** Network key -> when a look last found no name resolving to a public
 * address there. For this run only: a fresh start knows nothing, and
 * looks for itself. */
const verdicts = new Map<string, number>();

/** Looks under way, by network and names, so requests that start
 * together share one. */
const looks = new Map<string, Promise<boolean>>();

/** The carrier, as the relay's own memories key it (`networkKey` in
 * last-resort.ts), or one shared bucket when unknown. */
function networkNow(): string {
  try {
    return networkKeyFromAsn(clock()) ?? UNKNOWN_NETWORK;
  } catch {
    return UNKNOWN_NETWORK;
  }
}

/** The distinct names in `bases`, or null when one of them is not a URL:
 * then the list is not one this file can say anything about. */
function namesOf(bases: readonly string[]): string[] | null {
  const names = new Set<string>();
  for (const base of bases) {
    let name: string;
    try {
      name = new URL(base).hostname;
    } catch {
      return null;
    }
    if (name === "") return null;
    names.add(name);
  }
  return [...names].sort();
}

/** The command's answer for `names`, or null when there is none to read:
 * a build without the command (the web portal, the macOS app), a call
 * that failed or never returned, or anything but a class for every name. */
async function classesOf(names: string[]): Promise<NameClass[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAMES_CHECK_MS + CALL_GRACE_MS);
  });
  try {
    const asked = Promise.resolve()
      .then(() => resolver(names))
      .then(
        (found) => found,
        () => null,
      );
    const found = await Promise.race([asked, stalled]);
    if (!Array.isArray(found) || found.length !== names.length) return null;
    if (!found.every((entry) => typeof entry === "string" && CLASSES.has(entry))) return null;
    return found as NameClass[];
  } finally {
    clearTimeout(timer);
  }
}

/** Looks at how the names of `bases` resolve on this network, now, and
 * says whether none of them resolves to a public address: every one
 * either resolved to nothing public, or got no answer from the resolver
 * within the cap -- and at least one did resolve, to an address that is
 * not public.
 *
 * That last part is what tells a network answering for our names itself
 * from one that is only slow, or not carrying anything yet. A resolver
 * that has said nothing at all inside a second and a half is what a weak
 * signal looks like, and a link still coming up after a resume; the names
 * work there, a little later, and such a request is left alone. Silence
 * counts only beside a name the network did answer for.
 *
 * False when any name resolves to a public address -- a request may be
 * answered there, and is left to find out. False too for anything short
 * of an answer about every name: a name the look says nothing about
 * (`unknown`), a list with something in it that is not a URL, more names
 * than one look takes, or no word from the command at all.
 *
 * What it finds is kept for `namesBlockedHere`, under the network the
 * look was made on: true sets the verdict, an answer that is not true
 * lifts it, and no answer leaves it as it was.
 *
 * Never rejects, and never takes much longer than `NAMES_CHECK_MS`. */
export function namesFailHere(bases: readonly string[]): Promise<boolean> {
  const names = namesOf(bases);
  if (names === null || names.length === 0 || names.length > MAX_NAMES) return Promise.resolve(false);
  const network = networkNow();
  const key = `${network} ${names.join(" ")}`;
  const held = looks.get(key);
  if (held !== undefined) return held;
  const look: Promise<boolean> = classesOf(names)
    .then(
      (found) => {
        if (found === null) return false;
        const failing =
          found.every((entry) => entry === "not-public" || entry === "no-answer") &&
          found.some((entry) => entry === "not-public");
        if (failing) verdicts.set(network, clock());
        else verdicts.delete(network);
        return failing;
      },
      () => false,
    )
    .finally(() => {
      if (looks.get(key) === look) looks.delete(key);
    });
  looks.set(key, look);
  return look;
}

/** Whether the last look on the network the device is on now found none
 * of Neoxify's names resolving to a public address, within the last
 * `NAMES_VERDICT_MS`.
 *
 * Read-only: nothing is asked of anything. True from such a look until a
 * later one on this network finds a name that does resolve, or fifteen
 * minutes pass with no look at all. False is "not known to be so", not
 * "the names work": nothing looks while a tunnel is up or a connect is
 * running, while the backup route is switched off, or on a request that
 * was answered inside its first half second.
 *
 * An answer from the API does not lift it, as a rule. One that came
 * through a tunnel says nothing about the network underneath, and from
 * here the two cannot be told apart; the next look does that. The one
 * exception is `namesAnsweredHere`.
 *
 * It says how names resolve here, and nothing about any server: none was
 * dialled to find it out. A resolver that only gave no answer never sets
 * it (`namesFailHere`), so a dead link does not read as a blocked one.
 * The network is the carrier as last read (`networkNow`), or one shared
 * bucket while that is unknown. */
export function namesBlockedHere(): boolean {
  const at = verdicts.get(networkNow());
  if (at === undefined) return false;
  const age = clock() - at;
  return age >= 0 && age < NAMES_VERDICT_MS;
}

/** Lifts the verdict on the network the device is on now: a request by
 * name has been answered here.
 *
 * For api.ts, about the one answer it can place: to a request it was
 * looking beside, moments after the tunnel was read as down
 * (`ordinaryUnlessNamesFail`). Whatever the resolver said, a name that
 * has just answered is one that works. */
export function namesAnsweredHere(): void {
  verdicts.delete(networkNow());
}

/** How long api.ts leaves a request by name alone before it looks
 * (`NAMES_CHECK_AFTER_MS`, unless a test has set another). */
export function namesCheckAfterMs(): number {
  return afterMs;
}

/** For tests: a fresh run, with a fake resolver, clock and head start. */
export function resetNamesCheckForTests(
  options: { resolve?: Resolver; now?: () => number; afterMs?: number } = {},
): void {
  verdicts.clear();
  looks.clear();
  resolver = options.resolve ?? viaCommand;
  clock = options.now ?? (() => Date.now());
  afterMs = options.afterMs ?? NAMES_CHECK_AFTER_MS;
}
