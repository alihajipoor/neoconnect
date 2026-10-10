import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** The report made when nothing answered the dashboard's load or the
 * server list, which used to make none.
 *
 * The first part runs a real request -- customer.ts and api.ts -- against
 * a network stood in for per address, so the trace in the report is the
 * one the request actually recorded. The report itself and the probe are
 * stood in for: how a report is queued and sent is attempts.test.ts's,
 * and the probe has its own tests. */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const ENDPOINTS = [A, B, C];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([...ENDPOINTS]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve(), isKnownBlockPage: () => false }));
vi.mock("./session", () => ({
  getTokens: async () => ({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: async () => undefined,
  clearTokens: async () => undefined,
}));

const reportAttempt = vi.fn();
vi.mock("./attempts", () => ({ reportAttempt: (r: unknown, addendum?: unknown) => reportAttempt(r, addendum) }));

type ProbeOptions = { pathChanging?: boolean };
const probeAddendum = vi.fn<(entries: unknown[], options?: ProbeOptions) => Promise<undefined>>();
vi.mock("./control-plane-probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-plane-probe")>()),
  probeAddendum: (entries: unknown[], options?: ProbeOptions) => probeAddendum(entries, options),
}));

const { getAvailableRoutes, getMe } = await import("./customer");
const { resetRaceWinnerForTests } = await import("./api");
const { beginAttempt, settleAttempt } = await import("./endpoint-trace");
const { ladderPass } = await import("./ladder-pass");
const { REPORT_INTERVAL_MS, resetUnansweredReportsForTests, snapshotAge, traceRequests } = await import(
  "./unanswered-report"
);

const UNREACHABLE: ApiResult<unknown> = {
  ok: false,
  error: "Could not reach Neoxify. Check your internet connection.",
  noResponse: true,
};

/** How every address treats a request: refused at once, or answered. */
let network: (url: string) => Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetRaceWinnerForTests();
  resetUnansweredReportsForTests();
  reportAttempt.mockReset();
  probeAddendum.mockReset();
  probeAddendum.mockResolvedValue(undefined);
  tauriFetch.mockReset();
  tauriFetch.mockImplementation((url: string) => network(url));
  network = (url) => Promise.reject(`error sending request for url (${url})`);
});

afterEach(() => {
  vi.useRealTimers();
  ladderPass.running.current = false;
});

/** The one report made, as `reportAttempt` was handed it. */
function theReport(): { kind: string; outcome: string; apiEndpoint: string; reason: string } {
  expect(reportAttempt).toHaveBeenCalledTimes(1);
  return reportAttempt.mock.calls[0][0] as { kind: string; outcome: string; apiEndpoint: string; reason: string };
}

describe("a server list that nothing answered", () => {
  /** The testers' symptom: the list says Neoxify could not be reached,
   * and until now nothing said so anywhere but on their screen. */
  it("is reported with the addresses the request tried, and what the screen did instead", async () => {
    const requests = traceRequests("server list");
    const result = await getAvailableRoutes("sub-1", requests.trace("routes"));
    expect(result.ok).toBe(false);

    const report = requests.settle({ routes: result });
    expect(report).not.toBeNull();
    expect(report!("showed the error, with no servers to list")).toBe(true);

    const sent = theReport();
    expect(sent.kind).toBe("CONNECT");
    expect(sent.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    // Each address the request asked, as it ended.
    for (const host of ["a.example", "b.example", "c.example"]) expect(sent.apiEndpoint).toMatch(new RegExp(`${host}=net@\\d+`));
    expect(sent.apiEndpoint.startsWith("req: ")).toBe(true);
    expect(sent.reason).toMatch(/^server list: no answer from Neoxify to routes after \d+ms; /);
    expect(sent.reason).toContain("not a connect, nothing is being dialled");
    expect(sent.reason).toContain("showed the error, with no servers to list");
    // The probe is asked about the same attempts, and is not held for.
    expect(probeAddendum).toHaveBeenCalledTimes(1);
    expect(probeAddendum.mock.calls[0][0]).toHaveLength(3);
    expect(probeAddendum.mock.calls[0][1]).toEqual({ pathChanging: false });
  });

  /** Reached, and refused or failed: not "could not reach", and not a
   * report of one. */
  it("is not reported when Neoxify answered, even with an error", async () => {
    network = () => Promise.resolve(json({ message: "Internal server error" }, 500));
    const requests = traceRequests("server list");
    const result = await getAvailableRoutes("sub-1", requests.trace("routes"));
    expect(result.ok).toBe(false);
    expect(requests.settle({ routes: result })).toBeNull();
    expect(reportAttempt).not.toHaveBeenCalled();
  });

  it("is not reported when it answered", async () => {
    network = () => Promise.resolve(json([]));
    const requests = traceRequests("server list");
    const result = await getAvailableRoutes("sub-1", requests.trace("routes"));
    expect(result.ok).toBe(true);
    expect(requests.settle({ routes: result })).toBeNull();
  });
});

describe("the dashboard's load", () => {
  it("names every request that went unanswered, and whose addresses it carries", async () => {
    const requests = traceRequests("dashboard load");
    const me = await getMe(requests.trace("me"));
    const subscriptions = requests.trace("subscriptions");
    settleAttempt(beginAttempt(subscriptions, "https://b.example/api", 0), "timeout", 20_000);
    requests.trace("protocol-users");

    requests.settle({
      me,
      subscriptions: UNREACHABLE,
      "protocol-users": { ok: false, error: "Internal server error", status: 500 },
    })!("showing the cached credentials, 35 min old");

    const sent = theReport();
    expect(sent.reason).toMatch(/^dashboard load: no answer from Neoxify to me, subscriptions after \d+ms; /);
    expect(sent.reason).toContain("showing the cached credentials, 35 min old");
    expect(sent.reason).toContain("; the trace is me's");
    // The one that did answer is said as it was, not as unreachable.
    expect(sent.reason).toContain("protocol-users answered 500");
    expect(sent.apiEndpoint).toMatch(/^req: a\.example=net@\d+/);
  });

  /** Nothing dialled is a fact worth stating, and naming addresses that
   * were never tried would be the opposite of one. */
  it("says nothing was dialled when nothing was", () => {
    const requests = traceRequests("dashboard load");
    requests.trace("me");
    requests.settle({ me: UNREACHABLE })!("showed the load error, with nothing cached to show");
    expect(theReport().apiEndpoint).toBe("none dialled");
  });

  it("is not reported for a request it did not trace", () => {
    const requests = traceRequests("dashboard load");
    expect(requests.settle({ me: UNREACHABLE })).toBeNull();
  });
});

/** The screens ask far more often than anything else that reports: the
 * dashboard every time it is shown, the list every time it is opened. */
describe("how often", () => {
  const unansweredFrom = (source: Parameters<typeof traceRequests>[0]) => {
    const requests = traceRequests(source);
    requests.trace("routes");
    return requests.settle({ routes: UNREACHABLE })!;
  };

  it("reports a source once in ten minutes, and the next report says how many were held back", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    expect(unansweredFrom("server list")("kept the 3 servers already on screen")).toBe(true);

    vi.setSystemTime(new Date("2026-10-09T12:01:00Z"));
    expect(unansweredFrom("server list")("kept the 3 servers already on screen")).toBe(false);
    vi.setSystemTime(new Date("2026-10-09T12:09:00Z"));
    expect(unansweredFrom("server list")("kept the 3 servers already on screen")).toBe(false);
    expect(reportAttempt).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.parse("2026-10-09T12:00:00Z") + REPORT_INTERVAL_MS));
    expect(unansweredFrom("server list")("kept the 3 servers already on screen")).toBe(true);
    expect(reportAttempt).toHaveBeenCalledTimes(2);
    const second = reportAttempt.mock.calls[1][0] as { reason: string };
    expect(second.reason).toContain("; 2 more like it since the last report, not sent");
    expect((reportAttempt.mock.calls[0][0] as { reason: string }).reason).not.toContain("more like it");
  });

  it("holds each source to its own interval", () => {
    expect(unansweredFrom("server list")("x")).toBe(true);
    expect(unansweredFrom("dashboard route list")("x")).toBe(true);
    expect(unansweredFrom("server switch")("x")).toBe(true);
    expect(unansweredFrom("server list")("x")).toBe(false);
    expect(reportAttempt).toHaveBeenCalledTimes(3);
  });

  /** Nothing to report spends nothing: a later failure is still told. */
  it("does not count an answered request against the interval", () => {
    const answered = traceRequests("server list");
    answered.trace("routes");
    expect(answered.settle({ routes: { ok: true, data: [] } })).toBeNull();
    expect(unansweredFrom("server list")("x")).toBe(true);
  });
});

/** The probe repeats the failed request's first steps at socket level. A
 * connect or a disconnect under way is moving the path it would measure. */
describe("the probe that follows", () => {
  const settleUnanswered = (appState?: string) => {
    const requests = traceRequests("dashboard load", appState);
    requests.trace("me");
    requests.settle({ me: UNREACHABLE })!("x");
    return probeAddendum.mock.calls[probeAddendum.mock.calls.length - 1][1];
  };

  it("is kept off a path a connect or a disconnect is moving", () => {
    expect(settleUnanswered("connecting")).toEqual({ pathChanging: true });
    resetUnansweredReportsForTests();
    expect(settleUnanswered("disconnecting")).toEqual({ pathChanging: true });
  });

  /** The dashboard loads as it mounts, often while a pass started from
   * another screen is still dialling; its own state does not know yet. */
  it("is kept off a path a ladder pass is moving, whatever the screen showed", () => {
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    expect(settleUnanswered("disconnected")).toEqual({ pathChanging: true });
  });

  it("runs on a path that is standing still", () => {
    expect(settleUnanswered("connected")).toEqual({ pathChanging: false });
  });
});

describe("snapshotAge", () => {
  it("says how old a snapshot is, in minutes", () => {
    expect(snapshotAge(10_000_000 - 35 * 60_000, 10_000_000)).toBe("35 min old");
  });

  it("does not make an age out of a clock that moved", () => {
    expect(snapshotAge(2_000_000, 1_000_000)).toBe("of unknown age");
    expect(snapshotAge(0, 1_000_000)).toBe("of unknown age");
  });
});
