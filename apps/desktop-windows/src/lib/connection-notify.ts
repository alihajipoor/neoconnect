/** "Notify me when the connection changes": what is worth a notification,
 * and when.
 *
 * Read off the calm tone the main page already wears (`shownTone` in
 * hero-model.ts), never the raw state. That tone holds through a short
 * gap -- a reconnect, a rung, an engine restarted -- and only moves for a
 * sustained, real condition (the owner's calm rule, ui-state-calm): so a
 * few seconds of not being connected never reaches the customer as a
 * notification, exactly as it never changes the colour.
 *
 * Five things are said, each once per change:
 *  - `connected`: a tunnel verified, from not being up;
 *  - `lost` / `lostHeld` / `lostHeldLate`: a verified tunnel gone and
 *    Neoxify reconnecting past the hold -- the second when the service is
 *    holding the internet while it does ("Block the internet while
 *    reconnecting"), the third when that hold went in only on the report
 *    of the drop (WireGuard's block could not stand while it was up) --
 *    once the service has said which (`gapTraffic`), and not before; or,
 *    its word late past its grace (`HOLD_WORD_GRACE_MS`), `lostUnconfirmed`:
 *    reconnecting, and not yet confirmed whether the rest is blocked;
 *  - `back`: verified again after `lost` was said;
 *  - `dropped`: gone, and nothing is reconnecting it (the episode gave up,
 *    or none could start) -- once the service has said it no longer holds
 *    the internet for it: "not protected" while other connections are
 *    still blocked, or may be, would be false, so it waits for the
 *    service's word that nothing is held. Measured on the VM: said 0.3 s
 *    before the release took effect, off a stale "armed".
 * Nothing for the customer's own Disconnect, nothing in Gaming mode, and
 * nothing while the window is in front: the screen already says it. A
 * change seen on screen counts as said, so "back" after a loss the
 * customer watched is not repeated as a toast either -- unless they have
 * looked away by then.
 *
 * The words are the dictionary's (`NOTIFY_TEXT`), in the app's language;
 * none of them says "protected" for anything the app has not verified. */

import type { ShownTone } from "./hero-model";
import type { TranslationKey } from "./i18n";
import type { GapWord } from "./reconnect-hold";

export type NotifyKind = "connected" | "connectedPartial" | "lost" | "lostHeld" | "lostHeldLate" | "lostUnconfirmed" | "back" | "dropped";

export interface NotifyMemory {
  /** A verified tunnel has been seen since the customer last had nothing up. */
  readonly up: boolean;
  /** The loss has been said -- as a toast, or on screen -- and its outcome
   * (back, or dropped) is owed. */
  readonly lostSaid: boolean;
}

export const FRESH_MEMORY: NotifyMemory = { up: false, lostSaid: false };

export interface NotifyInput {
  /** The calm tone the screen wears now. */
  readonly tone: ShownTone;
  /** An automatic reconnect is under way -- or the mid-session failover,
   * with the setting on (`failover`). */
  readonly reconnecting: boolean;
  /** That reconnect is the mid-session failover, with "Block the internet
   * while reconnecting" on. Its loss is said only once the service holds
   * the internet for it -- in held words: on the VM it held for 25 to 84 s
   * under "Checking connection..." and nothing said so. With nothing held
   * it says nothing new, as it never has. Its memory is kept meanwhile, so
   * a loss said is followed by "back". */
  readonly failover?: boolean;
  /** Where other traffic goes in the gap, as the service has said
   * (`gapTraffic` in reconnect-hold.ts), given its grace (`gapWord`): the
   * one source the main page's sentence reads too. */
  readonly gap: GapWord;
  /** The window is in front: the screen says it already. */
  readonly focused: boolean;
  readonly gaming: boolean;
}

/** One look at the screen's tone: what to say, if anything, and what to
 * remember. */
export function notifyStep(memory: NotifyMemory, input: NotifyInput): { memory: NotifyMemory; say: NotifyKind | null } {
  const say = (kind: NotifyKind, next: NotifyMemory) => ({ memory: next, say: input.focused ? null : kind });
  if (input.gaming) return { memory: FRESH_MEMORY, say: null };
  switch (input.tone) {
    // Verified: "connected" from nothing, "back" after a loss said.
    case "ok":
    case "caution": {
      const partial = input.tone === "caution";
      if (memory.lostSaid) return say("back", { up: true, lostSaid: false });
      if (!memory.up) return say(partial ? "connectedPartial" : "connected", { up: true, lostSaid: false });
      return { memory, say: null };
    }
    // Past the hold, and only while a reconnect runs: a degraded tunnel's
    // amber is the failover's to fix, and says nothing new.
    case "warn":
      if (input.reconnecting && memory.up && !memory.lostSaid) {
        // Which it is, the service's to say first -- within its grace; past
        // it, that it has not said (`HOLD_WORD_GRACE_MS`).
        if (input.gap === "pending") return { memory, say: null };
        if (input.failover === true && input.gap !== "blocked" && input.gap !== "blockedLate") return { memory, say: null };
        // The service not answering is neither held nor open: not yet
        // confirmed, as a word that is late.
        const kind: NotifyKind =
          input.gap === "blocked"
            ? "lostHeld"
            : input.gap === "blockedLate"
              ? "lostHeldLate"
              : input.gap === "unconfirmed" || input.gap === "unanswered"
                ? "lostUnconfirmed"
                : "lost";
        return say(kind, { up: true, lostSaid: true });
      }
      return { memory, say: null };
    // Gone, and nothing reconnecting -- said once the service has said
    // nothing is held.
    case "danger":
      if (input.gap !== "open") return { memory, say: null };
      if (memory.up || memory.lostSaid) return say("dropped", FRESH_MEMORY);
      return { memory, say: null };
    // Nothing up by the customer's own hand, or a press under way.
    case "idle":
      return input.reconnecting ? { memory, say: null } : { memory: FRESH_MEMORY, say: null };
    // "Not confirmed" and "can't tell" are said on screen; neither is a
    // change the app has measured.
    case "hl":
    case "muted":
      return { memory, say: null };
  }
}

export const NOTIFY_TEXT: Record<NotifyKind, { title: TranslationKey; body: TranslationKey }> = {
  connected: { title: "notif.connectedTitle", body: "notif.connectedBody" },
  connectedPartial: { title: "notif.connectedTitle", body: "notif.connectedPartialBody" },
  lost: { title: "notif.lostTitle", body: "notif.lostBody" },
  lostHeld: { title: "notif.lostTitle", body: "notif.lostHeldBody" },
  lostHeldLate: { title: "notif.lostTitle", body: "notif.lostHeldLateBody" },
  lostUnconfirmed: { title: "notif.lostTitle", body: "notif.lostUnconfirmedBody" },
  back: { title: "notif.backTitle", body: "notif.backBody" },
  dropped: { title: "notif.droppedTitle", body: "notif.droppedBody" },
};

/** The one memory of the run: the main page unmounts whenever Settings
 * opens, and a loss said before it did is still owed its outcome. */
let remembered: NotifyMemory = FRESH_MEMORY;

export const notifyMemory = {
  current(): NotifyMemory {
    return remembered;
  },
  set(next: NotifyMemory): void {
    remembered = next;
  },
  /** A sign-out: nothing said under one session is owed to the next. */
  reset(): void {
    remembered = FRESH_MEMORY;
  },
};
