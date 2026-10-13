import type { TranslationKey } from "./i18n";

/** The line a connect that landed somewhere other than where it set out
 * says about it, and what that line may claim.
 *
 * It may name a server as unreachable only when that server was dialled
 * and failed. On the VM, with the network adapter switched off as Connect
 * was pressed, every rung failed in the service before anything was
 * dialled -- "no network connection with a gateway was found" -- and once
 * the adapter came back the pass landed in another country. The screen
 * said "Couldn't reach fi-finland" about a server nothing had asked. Users
 * in Iran act on what this line says: told a server is unreachable, they
 * stop choosing it, and the next person they ask is told the same. */

/** What one rung that failed did with its route.
 *
 * - `dialled`: it reached the network with that route and failed -- a
 *   handshake that never completed, or a tunnel that came up and carried
 *   nothing. The only fate that says anything about the server, and the
 *   same rungs `failedDial` (attempts.ts) counts against a route.
 * - `noNetwork`: the service found no network to dial over.
 * - `notDialled`: it failed for some other reason before or without
 *   reaching the network -- the service, the installation, the plan, or an
 *   error nothing recognised. Not a claim about the server either way. */
export type RungFate = "dialled" | "noNetwork" | "notDialled";

export interface FailedRung {
  routeId: string;
  fate: RungFate;
}

/** The fate of a rung whose connect failed, by how its error was
 * classified (connection-errors.ts). A rung whose tunnel came up and was
 * then rejected was dialled, whatever else is true of it. */
export function rungFate(kind: string): RungFate {
  if (kind === "serverUnreachable") return "dialled";
  if (kind === "noNetwork") return "noNetwork";
  return "notDialled";
}

export interface FailoverNotice {
  /** The protocol the pass landed on, as the customer knows it. */
  label: string;
  /** The country on screen when Connect was pressed, when the pass landed
   * in another one; otherwise null. */
  fromRegion: string | null;
  toRegion: string | null;
  /** What became of the server on screen, by the rungs that tried it:
   * dialled and failed; refused for want of a network and never dialled;
   * or neither -- never asked, or failed for another reason. */
  shown: "unreachable" | "noNetwork" | "notTried";
  /** Whether the rungs before the landing failed for want of a network and
   * none of them was dialled: nothing failed to get through, because
   * nothing was sent. */
  noNetworkOnly: boolean;
  /** Whether any rung before the landing was dialled and failed: the only
   * case in which "your usual protocol didn't get through" is true. */
  dialledFailed: boolean;
}

export function failoverNotice(input: {
  label: string;
  fromRegion: string | null;
  toRegion: string | null;
  shownRouteId: string | null;
  failed: FailedRung[];
}): FailoverNotice {
  const onShown = input.failed.filter((rung) => input.shownRouteId !== null && rung.routeId === input.shownRouteId);
  const shown = onShown.some((rung) => rung.fate === "dialled")
    ? "unreachable"
    : onShown.some((rung) => rung.fate === "noNetwork")
      ? "noNetwork"
      : "notTried";
  const dialledFailed = input.failed.some((rung) => rung.fate === "dialled");
  const noNetworkOnly = input.failed.some((rung) => rung.fate === "noNetwork") && !dialledFailed;
  return { label: input.label, fromRegion: input.fromRegion, toRegion: input.toRegion, shown, noNetworkOnly, dialledFailed };
}

/** The sentence for a notice: a key and its values, and the protocol to
 * set after it when the sentence ends by naming one. */
export interface FailoverText {
  key: TranslationKey;
  vars?: Record<string, string>;
  trailingLabel?: string;
}

export function failoverText(notice: FailoverNotice): FailoverText {
  if (notice.fromRegion) {
    // Crossed a border, so the country is named -- and which sentence
    // depends on whether that country was ever dialled.
    const key: TranslationKey =
      notice.shown === "unreachable"
        ? "dash.switchedServer"
        : notice.shown === "noNetwork"
          ? "dash.switchedNoNetwork"
          : "dash.usedInstead";
    return { key, vars: { from: notice.fromRegion, to: notice.toRegion ?? "", protocol: notice.label } };
  }
  // In the country: "didn't get through" only when a rung was dialled and
  // failed. Nothing failed at all -- the ladder landed at once on a route
  // other than the one on screen -- or every failure came before anything
  // was dialled: then only where the connection is.
  return {
    key: notice.dialledFailed ? "dash.switchedTo" : notice.noNetworkOnly ? "dash.switchedToNoNetwork" : "dash.nowUsing",
    trailingLabel: notice.label,
  };
}
