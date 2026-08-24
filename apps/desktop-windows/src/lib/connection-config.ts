import { reportAttempt } from "./attempts";
import { isSnapshotStale, loadSnapshot, SNAPSHOT_TTL_MS, updateSnapshotProtocolUsers } from "./credential-cache";
import { getProtocolUsers } from "./customer";
import type { ProtocolUser } from "./types";

/** Fetching the credentials again immediately before dialling.
 *
 * ## The hole this closes
 *
 * `getProtocolUsers()` had exactly one call site: the screen's initial
 * load, plus the retry button and a server switch. No poll, no TTL, and
 * a disk cache that never expired. So whatever the app was handed the
 * first time it managed to reach the control plane was what it dialled,
 * for as long as it stayed open.
 *
 * On Windows that is until the window is closed. On Android it is worse
 * and genuinely unbounded: the WebView survives backgrounding, and on
 * open the screen adopts the tunnel the VpnService kept running rather
 * than reloading. Toggling the VPN off and on re-dials the same values.
 * Nothing short of the customer force-stopping the app refetches.
 *
 * That makes every server-side connection parameter effectively
 * unchangeable. The one that prompted this is france-1's REALITY decoy,
 * which is `cloudflare.com` -- the weakest disguise available, because
 * the decoy *is* the CDN -- and which cannot be moved because moving it
 * strands every client still holding the old SNI, for an unknown length
 * of time, with no way to tell how many or for how long.
 *
 * ## What it deliberately does not do
 *
 * **It does not gate connecting.** If the refresh fails, for any reason,
 * the connect proceeds on what is already held. A customer in Iran whose
 * control plane is filtered must never be stopped from connecting
 * because a config refresh could not complete -- that is the exact
 * outage `credential-cache.ts` was written to end, and re-introducing it
 * through a freshness check would be a regression dressed as a
 * safeguard.
 *
 * **It does not poll.** One request, on the connect path, and only when
 * what is held is past the freshness horizon. An app sitting connected
 * for six hours makes zero extra requests.
 *
 * **It does not reconnect a live session by itself.** See
 * `describeConfigDrift`.
 */

/** Where the credentials about to be dialled came from.
 *
 * The distinction is the entire point of reporting this: "we asked and
 * these are today's values" and "we could not ask, so these are
 * Tuesday's" produce identical-looking connects and mean completely
 * different things when one of them fails.
 */
export type ConfigSource =
  /** Fetched just now. */
  | "network"
  /** Not fetched, because what was held is inside the freshness horizon. */
  | "fresh"
  /** The fetch failed or ran out of budget; dialling on older values. */
  | "stale";

export interface ConfigRefresh {
  /** What to dial. Never empty unless the caller had nothing and the
   * fetch failed, in which case the caller's own "no servers" handling
   * applies unchanged. */
  protocolUsers: ProtocolUser[];
  source: ConfigSource;
  /** Age of the values being returned, in ms, when they did not come
   * off the wire. Null when `source` is "network". */
  ageMs: number | null;
  /** Human-readable, one line per credential whose connection details
   * moved. Empty when nothing changed, which is the overwhelming case. */
  drift: string[];
  /** The server rejected the session rather than being unreachable. The
   * caller owns what to do about that -- signing somebody out is not a
   * decision a refresh helper gets to make. */
  sessionExpired: boolean;
}

/** How long the pre-connect refresh gets before the connect goes ahead
 * without it.
 *
 * This is not the same budget as a normal request and must not be. A
 * plain `apiRequest` walks every known endpoint at up to 8s each, which
 * is right when someone is waiting for a screen and wrong when they have
 * pressed Connect: on a filtered network that would add tens of seconds
 * of nothing-happening before the first packet of the actual tunnel, and
 * the reward for waiting it out is a config that is almost always
 * identical to the one already in hand.
 *
 * Six seconds buys the first endpoint's answer -- which is the one that
 * worked last time, since `rememberEndpoint` puts it first -- and gives
 * up on the rest. A connect that would otherwise have started instantly
 * is delayed by at most this, once, and only when what is held is
 * already past its horizon.
 */
export const REFRESH_BUDGET_MS = 6_000;

/** A fingerprint of everything about a credential that decides whether a
 * handshake succeeds.
 *
 * `publicParams` is included whole rather than by named key. The field
 * that started this is REALITY's `serverName`, but `dest`, `shortIds`
 * and `realityPublicKey` strand a client just as completely, and a list
 * of names here would go stale the first time a protocol grew one --
 * silently, and in the direction of missing a change rather than
 * over-reporting one.
 *
 * `credentials` is not included. It changes when a customer is
 * re-provisioned, which is a real event, but it is also the one field
 * here that is a secret, and drift lines are written to telemetry.
 */
function fingerprint(user: ProtocolUser): string {
  const c = user.connection;
  return JSON.stringify([
    user.protocol,
    c?.host ?? null,
    c?.port ?? null,
    c?.transport ?? null,
    c?.security ?? null,
    // Key order out of JSON.parse follows the wire, which is stable for
    // a given server build but not guaranteed across one. Sorted so a
    // re-serialisation is not read as a change.
    Object.entries((c?.publicParams ?? {}) as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`),
  ]);
}

/** What changed between the credentials in hand and the ones just
 * fetched, in words.
 *
 * ## Why this does not reconnect anything
 *
 * The obvious thing to do on finding that a live tunnel's server has
 * been reconfigured is to reconnect onto the new values. This
 * deliberately does not, and the reason is the same one that runs
 * through the rest of this client: a VPN that drops itself without being
 * asked is indistinguishable, from inside Iran, from a VPN that has been
 * blocked. The customer sees the tunnel go down; they do not see why.
 * Trading a working connection for a marginally better-configured one is
 * a bad deal even when the reconnect succeeds, and a very bad one when
 * it does not -- and the case where it does not is precisely the case
 * where the change was made because something was broken.
 *
 * What actually happens is smaller and enough. The refresh runs at the
 * top of a connect pass, so the *next* dial -- the one the customer
 * asked for, or the one the failover ladder is already performing
 * because the tunnel stopped carrying traffic -- uses the new values
 * automatically. A stale SNI therefore survives at most until the next
 * connect, instead of until the next reinstall.
 *
 * The drift lines exist to be recorded, not acted on. A change that
 * lands while somebody is connected is worth knowing about when their
 * next connect is examined; it is not worth taking their tunnel away
 * for.
 */
export function describeConfigDrift(before: ProtocolUser[], after: ProtocolUser[]): string[] {
  const previous = new Map(before.map((u) => [u.id, u]));
  const lines: string[] = [];

  for (const user of after) {
    const was = previous.get(user.id);
    // A credential that did not exist before is not drift -- it is a new
    // route becoming available, which the picker reports on its own.
    if (!was) continue;
    if (fingerprint(was) !== fingerprint(user)) {
      lines.push(`${user.protocol} on route ${user.routeId}: connection parameters changed`);
    }
  }

  // Deliberately not reported: credentials present before and absent
  // now. That is a route being withdrawn, and the ladder already refuses
  // to dial what it does not hold.
  return lines;
}

/** Runs `work`, but gives up waiting after `budgetMs`.
 *
 * The work is not cancelled, only stopped being waited for. That
 * distinction is what makes the timeout cheap rather than wasteful: a
 * refresh that arrives two seconds after the connect started still gets
 * to write the cache, so the delay costs this one connect and is already
 * paid for by the time of the next one.
 */
const TIMED_OUT = Symbol("timed out");

function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

export interface RefreshOptions {
  /** What the caller is holding and would otherwise dial. */
  held: ProtocolUser[];
  /** When the held values were last known good, if the caller knows.
   * Omitted means "read it off the disk cache", which is what every
   * production call site does. */
  heldSavedAt?: number | null;
  budgetMs?: number;
  /** Skips the freshness check and always asks. Used by the manual
   * retry, where the customer has explicitly said "try again". */
  force?: boolean;
  now?: number;
}

/** Fetches the credentials again, unless what is held is still fresh.
 *
 * Never throws and never rejects. Every failure path ends in "connect
 * with what you have", because that is always better than not
 * connecting.
 */
export async function refreshConnectionConfig(options: RefreshOptions): Promise<ConfigRefresh> {
  const { held, budgetMs = REFRESH_BUDGET_MS, force = false, now = Date.now() } = options;

  const savedAt =
    options.heldSavedAt !== undefined ? options.heldSavedAt : ((await loadSnapshot())?.savedAt ?? null);
  const ageMs = typeof savedAt === "number" && savedAt > 0 && savedAt <= now ? now - savedAt : null;

  if (!force && !isSnapshotStale({ savedAt: savedAt ?? 0 }, now)) {
    // Inside the horizon. Nothing is asked and nothing is spent: this is
    // the branch that keeps a customer reconnecting after a hiccup from
    // paying for a request they do not need.
    return { protocolUsers: held, source: "fresh", ageMs, drift: [], sessionExpired: false };
  }

  const outcome = await withBudget(getProtocolUsers(), budgetMs);
  const answered = outcome === TIMED_OUT ? null : outcome;

  if (answered?.ok) {
    const fresh = answered.data;
    const drift = describeConfigDrift(held, fresh);
    // Written before returning so the values that were just dialled are
    // also the ones an offline start would come back to.
    void updateSnapshotProtocolUsers(fresh);
    if (drift.length > 0) {
      // Worth a line even though nothing failed. A server whose
      // parameters moved is the single most likely explanation for a
      // wave of connect failures that starts at a particular hour, and
      // this is the only place the client can see it happen.
      void reportAttempt({
        kind: "CONNECT",
        outcome: "SUCCESS",
        reason: `pre-connect refresh found changed server parameters: ${drift.join("; ")}`,
      });
    }
    return { protocolUsers: fresh, source: "network", ageMs: null, drift, sessionExpired: false };
  }

  if (answered && !answered.ok && answered.sessionExpired) {
    // Reached the server and it refused the session. Handing back the
    // held credentials is still right -- they may well work, the tunnel
    // does not authenticate against the control plane -- but the caller
    // needs to know so the UI can ask for a sign-in.
    return { protocolUsers: held, source: "stale", ageMs, drift: [], sessionExpired: true };
  }

  // Could not ask. The connect goes ahead regardless; the only thing
  // left to decide is whether anybody will ever know it did so blind.
  //
  // Reported as CONTROL_PLANE_UNREACHABLE and not as a failure of the
  // connect, because that is what it is: the tunnel has not been
  // attempted yet and may well work. It shares the vocabulary the panel
  // already filters on rather than adding an enum member, which would
  // need a schema migration to record one line of context.
  const detail = !answered
    ? `no answer within ${budgetMs}ms`
    : answered.ok
      ? "unexpected"
      : answered.error;
  void reportAttempt({
    kind: "CONNECT",
    outcome: "CONTROL_PLANE_UNREACHABLE",
    reason:
      `pre-connect config refresh failed (${detail}); connecting on cached credentials ` +
      (ageMs === null ? "of unknown age" : `${Math.round(ageMs / 60_000)} min old`) +
      ` (horizon ${Math.round(SNAPSHOT_TTL_MS / 60_000)} min)`,
  });
  // Also on the console, where a beta tester reading their own log can
  // see it without a round trip through the panel.
  console.warn(`[connect] config refresh failed (${detail}); dialling cached credentials`);

  return { protocolUsers: held, source: "stale", ageMs, drift: [], sessionExpired: false };
}
