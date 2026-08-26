import { invoke } from "@tauri-apps/api/core";
import { groupMembers, type GameExitGroup } from "./game-apps";

/** Where a selected application's traffic is actually leaving from, as
 * the Windows service answers it.
 *
 * Four answers rather than a boolean, and the fourth is the one that
 * earns its place. With no session intercepting, or with the client
 * having named no egress for the one that is, reporting `onPreferred`
 * claims a match nobody established and reporting `fallback` claims a
 * mismatch nobody established. Neither is a thing this product says --
 * the same rule that stops a "Connected" indicator being shown by
 * anything that has not checked.
 *
 * Mirrors `ipc::ExitPlacement`, which serialises with the variant in a
 * `placement` field and any payload flattened alongside it. */
export type ExitPlacement =
  | { placement: "noPreference" }
  | { placement: "onPreferred" }
  | { placement: "fallback"; preferred: string }
  | { placement: "unknown"; preferred: string };

/** One application's answer. `app` is the path exactly as it appears in
 * the selection. */
export type AppPlacement = { app: string } & ExitPlacement;

export type ExitPlacements = {
  /** The exit the live session leaves from, or `null`.
   *
   * Null while nothing is intercepting -- which the service gates on
   * its own rather than trusting what the client last said, because an
   * egress asserted while no traffic is being carried is a request
   * being reported as an observation. */
  egress: string | null;
  apps: AppPlacement[];
};

/** Ask the service where each selected application is leaving from.
 *
 * Its own round trip rather than a field on the status poll: the poll
 * runs continuously and this answer costs a walk of the whole
 * selection. Called when a screen that shows it opens or changes, which
 * is when somebody is looking.
 */
export async function fetchExitPlacements(): Promise<ExitPlacements> {
  return invoke<ExitPlacements>("vpn_exit_placements");
}

/** How favourable an answer is, least first.
 *
 * Used to reduce a game's several binaries to one line. A group's
 * members are placed together or not at all -- `exitsForGames` emits a
 * whole group or none of it, and the service drops a group it cannot
 * honour whole -- so in practice they agree. When they do not, the
 * honest line is the *least* favourable one any member reported: a game
 * with one binary on the wrong exit is a game on the wrong exit, and
 * rounding that up to "on your chosen exit" would hide precisely the
 * two-source-IP state this feature exists to avoid.
 */
const SEVERITY: Record<ExitPlacement["placement"], number> = {
  fallback: 0,
  unknown: 1,
  onPreferred: 2,
  noPreference: 3,
};

/** One line for a whole game.
 *
 * Returns `null` when there is nothing to say: the game has no binary
 * in the selection at all, so no claim about where it leaves from could
 * be about anything.
 *
 * `placements` being `null` means the service has not answered yet --
 * it may be restarting, and it has its own lifetime independent of this
 * app. That is reported as `unknown`, not as `noPreference`: a customer
 * who chose an exit and is shown "no preference" would reasonably
 * conclude their choice was lost.
 */
export function gamePlacement(
  group: GameExitGroup,
  apps: readonly string[],
  placements: AppPlacement[] | null,
): ExitPlacement | null {
  const members = groupMembers(group, apps);
  if (members.length === 0) return null;

  const preferred = typeof group.exit === "string" && group.exit.length > 0 ? group.exit : null;
  if (!placements) return preferred ? { placement: "unknown", preferred } : { placement: "noPreference" };

  const wanted = new Set(members.map((m) => m.toLowerCase()));
  const mine = placements.filter((p) => wanted.has(p.app.toLowerCase()));
  // The service was told about none of this game's binaries -- the
  // selection has not been pushed since they were added, or Custom mode
  // is off. Either way nothing has been established.
  if (mine.length === 0) {
    return preferred ? { placement: "unknown", preferred } : { placement: "noPreference" };
  }

  let worst = mine[0];
  for (const entry of mine) {
    if (SEVERITY[entry.placement] < SEVERITY[worst.placement]) worst = entry;
  }
  const { app: _app, ...placement } = worst;
  return placement as ExitPlacement;
}
