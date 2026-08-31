import { exitsForGames, MAX_CONCURRENT_EXITS, type GameExitGroup } from "./game-apps";
import type { ProtocolUser, RouteOption } from "./types";

/** One additional exit to carry alongside the primary connection.
 *
 * Shaped for the `vpn_connect` Tauri command, which pairs the opaque
 * handle with credentials the customer already holds. The service never
 * resolves one to the other -- see `neoconnect_ipc::ExitProfile`.
 */
export interface ConcurrentExit {
  exit: string;
  payload: ProtocolUser;
}

/** The Xray-carried protocols.
 *
 * Concurrent exits are one Xray process with several tagged inbounds,
 * each routed to its own outbound. WireGuard, OpenVPN and IKEv2 have no
 * equivalent -- each is one engine, one adapter and one peer, and a
 * second of any of them collides with every singleton
 * `docs/design/per-game-exits.md` section 2.3 lists.
 *
 * **That is a platform gap to state, not a protocol to drop.** Every
 * transport still matters for a censored network; what changes is only
 * that a customer using per-game exits is on Xray, and the UI has to
 * say so rather than quietly offering something it cannot deliver.
 *
 * Must agree with `ConnectProfile::carries_concurrent_exits` in
 * `apps/desktop-windows/ipc/src/lib.rs`, which is the belt for when
 * this is wrong.
 */
const XRAY_CARRIED: ReadonlySet<string> = new Set([
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_TROJAN",
  "SHADOWSOCKS",
]);

export function carriesConcurrentExits(protocol: string): boolean {
  return XRAY_CARRIED.has(protocol);
}

/** Which route a credential belongs to. */
function routeOf(user: ProtocolUser, routes: readonly RouteOption[]): RouteOption | undefined {
  return routes.find((route) => route.id === user.routeId);
}

/** The exit a credential leaves from, or `null` when the backend minted
 * no handle for its route.
 *
 * `null` is not a failure to work around. A backend that mints no
 * handle gives this client no exit vocabulary, and inventing one from a
 * route id would produce exactly the false placement report the whole
 * feature exists to avoid -- two routes can share an exit, so a route
 * id is not an exit.
 */
function exitOf(user: ProtocolUser, routes: readonly RouteOption[]): string | null {
  return routeOf(user, routes)?.exit ?? null;
}

/** The additional exits to bring up alongside `primary`.
 *
 * # What this is for
 *
 * A customer picks up to three games and gives each its own exit. One
 * of those exits is wherever the connection they are making already
 * leaves from; the rest need their own outbound in the same Xray
 * process, and each needs credentials for a node the customer already
 * holds. This works out which, from state the client already has --
 * `provisionAll` provisions a subscription on **every** route its plan
 * allows and the client holds all of them at once, precisely so it can
 * fail over without asking the server. Nothing new is fetched and no
 * backend change is needed to produce this list.
 *
 * # Every rule here fails toward *fewer exits*, never toward a split
 *
 * 1. **Not an Xray-carried primary, nothing at all.** See
 *    [[XRAY_CARRIED]]. Sending them anyway would have the service drop
 *    them, which is the same outcome reached less honestly.
 * 2. **Only exits `exitsForGames` actually emitted.** That function is
 *    the only producer of an `AppExit` in this client and it emits a
 *    game's binaries together or not at all, so a game withheld for a
 *    partial group, a shared binary, or the ceiling contributes no exit
 *    here either. The group rules are upstream of this by construction
 *    rather than repeated in it.
 * 3. **The primary's own exit is skipped.** It is already the session's
 *    egress; a second outbound to the same node would be a second
 *    connection to one place for no gain.
 * 4. **An exit with no Xray-carried credential is skipped.** The
 *    outbound has to be one Xray can dial. A game whose exit is only
 *    reachable by WireGuard is carried on the session's exit and
 *    reported as `Fallback`, which is the ordinary unsatisfiable-
 *    preference case.
 * 5. **Capped at [[MAX_CONCURRENT_EXITS]].** Belt: rule 2 already
 *    withholds everything when the ceiling is exceeded, so this only
 *    fires if that rule is ever loosened.
 *
 * A skipped exit is never an error and never stops a connection. The
 * game is carried on the session's own exit exactly as every
 * application was before any of this existed.
 */
export function concurrentExitsFor(
  primary: ProtocolUser,
  held: readonly ProtocolUser[],
  routes: readonly RouteOption[],
  games: readonly GameExitGroup[],
  apps: readonly string[],
): ConcurrentExit[] {
  if (!carriesConcurrentExits(primary.protocol)) return [];

  const { exits } = exitsForGames(games, apps);
  if (exits.length === 0) return [];

  const primaryExit = exitOf(primary, routes);

  // Deduplicated, and in the order the games named them, so the same
  // selection produces the same config twice running -- which is what
  // makes a customer's report of "it worked yesterday" checkable.
  const wanted: string[] = [];
  for (const entry of exits) {
    if (entry.exit === primaryExit) continue;
    if (!wanted.includes(entry.exit)) wanted.push(entry.exit);
  }

  const chosen: ConcurrentExit[] = [];
  for (const exit of wanted) {
    if (chosen.length >= MAX_CONCURRENT_EXITS) break;
    // Preferring a route the control plane last saw up, and preferring
    // it only as a tiebreak. `nodeStatus` is what the backend knew at
    // its last heartbeat, not a measurement from here, so it is worth
    // ordering by and not worth refusing on -- the same rule the exit
    // picker applies.
    const candidates = held
      .filter((user) => user.status === "ACTIVE")
      .filter((user) => carriesConcurrentExits(user.protocol))
      .filter((user) => exitOf(user, routes) === exit);
    const best =
      candidates.find((user) => routeOf(user, routes)?.nodeStatus === "ONLINE") ?? candidates[0];
    if (best) chosen.push({ exit, payload: best });
  }
  return chosen;
}
