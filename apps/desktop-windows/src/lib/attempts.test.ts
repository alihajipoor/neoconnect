import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** What `reportAttempt` actually puts on the wire.
 *
 * Everything below the report is stood in for: the Tauri store (an
 * in-memory map, so the queue is real), the version, the Rust command,
 * and the request itself, which is a spy that records each body. */

const files = new Map<string, Map<string, unknown>>();
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    let data = files.get(name);
    if (!data) {
      data = new Map<string, unknown>();
      files.set(name, data);
    }
    const store = data;
    return {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => store.delete(key),
      save: async () => undefined,
    };
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("9.9.9") }));

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const publicRequest = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<void>>>();
vi.mock("./api", () => ({
  publicRequest: (path: string, init?: RequestInit) => publicRequest(path, init),
  requestFailed: (status: number) => `Request failed (${status})`,
}));
/** The session held right now: whoever is signed in, or nobody. */
const session: { current: { accessToken: string; refreshToken: string } | null } = { current: null };
vi.mock("./session", () => ({ getTokens: async () => session.current }));
vi.mock("./network-identity", () => ({ currentAttestation: () => null }));

type Attempts = typeof import("./attempts");
let attempts: Attempts;

/** Each body that was posted, parsed. */
function sentBodies(): Record<string, unknown>[] {
  return publicRequest.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

beforeEach(async () => {
  for (const data of files.values()) data.clear();
  session.current = null;
  invoke.mockReset();
  publicRequest.mockReset();
  publicRequest.mockResolvedValue({ ok: true, data: undefined });
  // The platform is cached per process; a fresh module is a fresh process.
  vi.resetModules();
  attempts = await import("./attempts");
});

describe("the platform a report carries", () => {
  /** The compile target, not the webview's description of itself. An
   * iPad's webview calls itself a Mac; the binary does not. */
  it("is what the binary was built for", async () => {
    invoke.mockResolvedValue("ios");
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(invoke).toHaveBeenCalledWith("build_platform", undefined);
    expect(sentBodies()[0].platform).toBe("ios");
  });

  /** A shell that does not register the command still reports, on the
   * user agent's best guess. */
  it("falls back to the user agent when there is no command", async () => {
    invoke.mockRejectedValue("command build_platform not found");
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(sentBodies()[0].platform).toBe(attempts.detectPlatform());
  });

  it("does not pass on an answer that is not a platform", async () => {
    invoke.mockResolvedValue("");
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(sentBodies()[0].platform).toBe(attempts.detectPlatform());
  });

  it("asks once per process", async () => {
    invoke.mockResolvedValue("android");
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "SUCCESS" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sentBodies().map((b) => b.platform)).toEqual(["android", "android"]);
  });
});

/** The queue exists for the reports that could not be sent when they
 * happened. One reconnect sends a report and flushes up to 25 more,
 * against a throttle of twenty a minute -- and a 429 used to count as
 * delivered, so the queued ones were the ones thrown away. */
describe("the throttle", () => {
  const THROTTLED: ApiResult<void> = { ok: false, error: "ThrottlerException: Too Many Requests", status: 429 };
  const UNREACHABLE: ApiResult<void> = {
    ok: false,
    error: "Could not reach Neoxify. Check your internet connection.",
    noResponse: true,
  };
  const queued = () => (files.get("attempt-reports.json")?.get("reports") as unknown[] | undefined) ?? [];

  beforeEach(() => invoke.mockResolvedValue("windows"));

  it("keeps a throttled report and sends it on the next contact", async () => {
    publicRequest.mockResolvedValueOnce(THROTTLED).mockResolvedValue({ ok: true, data: undefined });

    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "REJECTED", reason: "first" });
    expect(queued()).toHaveLength(1);

    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS", reason: "second" });
    expect(sentBodies().map((b) => b.reason)).toEqual(["first", "second", "first"]);
    expect(queued()).toHaveLength(0);
  });

  /** Stops at the throttle and keeps the rest, rather than walking on
   * into twenty more refusals. */
  it("stops a flush at the throttle and keeps what was not sent", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    for (let i = 0; i < 25; i += 1) {
      await attempts.reportAttempt({ kind: "CONNECT", outcome: "CONTROL_PLANE_UNREACHABLE", reason: `r${i}` });
    }
    expect(queued()).toHaveLength(25);

    // The report that reaches the server, then nineteen of the queue,
    // then the throttle.
    publicRequest.mockReset();
    let calls = 0;
    publicRequest.mockImplementation(async () => (++calls <= 20 ? { ok: true, data: undefined } : THROTTLED));
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "SUCCESS" });

    expect(calls).toBe(21);
    expect(queued()).toHaveLength(6);
    // The oldest went first; what is left is the newest, in order.
    expect((queued() as { reason: string }[]).map((r) => r.reason)).toEqual(["r19", "r20", "r21", "r22", "r23", "r24"]);
  });

  /** A report whose health race the backend answered, and whose own
   * request then got no answer, is told so in other words than "could not
   * reach Neoxify". It never arrived either, and is kept. */
  it("keeps a report that got no answer, whatever the sentence", async () => {
    publicRequest.mockResolvedValue({
      ok: false,
      error: "Neoxify answered but then stopped responding. Please try again.",
      noResponse: true,
    });
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "CONTROL_PLANE_UNREACHABLE", reason: "r" });
    expect(queued()).toHaveLength(1);
  });

  /** Everything else with a status is still a verdict on the report,
   * not on the timing, and is not retried. */
  it("still drops a report the server refused for any other reason", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Internal server error", status: 500 });
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(queued()).toHaveLength(0);
  });
});

/** The field that can make the server refuse a whole report: a limit of
 * 200 on the server still in production, traces far longer, and a 400
 * the client counts as delivered. */
describe("the length of apiEndpoint", () => {
  const trace = Array.from({ length: 40 }, (_, i) => `edge-${i}.example.org:2053=timeout@8000`).join(" ");
  const unreachable = { kind: "CONNECT" as const, outcome: "CONTROL_PLANE_UNREACHABLE" as const };

  it("is fitted to the server's limit before it is sent", async () => {
    invoke.mockResolvedValue("windows");
    await attempts.reportAttempt({ ...unreachable, apiEndpoint: `req: ${trace} ${trace}` });
    const sent = String(sentBodies()[0].apiEndpoint);
    expect(sent.length).toBeLessThanOrEqual(2000);
    expect(sent.startsWith("req: edge-0.example.org:2053=timeout@8000")).toBe(true);
  });

  /** Production refuses anything over 200 until it is redeployed. The
   * report goes again, cut to fit, instead of being lost whole. */
  it("is cut to the old limit and resent when an old server refuses it", async () => {
    invoke.mockResolvedValue("windows");
    publicRequest
      .mockResolvedValueOnce({ ok: false, error: "apiEndpoint must be shorter than or equal to 200 characters", status: 400 })
      .mockResolvedValue({ ok: true, data: undefined });

    await attempts.reportAttempt({ ...unreachable, apiEndpoint: `req: ${trace}` });

    const bodies = sentBodies();
    expect(bodies).toHaveLength(2);
    expect(String(bodies[0].apiEndpoint).length).toBeGreaterThan(200);
    expect(String(bodies[1].apiEndpoint).length).toBeLessThanOrEqual(200);
    expect(String(bodies[1].apiEndpoint)).toMatch(/; \[\d+ cut\]; /);
    // Everything else is the same report.
    expect({ ...bodies[1], apiEndpoint: null }).toEqual({ ...bodies[0], apiEndpoint: null });
  });

  /** A 400 for any other reason is not retried: the second request is
   * only for the one field an old server is known to refuse. */
  it("is not resent when it already fitted", async () => {
    invoke.mockResolvedValue("windows");
    publicRequest.mockResolvedValue({ ok: false, error: "bad", status: 400 });
    await attempts.reportAttempt({ ...unreachable, apiEndpoint: "req: a.example=net@3" });
    expect(publicRequest).toHaveBeenCalledTimes(1);
  });
});

/** The probe after an unreachable control plane takes up to twenty
 * seconds. The report it belongs to must not wait for it: on iOS a
 * backgrounded app is suspended within seconds and may be killed, and a
 * report still held in memory dies with it. */
describe("an addendum that is still being worked out", () => {
  const UNREACHABLE: ApiResult<void> = {
    ok: false,
    error: "Could not reach Neoxify. Check your internet connection.",
    noResponse: true,
  };
  const queued = () => (files.get("attempt-reports.json")?.get("reports") as Record<string, unknown>[] | undefined) ?? [];
  const report = {
    kind: "SIGN_IN" as const,
    outcome: "CONTROL_PLANE_UNREACHABLE" as const,
    reason: "Could not reach Neoxify.",
    apiEndpoint: "req: a.example=timeout@8000",
  };
  const PROBE = { apiEndpoint: "probe: a.example=dns@40" };

  /** A promise and the function that settles it, for a probe whose
   * answer the test decides when to give. */
  function later<T>() {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  }

  beforeEach(() => invoke.mockResolvedValue("ios"));

  it("does not hold the report back for it", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    const probe = later<typeof PROBE | undefined>();
    void attempts.reportAttempt(report, probe.promise);

    // On disk before the probe has said anything.
    await vi.waitFor(() => expect(queued()).toHaveLength(1));
    expect(queued()[0].apiEndpoint).toBe("req: a.example=timeout@8000");
    probe.settle(undefined);
  });

  /** The usual case: the control plane was unreachable a moment ago, so
   * the report is still in the queue when the probe answers. */
  it("adds a late answer to the queued report", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    const probe = later<{ apiEndpoint: string; reason?: string } | undefined>();
    const done = attempts.reportAttempt(report, probe.promise);
    await vi.waitFor(() => expect(queued()).toHaveLength(1));

    probe.settle({ ...PROBE, reason: "app was in the background during the probe" });
    await done;

    expect(queued()).toHaveLength(1);
    expect(queued()[0].apiEndpoint).toBe("req: a.example=timeout@8000; probe: a.example=dns@40");
    expect(queued()[0].reason).toBe("Could not reach Neoxify.; app was in the background during the probe");
    // Still one report, not one plus a follow-up.
    expect(sentBodies().every((b) => b.outcome === "CONTROL_PLANE_UNREACHABLE")).toBe(true);
  });

  it("queues an answer that was ready in time together with the report", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(report, Promise.resolve(PROBE));
    expect(queued()).toHaveLength(1);
    expect(queued()[0].apiEndpoint).toBe("req: a.example=timeout@8000; probe: a.example=dns@40");
  });

  /** Gone already, so the answer goes as a row of its own -- OTHER, so it
   * is never counted as a second failure, and naming its report. */
  it("sends a late answer as a follow-up when the report has already gone", async () => {
    const probe = later<typeof PROBE | undefined>();
    const done = attempts.reportAttempt(report, probe.promise);
    await vi.waitFor(() => expect(publicRequest).toHaveBeenCalledTimes(1));

    probe.settle(PROBE);
    await done;

    const [original, followUp] = sentBodies();
    expect(original.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    expect(original.apiEndpoint).toBe("req: a.example=timeout@8000");
    expect(followUp.kind).toBe("SIGN_IN");
    expect(followUp.outcome).toBe("OTHER");
    expect(followUp.apiEndpoint).toBe("probe: a.example=dns@40");
    expect(followUp.occurredAt).toBe(original.occurredAt);
    expect(String(followUp.reason)).toContain(`SIGN_IN CONTROL_PLANE_UNREACHABLE report of ${original.occurredAt}`);
    expect(followUp.platform).toBe("ios");
  });

  /** Queued, then delivered by a flush before the probe answered. */
  it("sends a follow-up when a flush took the queued report first", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    const probe = later<typeof PROBE | undefined>();
    const done = attempts.reportAttempt(report, probe.promise);
    await vi.waitFor(() => expect(queued()).toHaveLength(1));

    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();
    expect(queued()).toHaveLength(0);

    probe.settle(PROBE);
    await done;
    const bodies = sentBodies();
    const last = bodies[bodies.length - 1];
    expect(last.outcome).toBe("OTHER");
    expect(last.apiEndpoint).toBe("probe: a.example=dns@40");
  });

  it("adds nothing when there is nothing to add", async () => {
    await attempts.reportAttempt(report, Promise.resolve(undefined));
    expect(publicRequest).toHaveBeenCalledTimes(1);
  });

  /** The follow-up never reaches the server with a field it would refuse. */
  it("sends no field the server does not know", async () => {
    const probe = later<typeof PROBE | undefined>();
    const done = attempts.reportAttempt(report, probe.promise);
    await vi.waitFor(() => expect(publicRequest).toHaveBeenCalledTimes(1));
    probe.settle(PROBE);
    await done;
    expect(Object.keys(sentBodies()[1]).sort()).toEqual(
      ["apiEndpoint", "appVersion", "kind", "occurredAt", "outcome", "platform", "reason"].sort(),
    );
  });
});

/** Whose report it is. The reports worth having could not be sent when
 * they happened, and go out on a later contact: with the token held then,
 * which had usually expired -- so they were filed under nobody -- or
 * belonged to someone else altogether. */
describe("the customer a report is filed under", () => {
  const UNREACHABLE: ApiResult<void> = {
    ok: false,
    error: "Could not reach Neoxify. Check your internet connection.",
    noResponse: true,
  };
  const queued = () => (files.get("attempt-reports.json")?.get("reports") as Record<string, unknown>[] | undefined) ?? [];
  const signedIn = (accessToken: string) => ({ accessToken, refreshToken: `${accessToken}-refresh` });
  /** The Authorization each request carried, in order; null for none. */
  const sentAs = () =>
    publicRequest.mock.calls.map(([, init]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers.Authorization ?? null;
    });
  const unreachable = { kind: "CONNECT" as const, outcome: "CONTROL_PLANE_UNREACHABLE" as const, reason: "r" };

  beforeEach(() => invoke.mockResolvedValue("windows"));

  /** The test VM's case: made during an outage, delivered after the
   * token it was made with had been replaced by a refresh. */
  it("is the session it was made in, not the one holding a token at delivery", async () => {
    session.current = signedIn("made-with");
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(unreachable);
    expect(queued()).toHaveLength(1);

    session.current = signedIn("refreshed-later");
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();

    expect(queued()).toHaveLength(0);
    expect(sentAs()).toEqual(["Bearer made-with"]);
  });

  /** Signed out, or another customer signed in, before it went. */
  it("stays with its own customer after a sign-out or a change of account", async () => {
    session.current = signedIn("alice");
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(unreachable);

    session.current = signedIn("bob");
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });

    // Bob's own report, then Alice's from the queue under Alice.
    expect(sentAs()).toEqual(["Bearer bob", "Bearer alice"]);
  });

  /** A sign-in that could not reach Neoxify has no customer, and the
   * customer who signs in afterwards is not proof of one. It used to be
   * filed under them. */
  it("is nobody's when nobody was signed in, whoever is by delivery", async () => {
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "CONTROL_PLANE_UNREACHABLE", reason: "r" });

    session.current = signedIn("signed-in-later");
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();

    expect(sentAs()).toEqual([null]);
  });

  it("goes out with no token field in the body", async () => {
    session.current = signedIn("t");
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(unreachable);
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();
    expect(sentBodies()[0]).not.toHaveProperty("bearer");
    expect(JSON.stringify(sentBodies()[0])).not.toContain("t-refresh");
    expect(JSON.stringify(sentBodies()[0])).not.toMatch(/"t"/);
  });

  /** A probe's answer that comes after its report has gone is filed with
   * that report, under the same customer. */
  it("carries over to a probe follow-up", async () => {
    session.current = signedIn("made-with");
    let settle!: (value: { apiEndpoint: string }) => void;
    const probe = new Promise<{ apiEndpoint: string }>((resolve) => {
      settle = resolve;
    });
    const done = attempts.reportAttempt({ ...unreachable, apiEndpoint: "req: a.example=timeout@8000" }, probe);
    await vi.waitFor(() => expect(publicRequest).toHaveBeenCalledTimes(1));
    session.current = signedIn("refreshed-later");
    settle({ apiEndpoint: "probe: a.example=dns@40" });
    await done;
    expect(sentAs()).toEqual(["Bearer made-with", "Bearer made-with"]);
  });

  /** Queued by a build that did not keep the token: sent as it always
   * was, with whatever is held at delivery. */
  it("is the session held at delivery for a report an older build queued", async () => {
    files.set(
      "attempt-reports.json",
      new Map<string, unknown>([
        [
          "queue",
          [{ ...unreachable, platform: "windows", appVersion: "0.9.47", occurredAt: new Date().toISOString() }],
        ],
      ]),
    );
    session.current = signedIn("held-now");
    await attempts.flushAttempts();
    expect(sentAs()).toEqual(["Bearer held-now"]);
  });
});

/** An access token as the backend mints one, for what the client reads
 * of it: the customer (`sub`) and the session (`sid`). Unsigned -- the
 * client never verifies, only compares. */
function token(sub: string, sid: string): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, sid, exp: 1 })}.signature`;
}

describe("the token a queued report goes out with", () => {
  const UNREACHABLE: ApiResult<void> = {
    ok: false,
    error: "Could not reach Neoxify. Check your internet connection.",
    noResponse: true,
  };
  const unreachable = { kind: "CONNECT" as const, outcome: "CONTROL_PLANE_UNREACHABLE" as const, reason: "r" };
  const sentAs = () =>
    publicRequest.mock.calls.map(([, init]) => ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null);

  beforeEach(() => invoke.mockResolvedValue("windows"));

  /** The server counts a report against the session in a token that
   * verifies, and against the address otherwise; an expired token does
   * not verify for that. The token a report was made with has usually
   * expired by the flush, and through a mirror or the tunnel the address
   * is the node's, shared by everyone on it. Before: sent with the expired
   * one, and the flush after an outage ran into the node's shared limit. */
  it("is the token held now when it is the same customer's", async () => {
    session.current = { accessToken: token("customer-1", "session-1"), refreshToken: "r" };
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(unreachable);

    const renewed = token("customer-1", "session-2");
    session.current = { accessToken: renewed, refreshToken: "r" };
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();

    expect(sentAs()).toEqual([`Bearer ${renewed}`]);
  });

  it("is still its own when another customer is signed in now", async () => {
    const alice = token("alice", "a1");
    session.current = { accessToken: alice, refreshToken: "r" };
    publicRequest.mockResolvedValue(UNREACHABLE);
    await attempts.reportAttempt(unreachable);

    session.current = { accessToken: token("bob", "b1"), refreshToken: "r" };
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();

    expect(sentAs()).toEqual([`Bearer ${alice}`]);
  });
});

describe("a sign-out with reports queued", () => {
  const queued = () => (files.get("attempt-reports.json")?.get("reports") as Record<string, unknown>[] | undefined) ?? [];
  const unreachable = { kind: "CONNECT" as const, outcome: "CONTROL_PLANE_UNREACHABLE" as const, reason: "r" };

  beforeEach(() => invoke.mockResolvedValue("windows"));

  /** Before: the session's access token stayed on disk beside each report
   * until it was sent -- days, on a network that could not reach Neoxify
   * -- for the next person on the machine to read and use. */
  it("leaves no access token on disk, and the reports go out under nobody", async () => {
    session.current = { accessToken: "alice-access", refreshToken: "r" };
    publicRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify.", noResponse: true });
    await attempts.reportAttempt(unreachable);
    expect(JSON.stringify(queued())).toContain("alice-access");

    session.current = null;
    await attempts.forgetQueuedSessions();

    expect(queued()).toHaveLength(1);
    expect(JSON.stringify([...(files.get("attempt-reports.json")?.values() ?? [])])).not.toContain("alice-access");

    session.current = { accessToken: "bob-access", refreshToken: "r" };
    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await attempts.flushAttempts();
    const headers = (publicRequest.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  /** Read from the source: the sign-out is where it happens. */
  it("is what ending a session does", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./session-end.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function endCustomerSession"));
    expect(body).toContain("await forgetQueuedSessions();");
    expect(body.indexOf("await forgetQueuedSessions();")).toBeGreaterThan(body.indexOf("await clearTokens();"));
  });
});

describe("where the queue is kept", () => {
  /** A build up to 0.9.47 installed over this one reads the old key and
   * sends a queued report's every field as the body. Before: it found a
   * report with its token in, sent the token in the body, was refused
   * with a 400, and dropped the report as delivered. */
  it("is not where an older build would read it", async () => {
    invoke.mockResolvedValue("windows");
    session.current = { accessToken: "made-with", refreshToken: "r" };
    publicRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify.", noResponse: true });
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "CONTROL_PLANE_UNREACHABLE", reason: "r" });

    const store = files.get("attempt-reports.json")!;
    expect(store.get("queue")).toBeUndefined();
    expect(store.get("reports")).toHaveLength(1);
  });

  it("takes in what an older build left under the old key", async () => {
    invoke.mockResolvedValue("windows");
    const old = { kind: "SIGN_IN", outcome: "CONTROL_PLANE_UNREACHABLE", platform: "windows", appVersion: "0.9.47", occurredAt: new Date().toISOString() };
    files.set("attempt-reports.json", new Map<string, unknown>([["queue", [old]]]));
    publicRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify.", noResponse: true });
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "CONTROL_PLANE_UNREACHABLE", reason: "r" });

    const store = files.get("attempt-reports.json")!;
    expect(store.get("queue")).toBeUndefined();
    expect((store.get("reports") as unknown[]).length).toBe(2);
  });
});

describe("a report only a page answered", () => {
  const queued = () => (files.get("attempt-reports.json")?.get("reports") as Record<string, unknown>[] | undefined) ?? [];
  const unreachable = { kind: "CONNECT" as const, outcome: "CONTROL_PLANE_UNREACHABLE" as const, reason: "r" };

  beforeEach(() => invoke.mockResolvedValue("windows"));

  /** During an outage every address answers with a page: the CDN's 521,
   * a mirror's 502, a bot check's 403. Before: a page with a status
   * counted as delivered, and every queued unreachable report -- the ones
   * this queue exists for -- was dropped unseen. */
  it("is kept when a gateway's page or a bot check answered it", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Request failed (502)", status: 502 });
    await attempts.reportAttempt(unreachable);
    expect(queued()).toHaveLength(1);

    publicRequest.mockReset();
    publicRequest.mockResolvedValue({ ok: false, error: "Request failed (403)", status: 403 });
    await attempts.flushAttempts();
    expect(queued()).toHaveLength(1);
  });

  /** One that will never let a report through is not held for its
   * fourteen days: a flush stops at the first report it keeps. */
  it("is not kept for a page that will never take it, nor for the backend's own refusal", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Request failed (404)", status: 404 });
    await attempts.reportAttempt(unreachable);
    expect(queued()).toHaveLength(0);

    publicRequest.mockResolvedValue({ ok: false, error: "Internal server error", status: 500 });
    await attempts.reportAttempt(unreachable);
    expect(queued()).toHaveLength(0);
  });
});
