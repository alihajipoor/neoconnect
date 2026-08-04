import { load, type Store } from "@tauri-apps/plugin-store";
import { getVersion } from "@tauri-apps/api/app";
import { publicRequest } from "./api";
import { getTokens } from "./session";

/** Telling the panel how an attempt went, so a beta can be watched from
 * somewhere other than screenshots.
 *
 * Every failure in this beta has cost a message, a screenshot and a
 * round trip to work out. The app already knows all of it -- which
 * protocols the ladder tried, whether traffic actually crossed the
 * tunnel, which API address answered -- and has been showing it to the
 * customer and then throwing it away.
 *
 * Two rules shape everything below:
 *
 * 1. **Never make a bad moment worse.** Every function here swallows its
 *    own errors and none of them is awaited by anything the customer is
 *    waiting on. A failed report must be invisible.
 * 2. **The reports worth having cannot be sent when they happen.** A
 *    client that could not reach the control plane cannot tell the
 *    control plane so. Those queue on disk and go out on the next
 *    contact, carrying the time they actually happened -- see
 *    `occurredAt`.
 */

export type AttemptKind = "REGISTER" | "SIGN_IN" | "CONNECT";

export type AttemptOutcome =
  | "SUCCESS"
  | "CONTROL_PLANE_UNREACHABLE"
  | "REJECTED"
  | "NOT_CARRYING_TRAFFIC"
  | "ENGINE_FAILED"
  | "PERMISSION_DENIED"
  | "OTHER";

export interface AttemptRung {
  protocol: string;
  result: string;
}

/** What a caller supplies. Platform, version and time are filled in
 * here so no call site can forget them or get them wrong. */
export interface AttemptReport {
  kind: AttemptKind;
  outcome: AttemptOutcome;
  routeId?: string;
  protocol?: string;
  reason?: string;
  attempts?: AttemptRung[];
}

interface QueuedReport extends AttemptReport {
  platform: string;
  appVersion: string;
  occurredAt: string;
}

/** Which build this is.
 *
 * Detected rather than hardcoded because this file is shared: the
 * Android client aliases this whole directory, so a literal "windows"
 * here would label every tablet report as a desktop one -- and telling
 * the two apart is most of the value of having the field.
 *
 * The user agent rather than a platform plugin, which is not a
 * dependency of either app. Both run in a system webview, and the one
 * on Android says so. A wrong guess costs a mislabelled row, so it is
 * not worth a new dependency in two apps to improve on.
 */
function detectPlatform(): string {
  return /android/i.test(navigator.userAgent) ? "android" : "windows";
}

/** How many unsent reports are kept.
 *
 * Small on purpose. This is a diagnosis aid, not an audit trail, and a
 * device that has been offline for a week should send back the shape of
 * the problem rather than every instance of it. The oldest go first,
 * because the newest are the ones that still describe the situation.
 */
const MAX_QUEUED = 25;

/** Reports older than this are dropped unsent.
 *
 * Matches the server's retention window: a report that would be deleted
 * on arrival is not worth the request, and the server rejects the
 * timestamp anyway.
 */
const MAX_AGE_MS = 14 * 86_400_000;

const KEY = "queue";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached, or one transient failure
  // disables reporting for the life of the process.
  storePromise ??= load("attempt-reports.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** Cached because it cannot change while the process runs, and the
 * connect path should not wait on an IPC call to find out. */
let versionPromise: Promise<string> | null = null;
function appVersion(): Promise<string> {
  versionPromise ??= getVersion().catch(() => "unknown");
  return versionPromise;
}

async function readQueue(): Promise<QueuedReport[]> {
  try {
    const stored = await (await getStore()).get<QueuedReport[]>(KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedReport[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, queue);
    await store.save();
  } catch {
    // Losing the queue costs diagnostics, nothing the customer can see.
  }
}

/** Sends one report. Resolves false only when the control plane could
 * not be reached, which is the one case worth queueing for.
 *
 * A rejection *from* the server -- a 400, a throttle, anything with a
 * status -- counts as delivered. It means we reached it and it did not
 * want this, and retrying forever would turn one malformed report into
 * a permanent background load.
 */
async function send(report: QueuedReport): Promise<boolean> {
  // Attached by hand rather than by using the authenticated helper. That
  // one refreshes on a 401 and reports session expiry to the UI, and a
  // background diagnostic must never be the thing that signs somebody
  // out. An expired token here simply leaves the report anonymous --
  // the server verifies it if it can and ignores it if it cannot.
  const tokens = await getTokens();
  const result = await publicRequest<void>("/client-attempts", {
    method: "POST",
    body: JSON.stringify(report),
    headers: tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
  });

  if (result.ok) return true;
  // publicRequest flattens both cases into a string, and only one of
  // them should keep the report alive. This is the message it uses when
  // no endpoint answered at all.
  return !result.error.startsWith("Could not reach Neoxify");
}

/** Records how an attempt went, and tries to send it.
 *
 * Fire and forget: call it with `void`. It resolves when it is done and
 * never rejects, but nothing should wait for it.
 */
export async function reportAttempt(report: AttemptReport): Promise<void> {
  try {
    const queued: QueuedReport = {
      ...report,
      platform: detectPlatform(),
      appVersion: await appVersion(),
      // Stamped now, even for the report that goes out immediately. The
      // server keeps its own arrival time regardless; this is what makes
      // a delayed report readable as delayed instead of as fresh.
      occurredAt: new Date().toISOString(),
      // A reason of unbounded length would be rejected by the server's
      // validation, losing the whole report over its least important
      // field.
      reason: report.reason?.slice(0, 500),
    };

    if (await send(queued)) {
      // Reaching the server is also the signal that anything held back
      // can go now.
      await flushAttempts();
      return;
    }

    const queue = await readQueue();
    queue.push(queued);
    await writeQueue(queue.slice(-MAX_QUEUED));
  } catch {
    // Reporting must never surface as a failure of the thing being
    // reported on.
  }
}

/** Sends whatever is waiting. Safe to call whenever the app has reason
 * to think the control plane is reachable -- at launch, after a
 * successful sign-in.
 *
 * Stops at the first unreachable send rather than walking the rest.
 * With the control plane down, every remaining one would pay the full
 * endpoint-ladder timeout to learn the same thing.
 */
export async function flushAttempts(): Promise<void> {
  try {
    const queue = await readQueue();
    if (queue.length === 0) return;

    const cutoff = Date.now() - MAX_AGE_MS;
    const fresh = queue.filter((r) => new Date(r.occurredAt).getTime() > cutoff);

    const remaining: QueuedReport[] = [];
    let reachable = true;
    for (const report of fresh) {
      if (!reachable) {
        remaining.push(report);
        continue;
      }
      if (!(await send(report))) {
        reachable = false;
        remaining.push(report);
      }
    }

    if (remaining.length !== queue.length) await writeQueue(remaining);
  } catch {
    // Same as everywhere else here: never the cause of a visible error.
  }
}

/** Whether a failed API call never arrived or was turned away.
 *
 * The distinction is the single most useful thing this whole feature
 * collects. A filtered address and a wrong password are the same
 * sentence to the customer -- "it will not let me in" -- and they send
 * an operator to opposite ends of the product.
 */
export function outcomeFromApiError(error: string): AttemptOutcome {
  return error.startsWith("Could not reach Neoxify") ? "CONTROL_PLANE_UNREACHABLE" : "REJECTED";
}

/** The reported outcome for a classified connect failure.
 *
 * The mapping collapses seven client-side kinds into the four the panel
 * filters on, and the grouping is the point: "the engine never started"
 * and "the server said no" send an operator to completely different
 * places, while the exact flavour of each is already in `reason`.
 */
export function outcomeFromError(kind: string): AttemptOutcome {
  switch (kind) {
    case "serviceUnavailable":
    case "engineMissing":
      return "ENGINE_FAILED";
    case "concurrentLimit":
    case "quotaExhausted":
    case "subscriptionInactive":
      return "REJECTED";
    case "serverUnreachable":
      // Covers both halves of the same customer-visible failure: a
      // handshake that never completed, and a tunnel that came up and
      // carried nothing. Which one it was is in the ladder.
      return "NOT_CARRYING_TRAFFIC";
    default:
      return "OTHER";
  }
}

/** Splits the ladder lines the Dashboard already builds --
 * `"Fast: up but unreachable"` -- into the shape the panel renders.
 *
 * Parsing text the app itself just formatted is not elegant, and it is
 * the right trade here: the ladder's own strings are what the customer
 * sees under "show details", and having the report say something
 * different from the screen would defeat the purpose of collecting it.
 */
export function rungsFrom(lines: string[]): AttemptRung[] {
  return lines.map((line) => {
    const split = line.indexOf(": ");
    return split === -1
      ? { protocol: line.slice(0, 64), result: "" }
      : { protocol: line.slice(0, split).slice(0, 64), result: line.slice(split + 2).slice(0, 200) };
  });
}
