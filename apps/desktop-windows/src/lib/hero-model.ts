/** What the main page's hero shows for each state: the status chip's word
 * and glyph, the line under it (a timer only for a verified tunnel), the
 * connect pill's label and fill, and the calm tone the whole screen wears.
 *
 * The facts come from the tables that already decide them -- `headlineFor`
 * (the words), `pressFor` (the press and what it does), `orbTone` over the
 * held look (`orbHold`, the colour). This file only maps them onto the
 * Pearl Glass pieces, so the mapping can be tested without a window and so
 * the dev preview draws exactly what the Dashboard would.
 *
 * The rules it keeps (design-system.md, sections 2.2 and 4.3):
 *  - words and glyphs change at once; the colour follows the calm tone;
 *  - the check glyph and the timer exist only for verified traffic;
 *  - inside a reconnect nobody pressed for, the pill stays cobalt and only
 *    its label and a white progress line change; the quiet glass fill is
 *    only for a busy the customer started. */

import type { ConnectionState } from "../components/ConnectOrb";
import type { Headline } from "./connection-evidence";
import type { PressAction } from "./connect-intent";
import type { TranslationKey } from "./i18n";
import type { OrbTone } from "./orb-caution";

/** The colour the screen may wear: `data-shown` on the app root. */
export type ShownTone = "idle" | "ok" | "hl" | "caution" | "warn" | "danger" | "muted";

/** The calm tone, from the held look's tone (`orbTone(orbState,
 * cautionShown)`) and the two conditions the orb has no colour of its own
 * for: a reconnect that has outlasted its hold, and a drop. */
export function shownTone(
  tone: OrbTone,
  { reconnecting, dropped }: { reconnecting: boolean; dropped: boolean },
): ShownTone {
  switch (tone) {
    case "success":
      return "ok";
    case "caution":
      return "caution";
    case "warning":
      return "warn";
    case "highlight":
      return "hl";
    case "muted":
      return "muted";
    // A busy look is neutral when somebody pressed for it. A reconnect's
    // that is still on screen has outlasted the hold (`orbHold`), and that
    // is a sustained, real gap: the reconnect's own tone.
    case "busy":
      return reconnecting ? "warn" : "idle";
    case "idle":
      return reconnecting ? "warn" : dropped ? "danger" : "idle";
  }
}

export type ChipGlyph = "check" | "ring" | "diamond" | "spin" | "dash" | "dot" | "idle";

export interface ChipModel {
  labelKey: TranslationKey;
  glyph: ChipGlyph;
}

/** The chip's short word and glyph, from the headline the screen says.
 * The headline table already holds every distinction -- dropped,
 * reconnecting, waiting for a network, not fully protected -- so the chip
 * cannot disagree with the line under it. */
export function chipFor(state: ConnectionState, headline: Headline, { teardownShowing = false } = {}): ChipModel {
  if (teardownShowing) return { labelKey: "chip.disconnecting", glyph: "spin" };
  switch (headline.title) {
    case "dash.protected":
      return { labelKey: "chip.connected", glyph: "check" };
    case "dash.connectedNotConfined":
      return { labelKey: "chip.unconfined", glyph: "diamond" };
    case "dash.unverified":
      return { labelKey: "chip.unverified", glyph: "ring" };
    case "dash.degraded":
      return { labelKey: "chip.degraded", glyph: "dot" };
    case "dash.reconnecting":
      return { labelKey: "chip.reconnecting", glyph: "spin" };
    case "dash.waitingForNetwork":
      return { labelKey: "chip.noNetwork", glyph: "dash" };
    case "dash.verifying":
      return { labelKey: state === "connecting" ? "chip.connecting" : "chip.verifying", glyph: "spin" };
    case "dash.unknown":
      return { labelKey: "chip.unknown", glyph: "dash" };
    case "dash.dropped":
      return { labelKey: "chip.dropped", glyph: "dot" };
    default:
      return state === "disconnecting"
        ? { labelKey: "chip.disconnecting", glyph: "spin" }
        : { labelKey: "chip.idle", glyph: "idle" };
  }
}

export type LineModel = { kind: "timer"; since: number } | { kind: "words"; key: TranslationKey };

/** The big line: the session timer for a verified tunnel with a known
 * start -- this app's own connect, or the age the service reports for one
 * adopted at launch (lib/session-clock.ts); none is invented when the
 * service does not say -- the headline in words in every other state. */
export function lineFor(
  state: ConnectionState,
  headline: Headline,
  { connectedAt, teardownShowing = false }: { connectedAt: number | null; teardownShowing?: boolean },
): LineModel {
  if (teardownShowing) return { kind: "words", key: "dash.disconnecting" };
  if (state === "connected" && connectedAt !== null) return { kind: "timer", since: connectedAt };
  return { kind: "words", key: headline.title };
}

export type HintTone = "warn" | "caution" | "danger" | null;

/** The sentence under the line takes the calm tone's ink only for a
 * sustained, real problem -- after the hold, never during it -- and a
 * failed connect's sentence its caution ink. */
export function hintTone(shown: ShownTone, { failed = false }: { failed?: boolean } = {}): HintTone {
  if (failed) return "caution";
  if (shown === "warn" || shown === "caution" || shown === "danger") return shown;
  return null;
}

/** What the screen reader's live region holds the moment the state's words
 * change to `next`, before they have settled: nothing, unless they are what
 * it holds already. The new words wait to be said, as ever; the old ones
 * are not left standing for that wait. On the VM the region held
 * "...Your traffic is NOT protected" 0.8 s into a hold that had made it
 * false, while the screen already said something else. */
export function announcedAtOnce(said: string, next: string): string {
  return said === next ? said : "";
}

export type PillVariant = "primary" | "primary-busy" | "busy";

export interface PillModel {
  labelKey: TranslationKey;
  variant: PillVariant;
  /** A forward arrow: an action that moves on (Connect, Disconnect). */
  arrow: boolean;
  /** The progress line under the label. */
  progress: boolean;
}

const BUSY: ReadonlySet<ConnectionState> = new Set(["connecting", "verifying", "disconnecting"]);

/** The connect pill: its label from the press it will make (`pressFor`),
 * so the label and the action cannot disagree, and its fill by who started
 * the busy -- the customer (the quiet glass) or nobody (cobalt held). */
export function pillFor(
  state: ConnectionState,
  press: { action: PressAction; labelKey: TranslationKey },
  {
    pressed,
    waitingForNetwork = false,
    teardownShowing = false,
    failed = false,
  }: { pressed: boolean; waitingForNetwork?: boolean; teardownShowing?: boolean; failed?: boolean },
): PillModel {
  const busy = BUSY.has(state) || teardownShowing;
  const variant: PillVariant = busy ? (pressed ? "busy" : "primary-busy") : "primary";
  const pill = (labelKey: TranslationKey, arrow = false): PillModel => ({ labelKey, variant, arrow, progress: busy });
  switch (press.action) {
    case "connect":
      if (press.labelKey === "dash.reconnectNow") return pill("dash.reconnectNow");
      return pill(failed ? "btn.tryAgain" : "btn.connect", true);
    case "disconnect":
      return state === "disconnecting" || teardownShowing ? pill("btn.disconnecting") : pill("btn.disconnect", true);
    case "cancelConnect":
      if (waitingForNetwork) return pill("btn.waiting");
      return pill(state === "verifying" ? "btn.checking" : "btn.connecting");
    case "recheck":
      return pill("btn.recheck");
  }
}

/** The second, quieter way out beside the pill, when there is one: the
 * pill alone is labelled "Connecting..." and does not say a press stops. */
export type Secondary = "stopConnecting" | "stopReconnecting" | "tryAnother" | null;

export function secondaryFor(
  press: { action: PressAction },
  { reconnecting, failed, teardownShowing = false }: { reconnecting: boolean; failed: boolean; teardownShowing?: boolean },
): Secondary {
  if (teardownShowing) return null;
  if (reconnecting) return "stopReconnecting";
  if (press.action === "cancelConnect") return "stopConnecting";
  if (failed && press.action === "connect") return "tryAnother";
  return null;
}

/** The tray's IP section: the address only for a verified tunnel -- the
 * same rule as the old exit-IP pill -- and never in gaming mode, where the
 * machine's address is unchanged by design. */
export type IpModel = { kind: "ip"; ip: string } | { kind: "words"; key: TranslationKey } | { kind: "none" };

export function ipFor(
  state: ConnectionState,
  exitIp: string | null,
  { gaming }: { gaming: boolean },
): IpModel {
  if (gaming) return { kind: "words", key: "tr.ipGaming" };
  if (state === "connected" && exitIp) return { kind: "ip", ip: exitIp };
  if (state === "unverified" || state === "degraded" || state === "connected" || state === "verifying") {
    return { kind: "words", key: "tr.ipPending" };
  }
  if (state === "unknown") return { kind: "none" };
  return { kind: "words", key: "tr.ipOff" };
}

/** The plan meter and the days left turn the caution colour only for a
 * sustained, real condition: nine tenths of the data used, three days or
 * fewer left. */
export function planCaution(usedFraction: number | null, daysLeft: number | null): { meter: boolean; days: boolean } {
  return {
    meter: usedFraction !== null && usedFraction >= 0.9,
    days: daysLeft !== null && daysLeft <= 3,
  };
}
