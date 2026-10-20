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
 *  - `lost` / `lostHeld`: a verified tunnel gone and Neoxify reconnecting
 *    past the hold -- the second when the service is holding the internet
 *    while it does ("Block the internet while reconnecting");
 *  - `back`: verified again after `lost` was said;
 *  - `dropped`: gone, and nothing is reconnecting it (the episode gave up,
 *    or none could start).
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

export type NotifyKind = "connected" | "connectedPartial" | "lost" | "lostHeld" | "back" | "dropped";

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
  /** An automatic reconnect is under way. */
  readonly reconnecting: boolean;
  /** The service says it is holding the internet. */
  readonly holding: boolean;
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
        return say(input.holding ? "lostHeld" : "lost", { up: true, lostSaid: true });
      }
      return { memory, say: null };
    // Gone, and nothing reconnecting.
    case "danger":
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
