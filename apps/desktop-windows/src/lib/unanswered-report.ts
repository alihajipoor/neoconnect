import type { ApiResult } from "./api";
import { reportAttempt } from "./attempts";
import { pathChangingIn, probeAddendum } from "./control-plane-probe";
import { newTrace, renderTrace, type EndpointTrace } from "./endpoint-trace";
import { ladderPass } from "./ladder-pass";
import { sessionGeneration } from "./session-end";
import { watchBackground } from "./visibility";

/** A report when nothing answered the screens' own requests to Neoxify.
 *
 * Sign-in, sign-up and the config refresh reported an unreachable control
 * plane, each with the addresses it tried. The requests a customer meets
 * most did not: the dashboard's load -- the account, the plan and the
 * credentials, asked for together every time the screen opens -- the
 * route list after it, and the server list's own refresh and switch. They
 * asked without a trace and reported nothing. On the test VM, launches
 * with every address blocked fell back to the offline banner and left no
 * row in client_attempts; only the refresh on coming back online
 * reported. Those are the failures testers on filtered networks describe:
 * the server list saying Neoxify could not be reached.
 *
 * A report here is a CONTROL_PLANE_UNREACHABLE row of kind CONNECT, as the
 * resume refresh's is: the vocabulary the panel already filters on, where
 * a kind of its own would need a schema migration -- and a backend that
 * predates it would refuse the report with a 400, which counts as
 * delivered. Its reason says which screen asked and that nothing was
 * being dialled. Made only when no address gave any HTTP answer to one of
 * the requests (`noResponse`): a screen that was answered with an error
 * did reach Neoxify, and is not reported as having failed to. */

/** Which screen's requests went unanswered. The opening words of the
 * report's reason, so rows can be split by what asked. */
export type RequestSource = "dashboard load" | "dashboard route list" | "server list" | "server switch";

/** At most one report per source per this long.
 *
 * The screens ask far more often than the refresh does. The dashboard
 * loads again each time it is shown -- it unmounts whenever Settings
 * opens -- and the server list refreshes each time it is opened. On a
 * network where Neoxify is blocked every one of those fails, and each
 * report then goes into a queue that keeps only the newest
 * twenty-five, pushing out the sign-in and connect reports that say more.
 * The answer will not have changed in ten minutes. What is not sent is
 * counted, and the next report says how many.
 *
 * Kept in the webview's storage, not only in memory. The phones start a
 * new process for most opens -- a backgrounded app is killed -- and with a
 * limit per process every open on a blocked network made a report of its
 * own, the exact flood the limit was for. Best effort: without storage it
 * holds for the run, as it did. */
export const REPORT_INTERVAL_MS = 10 * 60_000;

const STORAGE_KEY = "neoxify.unansweredReports";

/** When each source last reported, and how many it has held back since. */
interface Held {
  at: number;
  notSent: number;
}

let held = new Map<RequestSource, Held>();
let restored = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Restored lazily, once a run. Anything unreadable is dropped: one report
 * too many costs less than a report never made. */
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return;
    for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Held> | null;
      if (entry && typeof entry.at === "number" && Number.isFinite(entry.at)) {
        held.set(source as RequestSource, { at: entry.at, notSent: typeof entry.notSent === "number" ? entry.notSent : 0 });
      }
    }
  } catch {
    held = new Map();
  }
}

function persist(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(held)));
  } catch {
    // The limit still holds for this run.
  }
}

/** Sends the report for requests that went unanswered, saying what the
 * screen did instead -- "showing credentials cached 35 min ago". Returns
 * whether a report was made: false when the interval held it back. */
export type ReportUnanswered = (consequence: string) => boolean;

export interface TracedRequests {
  /** A trace for one request, under the name the report gives it. */
  trace(name: string): EndpointTrace;
  /** The requests have all settled. A report to send, or null when
   * nothing went unanswered -- every request answered, even with an
   * error, or none was traced.
   *
   * Separate from sending, because what the screen did instead is known
   * only later (whether a snapshot was cached, how many servers it
   * holds), and called on every path, so the background watch ends. */
  settle(results: Record<string, ApiResult<unknown>>): ReportUnanswered | null;
}

/** Starts tracing the requests one screen action makes together.
 *
 * `appState` is what the screen showed: as they began, or, given as a
 * function, as it is when asked -- the server list stays open while the
 * dashboard beneath it connects or disconnects. It is not put in the
 * reason: the dashboard's load runs as the screen mounts, before it has
 * asked what is up, and its state then is a default rather than anything
 * it was shown. It only keeps the socket-level probe from running across
 * a connect or a disconnect, as a pass under way also does
 * (`ladderPass`). See control-plane-probe.ts.
 *
 * Nothing is reported once the session the requests began in has ended.
 * A sign-out can land while they are still waiting on a blocked address;
 * reported after it, the report went out under nobody, or under whoever
 * had signed in by then, and described a screen that had gone. */
export function traceRequests(source: RequestSource, appState?: string | (() => string | undefined)): TracedRequests {
  const traces = new Map<string, EndpointTrace>();
  const startedAt = Date.now();
  const sessionAtStart = sessionGeneration();
  const stateAt = () => (typeof appState === "function" ? appState() : appState);
  const stateAtStart = stateAt();
  // Whether a connect of the app's own was running as they began.
  const connectingAtStart = ladderPass.inFlight();
  // Whether the app was backgrounded while they ran: on iOS that
  // suspends it, and a timeout then says nothing about the network.
  const backgrounded = watchBackground();
  let settled = false;

  return {
    trace(name) {
      const trace = newTrace();
      traces.set(name, trace);
      return trace;
    },

    settle(results) {
      if (settled) return null;
      settled = true;
      const hidden = backgrounded();
      const settledAt = Date.now();

      const named = Object.entries(results);
      const unanswered = named.filter(([name, result]) => !result.ok && result.noResponse && traces.has(name));
      if (unanswered.length === 0) return null;
      // Rendered now, while they still describe what happened.
      const [carriedName] = unanswered[0];
      const carried = traces.get(carriedName)!;
      const tried = renderTrace(carried, settledAt);
      const others = named.flatMap(([name, result]) => {
        if (result.ok || result.noResponse) return [];
        return [result.status !== undefined ? `${name} answered ${result.status}` : `${name} failed: ${result.error}`];
      });

      return (consequence) => {
        if (sessionGeneration() !== sessionAtStart) return false;
        restore();
        const now = Date.now();
        const last = held.get(source);
        // A time in the future is a clock set back, not a recent report.
        if (last !== undefined && now - last.at >= 0 && now - last.at < REPORT_INTERVAL_MS) {
          held.set(source, { at: last.at, notSent: last.notSent + 1 });
          persist();
          return false;
        }
        const skipped = last?.notSent ?? 0;
        held.set(source, { at: now, notSent: 0 });
        persist();

        const names = unanswered.map(([name]) => name);
        // The requests' own path may have been moving under them: the app's
        // own connect was dialling -- one started from another screen goes
        // on while the dashboard loads -- and its failures may be that.
        const dialling = connectingAtStart || ladderPass.inFlight();
        const reason =
          `${source}: no answer from Neoxify to ${names.join(", ")} after ${settledAt - startedAt}ms; ` +
          (dialling
            ? `not a connect, but one of the app's own was under way; ${consequence}`
            : `not a connect, nothing is being dialled; ${consequence}`) +
          // Each request asks every address; one trace says what they all
          // met, and which one it is has to be said when there were more.
          (names.length > 1 ? `; the trace is ${carriedName}'s` : "") +
          (others.length > 0 ? `; ${others.join("; ")}` : "") +
          (hidden ? "; app was in the background during it" : "") +
          (skipped > 0 ? `; ${skipped} more like it since the last report, not sent` : "");

        // Made now, with the trace; the probe's answer follows it rather
        // than holding it back -- see `reportAttempt`.
        void reportAttempt(
          {
            kind: "CONNECT",
            outcome: "CONTROL_PLANE_UNREACHABLE",
            apiEndpoint: tried === "" ? "none dialled" : tried,
            reason,
          },
          probeAddendum(carried.entries, {
            pathChanging: pathChangingIn(stateAtStart) || pathChangingIn(stateAt()) || ladderPass.inFlight(),
          }),
        );
        return true;
      };
    },
  };
}

/** How old a cached snapshot is, in a report's words. A time in the
 * future is a clock that moved, not an age. */
export function snapshotAge(savedAt: number, now = Date.now()): string {
  return Number.isFinite(savedAt) && savedAt > 0 && savedAt <= now
    ? `${Math.round((now - savedAt) / 60_000)} min old`
    : "of unknown age";
}

/** For tests: forget every report, as a fresh process would. What is in
 * storage is read again on next use. */
export function resetUnansweredReportsForTests(): void {
  held = new Map();
  restored = false;
}
