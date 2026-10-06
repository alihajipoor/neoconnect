import { load, type Store } from "@tauri-apps/plugin-store";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { publicRequest } from "./api";
import { API_ENDPOINT_MAX, clipTrace, LEGACY_API_ENDPOINT_MAX } from "./endpoint-trace";
import { getTokens } from "./session";
import { currentAttestation } from "./network-identity";

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

/** SESSION is "the tunnel kept carrying traffic" -- see session-report.ts. */
export type AttemptKind = "REGISTER" | "SIGN_IN" | "CONNECT" | "SESSION";

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
  /** The route this rung dialled -- only on a rung that actually reached
   * the network. See `Dial`. */
  routeId?: string;
  /** Whether that dial carried traffic, by the egress check. */
  carried?: boolean;
}

/** One rung's dial, for the per-ISP tags: which route was tried from
 * this network and whether traffic got through.
 *
 * Null for a rung that says nothing about the network -- skipped before
 * dialling, or refused for a reason that is the account's or the
 * device's rather than the network's. Counting those against a route
 * would tell other customers a route is failing when it is this
 * customer's quota that ran out. */
export type Dial = { routeId: string; carried: boolean } | null;

/** The dial a failed rung represents, by how it was classified.
 *
 * Only `serverUnreachable` is the network's doing -- a handshake that
 * never completed, or a tunnel that came up and carried nothing. Quota,
 * concurrency, an inactive subscription, a missing engine and an
 * unclassified error are not, and record no dial. */
export function failedDial(routeId: string, kind: string): Dial {
  return kind === "serverUnreachable" ? { routeId, carried: false } : null;
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
  /** What was tried, on a CONTROL_PLANE_UNREACHABLE report: the
   * rendered endpoint trace (see endpoint-trace.ts), or "none dialled",
   * sometimes followed by a `probe:` section (control-plane-probe.ts).
   *
   * The history of this field is a warning. The backend accepted it from
   * the start and no client sent it until 0.9.39 / 0.2.22, so every
   * unreachable row had a null here. When it was finally sent it was the
   * hostname of every address the client *would* try -- 233 characters
   * with the current bundle by the code, against a server limit of 200,
   * which would have been a 400 that `send` counted as delivered. That
   * was once written up as every such report lost; production's log
   * says no 400 was answered (14 days to 2026-10-06: 1079 POSTs answered
   * 204, none 400), and no row has the field set -- no report carrying
   * the list arrived at all. A comment here also read the rows as Windows
   * reaching the API less often than Android; they were the mobile app's
   * iOS builds mislabelled as Windows (see `detectPlatform`).
   *
   * So it is now what actually happened, address by address, and its
   * length is fitted here and again in `send` rather than trusted. */
  apiEndpoint?: string;
  /** For a SESSION report: seconds the tunnel has carried traffic. */
  sessionSeconds?: number;
}

interface QueuedReport extends AttemptReport {
  platform: string;
  appVersion: string;
  occurredAt: string;
  /** The network attestation held when it happened. */
  network?: string;
}

/** Which platform the user agent suggests -- the fallback only.
 *
 * This was the only source until the binary was asked instead (see
 * `reportedPlatform`), and what it got wrong is why. It used to stop at
 * android-or-windows, and this file is compiled into the mobile app as
 * well, so every iOS report from mobile 0.2.18 to 0.2.21 was filed as a
 * Windows one: all 182 "windows" CONTROL_PLANE_UNREACHABLE rows in the
 * table on 2026-10-06 carry a 0.2.x version, while the real Windows
 * client had recorded none. It read as "Windows cannot reach the API"
 * and was written up that way.
 *
 * The iOS test is the same one `apps/mobile/src/lib/platform.ts` uses:
 * iPadOS reports itself as a Mac and only a touchscreen gives it away.
 * And anything it does not recognise is "unknown", never a particular
 * platform -- the defect was a guess defaulting to a real answer.
 */
export function detectPlatform(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0,
): string {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  if (/macintosh/i.test(userAgent)) return maxTouchPoints > 1 ? "ios" : "macos";
  if (/windows/i.test(userAgent)) return "windows";
  return "unknown";
}

/** The platform names a binary can report. Anything else coming back
 * from the command is treated as no answer. */
const KNOWN_PLATFORMS = new Set(["windows", "android", "ios", "macos", "linux"]);

/** Which build this is: the OS the binary was compiled for.
 *
 * Asked of Rust (`build_platform`, registered by the Windows and mobile
 * apps) because the compile target cannot be mislabelled the way a user
 * agent can -- an iPad is "ios" whatever its webview calls itself, and an
 * Android tablet in desktop mode is still "android". The user agent is
 * only the fallback, for a shell that does not register the command.
 *
 * Cached for the process, like the version: it cannot change while the
 * app runs, and one IPC call is enough. */
let platformPromise: Promise<string> | null = null;
export function reportedPlatform(): Promise<string> {
  platformPromise ??= invoke<unknown>("build_platform").then(
    (os) => (typeof os === "string" && KNOWN_PLATFORMS.has(os) ? os : detectPlatform()),
    () => detectPlatform(),
  );
  return platformPromise;
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

/** The status the server's throttle answers with. See `send`. */
const THROTTLED = 429;

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

/** Sends one report. Resolves false when it should be kept and sent
 * later: the control plane could not be reached, or it said "not now".
 *
 * Any other rejection *from* the server -- a 400, a 5xx, anything with a
 * status -- counts as delivered. It means we reached it and it did not
 * want this, and retrying forever would turn one malformed report into
 * a permanent background load.
 *
 * The throttle is the exception, because it is about timing and not the
 * report. The endpoint allows twenty a minute per address, and one
 * reconnect sends a report and then flushes a queue of up to
 * `MAX_QUEUED` -- so the reports queued while the control plane was
 * unreachable, which are the ones this whole file exists for, were the
 * ones answered 429 and dropped. Customers behind one carrier NAT share
 * that address, which makes it likelier still. Kept instead; the flush
 * stops at the first one, and the next contact carries on.
 *
 * And one allowance for a server older than this client. Until the
 * limit was raised, the backend refused an `apiEndpoint` over 200
 * characters with a 400, and an endpoint trace is often longer. Against
 * such a server -- production, until it is redeployed -- the report is
 * sent once more with the trace cut to fit, rather than lost whole over
 * its longest field. A current server never sees the second request.
 */
async function send(report: QueuedReport): Promise<boolean> {
  // Attached by hand rather than by using the authenticated helper. That
  // one refreshes on a 401 and reports session expiry to the UI, and a
  // background diagnostic must never be the thing that signs somebody
  // out. An expired token here simply leaves the report anonymous --
  // the server verifies it if it can and ignores it if it cannot.
  const tokens = await getTokens();
  const post = (body: QueuedReport) =>
    publicRequest<void>("/client-attempts", {
      method: "POST",
      body: JSON.stringify(body),
      headers: tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
    });

  let result = await post(report);
  if (!result.ok && result.status === 400 && (report.apiEndpoint?.length ?? 0) > LEGACY_API_ENDPOINT_MAX) {
    result = await post({ ...report, apiEndpoint: clipTrace(report.apiEndpoint!, LEGACY_API_ENDPOINT_MAX) });
  }

  if (result.ok) return true;
  if (result.status === THROTTLED) return false;
  // publicRequest flattens both cases into a string, and only one of
  // them should keep the report alive. This is the message it uses when
  // no endpoint answered at all.
  return !result.error.startsWith("Could not reach Neoxify");
}

/** Attaches the network, or strips what only a new server understands.
 *
 * The per-ISP fields -- the attestation, routes and outcomes on ladder
 * rungs, and the SESSION kind itself -- are rejected outright by a
 * backend that predates them: its validation refuses unknown fields with
 * a 400, and `send` counts a 400 as delivered and drops the report. So a
 * client released before the backend would quietly lose every connect
 * report it sends.
 *
 * Holding an attestation is the proof the server is new enough, since
 * only a server with the feature issues one. With one, everything goes.
 * Without, the report is sent in the shape every server accepts, and a
 * SESSION report -- which says nothing useful without a network -- is
 * not sent at all. Returns null for "do not send". */
export function withNetwork(report: AttemptReport, attestation = currentAttestation()): (AttemptReport & { network?: string }) | null {
  if (attestation) return { ...report, network: attestation };
  if (report.kind === "SESSION") return null;
  const { sessionSeconds: _unused, ...rest } = report;
  return {
    ...rest,
    attempts: report.attempts?.map(({ protocol, result }) => ({ protocol, result })),
  };
}

/** More to say about a report than was known when it was made: what the
 * socket-level probe found (control-plane-probe.ts), which takes up to
 * twenty seconds. Each field is added to the report's own after "; ". */
export interface AttemptAddendum {
  apiEndpoint?: string;
  reason?: string;
}

const REASON_MAX = 500;

/** `report` with `addendum` added to it, each field still fitted. */
function amended(report: QueuedReport, addendum: AttemptAddendum): QueuedReport {
  const join = (own?: string, more?: string) => (own && more ? `${own}; ${more}` : (own ?? more));
  const apiEndpoint = join(report.apiEndpoint, addendum.apiEndpoint);
  return {
    ...report,
    reason: join(report.reason, addendum.reason)?.slice(0, REASON_MAX),
    apiEndpoint: apiEndpoint === undefined ? undefined : clipTrace(apiEndpoint, API_ENDPOINT_MAX),
  };
}

/** Queues a report to go out on the next contact. */
async function enqueue(report: QueuedReport): Promise<void> {
  const queue = await readQueue();
  queue.push(report);
  await writeQueue(queue.slice(-MAX_QUEUED));
}

/** Whether a queued report is `original`, as it was made. Matched on
 * what it was stamped with rather than an id of its own, which the
 * server would refuse as an unknown field. */
function isSameReport(candidate: QueuedReport, original: QueuedReport): boolean {
  return (
    candidate.occurredAt === original.occurredAt &&
    candidate.kind === original.kind &&
    candidate.outcome === original.outcome &&
    candidate.reason === original.reason
  );
}

/** An addendum whose report has already gone, sent as a row of its own.
 *
 * OTHER rather than the original's outcome, so a follow-up is never
 * counted as a second failure -- the unreachable count is the number this
 * telemetry exists to get right. The reason names the report it belongs
 * to, and it carries that report's time, so the two sort together. */
async function sendFollowUp(original: QueuedReport, addendum: AttemptAddendum): Promise<void> {
  const followUp: QueuedReport = amended(
    {
      kind: original.kind,
      outcome: "OTHER",
      platform: original.platform,
      appVersion: original.appVersion,
      occurredAt: original.occurredAt,
      ...(original.network ? { network: original.network } : {}),
      reason: `probe follow-up to the ${original.kind} ${original.outcome} report of ${original.occurredAt}, which was no longer held when the probe answered; not an attempt`,
    },
    addendum,
  );
  if (!(await send(followUp))) await enqueue(followUp);
}

/** Adds a late addendum to its report: in the queue if the report is
 * still waiting there, which is the usual case -- the control plane was
 * unreachable a moment ago -- or as a follow-up if it has gone since. */
async function addLate(original: QueuedReport, addendum: AttemptAddendum): Promise<void> {
  const queue = await readQueue();
  const at = queue.findIndex((r) => isSameReport(r, original));
  if (at === -1) {
    await sendFollowUp(original, addendum);
    return;
  }
  queue[at] = amended(queue[at], addendum);
  await writeQueue(queue);
}

/** Records how an attempt went, and tries to send it.
 *
 * Fire and forget: call it with `void`. It resolves when it is done and
 * never rejects, but nothing should wait for it.
 *
 * `addendum` is more of the same report that is still being worked out
 * -- the probe after an unreachable control plane. The report does not
 * wait for it. It is sent, or queued, as it would be without one; an
 * addendum ready by the time it has to be queued goes in with it, and
 * one that arrives later is added to the queued report, or sent after it
 * as a follow-up if the report is no longer held -- delivered, by this
 * call or a flush, or pushed out of the queue. On iOS a backgrounded app
 * is suspended within seconds and may be killed after that, and a report
 * held back for a twenty-second probe could die with it.
 */
export async function reportAttempt(
  report: AttemptReport,
  addendum?: Promise<AttemptAddendum | undefined>,
): Promise<void> {
  try {
    const shaped = withNetwork(report);
    if (shaped === null) return;

    // Watched from the start, so an answer that lands while the report
    // is being sent can still go in with it.
    const early: { arrived: boolean; value?: AttemptAddendum } = { arrived: addendum === undefined };
    const later = addendum?.then(
      (value) => {
        early.value = value;
        early.arrived = true;
        return value;
      },
      () => {
        early.arrived = true;
        return undefined;
      },
    );

    const queued: QueuedReport = {
      ...shaped,
      platform: await reportedPlatform(),
      appVersion: await appVersion(),
      // Stamped now, even for the report that goes out immediately. The
      // server keeps its own arrival time regardless; this is what makes
      // a delayed report readable as delayed instead of as fresh.
      occurredAt: new Date().toISOString(),
      // A reason of unbounded length would be rejected by the server's
      // validation, losing the whole report over its least important
      // field.
      reason: report.reason?.slice(0, REASON_MAX),
      // The same, for the one field long enough to hit its limit: the
      // hostname list 0.9.39 to 0.9.43 send would overrun the old 200.
      apiEndpoint: shaped.apiEndpoint === undefined ? undefined : clipTrace(shaped.apiEndpoint, API_ENDPOINT_MAX),
    };

    if (await send(queued)) {
      // Reaching the server is also the signal that anything held back
      // can go now.
      await flushAttempts();
      const extra = await later;
      if (extra) await sendFollowUp(queued, extra);
      return;
    }

    // Kept now, not once the addendum is in.
    const inTime = early.arrived;
    await enqueue(inTime && early.value ? amended(queued, early.value) : queued);
    if (!inTime) {
      const extra = await later;
      if (extra) await addLate(queued, extra);
    }
  } catch {
    // Reporting must never surface as a failure of the thing being
    // reported on.
  }
}

/** Sends whatever is waiting. Safe to call whenever the app has reason
 * to think the control plane is reachable -- at launch, after a
 * successful sign-in.
 *
 * Stops at the first send that has to be kept rather than walking the
 * rest. With the control plane down, every remaining one would pay the
 * full endpoint-ladder timeout to learn the same thing; with the
 * throttle saying "not now", every remaining one would be told the same.
 * The periodic flush in App.tsx picks up where this left off.
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
export function rungsFrom(lines: string[], dials: Dial[] = []): AttemptRung[] {
  return lines.map((line, i) => {
    const split = line.indexOf(": ");
    const rung: AttemptRung =
      split === -1
        ? { protocol: line.slice(0, 64), result: "" }
        : { protocol: line.slice(0, split).slice(0, 64), result: line.slice(split + 2).slice(0, 200) };
    // Parallel to the lines, by index: the dashboards push one of each
    // per rung. A missing or null entry leaves the rung as it always was.
    const dial = dials[i];
    return dial ? { ...rung, routeId: dial.routeId, carried: dial.carried } : rung;
  });
}
