import {
  deviceSlot,
  slotStop,
  type DeviceSlotSession,
  type SlotEvent,
  type SlotStop,
} from "@shared/lib/device-slot-session";
import { withTimeout } from "@shared/lib/service-call";

/** The phone's half of the plan's device limit.
 *
 * Every decision is the shared `deviceSlot`'s, the same ones the Windows
 * client makes (docs/device-slots.md). What lives here is what differs
 * on a phone, kept out of the dashboard so it can be tested without a
 * tunnel or a screen. Android and iOS both run it; it is the same JS.
 *
 *  - The claim is made while the connection config refreshes, and its
 *    answer is read before anything is dialled.
 *  - Renewal happens only while the app is in the foreground. In the
 *    background the app does no work for this at all: the tunnel's own
 *    traffic keeps the slot (the backend frees one only after ninety
 *    seconds with neither a renewal nor traffic), and the first poll
 *    after the app comes back renews, or learns it was displaced.
 *  - When the slot ends the session, the tunnel comes down, and "down" is
 *    said only once the platform confirms it. Until it does, the teardown
 *    stays owed and is tried again on the poll.
 *
 * There is no automatic ladder on the phone to hold back. Its health
 * poll reports and never redials, so a displaced phone disconnects and
 * stays disconnected until the customer presses something.
 */

/** Whether the app is in front of the customer. True outside a browser
 * (tests), where there is no background to be in. */
export function inForeground(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export interface PreDialRequest {
  subscriptionId: string | null | undefined;
  /** The credential on screen, which is the one the ladder dials first
   * when it is pinned. Moved to the one it lands on once it does. */
  protocolUserId?: string | null;
  /** Handles from "Use on this device instead". */
  takeover?: string[];
  /** `deviceLimit` from the subscription: null is unlimited (no claim),
   * undefined is an older backend or nothing loaded (claim anyway). */
  deviceLimit?: number | null;
}

/** Claims a slot while the connection config refreshes.
 *
 * Side by side rather than one after the other. Both happen before
 * anything is dialled, and on a network where the API is blackholed the
 * claim's three seconds then hide inside the refresh's own budget
 * instead of being added to it. Neither can hold up a connect for long:
 * the refresh hands back what is already held when it cannot reach the
 * API, and the claim says "dial" when it gets no answer within its
 * budget.
 *
 * `stop` is null to dial, or what to show and report when the plan's
 * device limit says not to. A stop is reported as REJECTED with no
 * rungs, and is read before the ladder has dialled, probed or
 * remembered anything -- so a refusal leaves no failed dial in the
 * history and teaches nothing about this network's best route. */
export async function claimWhileRefreshing<R>(
  request: PreDialRequest,
  refresh: () => Promise<R>,
  slot: DeviceSlotSession = deviceSlot,
): Promise<{ refreshed: R; stop: SlotStop | null }> {
  // Started first, so the request is on its way before the refresh is.
  const decision = slot.beforeDial(request);
  const [refreshed, outcome] = await Promise.all([refresh(), decision]);
  return { refreshed, stop: outcome.kind === "dial" ? null : slotStop(outcome, "beforeDial") };
}

/** The renewal on the health poll, in the foreground only.
 *
 * `onPoll` itself decides whether one is due (every `renewEverySec`, the
 * contract's sixty seconds) and answers at once when not. In the
 * background nothing is asked: the poll's timer may still fire there,
 * and a request every minute from a phone in a pocket is battery and
 * metered data spent on a question the tunnel's traffic already
 * answers. */
export async function renewInForeground(
  slot: Pick<DeviceSlotSession, "onPoll"> = deviceSlot,
  visible: () => boolean = inForeground,
): Promise<SlotEvent> {
  if (!visible()) return { kind: "keep" };
  return await slot.onPoll();
}

/** What the app's visibility is read from. `document` in the app. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Calls `handler` each time the app comes back to the foreground, so a
 * phone that was displaced while it was away says so as it is opened
 * rather than up to a poll later. Returns the unsubscribe. */
export function whenForegrounded(
  handler: () => void,
  source: VisibilitySource | undefined = typeof document === "undefined" ? undefined : document,
): () => void {
  if (!source) return () => undefined;
  const listener = () => {
    if (source.visibilityState === "visible") handler();
  };
  source.addEventListener("visibilitychange", listener);
  return () => source.removeEventListener("visibilitychange", listener);
}

export type SlotTeardown = "down" | "stuck";

/** How long the disconnect call may take before an attempt stops waiting
 * for it and asks the platform anyway. The Windows client's budget for
 * the same call (SERVICE_CALL_TIMEOUT_MS). */
export const TEARDOWN_DISCONNECT_BUDGET_MS = 6_000;
/** How long the wait for the platform's word may take in all. The
 * dashboard's own wait gives up after eight seconds, but checks its
 * deadline between questions, never during one: a question the platform
 * never answers would hold it for ever. This is that wait with room. */
export const TEARDOWN_WAIT_BUDGET_MS = 10_000;

export interface TeardownCalls {
  disconnect: () => Promise<unknown>;
  waitForTeardown: () => Promise<boolean>;
  /** For tests; the defaults above otherwise. */
  disconnectBudgetMs?: number;
  waitBudgetMs?: number;
}

/** Takes the tunnel down: after the device limit ended the session, and
 * for the customer's own Disconnect.
 *
 * "down" only on the platform's own word that the device is out of the
 * tunnel; anything else is "stuck", and the dashboard says the
 * disconnect did not finish rather than "Disconnected:". The platform
 * is asked even when the disconnect call threw or did not answer in
 * time: a call that failed may still have stopped the engine, and only
 * that answer says.
 *
 * Bounded, both halves, the way the Windows client bounds its service
 * calls (`withTimeout`). Neither plugin call has a deadline of its own,
 * and one that never settled left the teardown the device limit owes
 * "tearingDown" for good: the retry runs only once an attempt has come
 * back "stuck", so nothing tried again and the line saying the tunnel
 * was not confirmed closed never appeared. A call that runs out of time
 * is "stuck" like any other unconfirmed teardown, and is tried again. */
export async function tearDownForSlot(deps: TeardownCalls): Promise<SlotTeardown> {
  await withTimeout(
    deps.disconnect(),
    "vpn_disconnect",
    deps.disconnectBudgetMs ?? TEARDOWN_DISCONNECT_BUDGET_MS,
  ).catch(() => undefined);
  let gone = false;
  try {
    gone = await withTimeout(deps.waitForTeardown(), "vpn_tunnel_gone", deps.waitBudgetMs ?? TEARDOWN_WAIT_BUDGET_MS);
  } catch {
    gone = false;
  }
  return gone ? "down" : "stuck";
}

/** One attempt at that teardown, in the shape the shared `slotTeardown`
 * takes: true only on the platform's word that the device is out of the
 * tunnel.
 *
 * The shared store is what keeps it owed when an attempt is "stuck", and
 * the dashboard asks it again on its poll until one comes back "down" --
 * a disconnect that did not finish is not left showing a working tunnel
 * with nothing trying again (obligation 11). */
export function slotTeardownAttempt(deps: TeardownCalls): () => Promise<boolean> {
  return async () => (await tearDownForSlot(deps)) === "down";
}
