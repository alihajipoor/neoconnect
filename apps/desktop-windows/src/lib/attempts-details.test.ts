import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** What the fuller reports put on the wire (docs/client-diagnostics.md):
 * details beside the report, each rung's time, and the one resend without
 * them when a server refuses them -- so a validator mismatch never loses
 * the basic report. */

const files = new Map<string, Map<string, unknown>>();
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    let data = files.get(name);
    if (!data) files.set(name, (data = new Map<string, unknown>()));
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
vi.mock("./session", () => ({ getTokens: async () => null }));
vi.mock("./network-identity", () => ({ currentAttestation: () => "attested", currentClientIp: () => null }));

type Attempts = typeof import("./attempts");
let attempts: Attempts;

function sentBodies(): Record<string, unknown>[] {
  return publicRequest.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

const refused: ApiResult<void> = { ok: false, error: "Request failed (400)", status: 400 };


beforeEach(async () => {
  for (const data of files.values()) data.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd) => {
    if (cmd === "build_platform") return "windows";
    if (cmd === "device_facts") return { os: "Windows", osVersion: "11 26100.2314", net: { type: "ethernet" } };
    throw new Error(`no ${cmd}`);
  });
  publicRequest.mockReset();
  publicRequest.mockResolvedValue({ ok: true, data: undefined });
  vi.resetModules();
  attempts = await import("./attempts");
});

describe("a report's details", () => {
  it("go with CONNECT, SIGN_IN, REGISTER and SESSION reports", async () => {
    for (const kind of ["CONNECT", "SIGN_IN", "REGISTER", "SESSION"] as const) {
      await attempts.reportAttempt({ kind, outcome: "SUCCESS" });
    }
    for (const body of sentBodies()) {
      expect(body.details).toMatchObject({ device: { os: "Windows" }, net: { type: "ethernet" } });
    }
  });

  it("carry the caller's own part, held to the server's bounds", async () => {
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "OTHER", details: { errorKind: "x".repeat(99) } });
    expect((sentBodies()[0].details as { errorKind: string }).errorKind).toHaveLength(40);
  });

  it("are left out when nothing is known", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "build_platform" ? "linux" : Promise.reject(new Error("no command"))));
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(sentBodies()[0]).not.toHaveProperty("details");
  });
});

describe("on a phone, before the disclosure has been accepted", () => {
  beforeEach(async () => {
    // The phone app sets its disclosure as the source; the desktop has none
    // and sends from the first run (diagnostics-consent.ts).
    (await import("./diagnostics-consent")).setDiagnosticsConsentSource(async () => false);
  });

  it("a report goes as it always did: no details, no rung times", async () => {
    await attempts.reportAttempt({
      kind: "SIGN_IN",
      outcome: "REJECTED",
      details: { errorKind: "badPassword" },
      attempts: [{ protocol: "Stealth", result: "refused", ms: 900 }],
    });
    const [body] = sentBodies();
    expect(body).not.toHaveProperty("details");
    expect((body.attempts as object[])[0]).toEqual({ protocol: "Stealth", result: "refused" });
  });

  it("a service check is not sent at all", async () => {
    await attempts.reportAttempt({ kind: "SERVICE_CHECK", outcome: "SUCCESS", details: { via: "direct" } });
    expect(publicRequest).not.toHaveBeenCalled();
  });

  it("a source that throws is not a yes", async () => {
    (await import("./diagnostics-consent")).setDiagnosticsConsentSource(() => Promise.reject(new Error("no store")));
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "SUCCESS" });
    expect(sentBodies()[0]).not.toHaveProperty("details");
  });

  it("an end-of-session report is not sent at all: its reason alone says how long the session ran", async () => {
    await attempts.reportAttempt({
      kind: "SESSION",
      outcome: "OTHER",
      reason: "session ended (disconnected) after 187 s; not an attempt",
      details: { sessionEnd: { cause: "disconnected", seconds: 187 } },
    });
    expect(publicRequest).not.toHaveBeenCalled();
  });
});

describe("a session report on a network that could not be attested", () => {
  // Seen on the emulator: a three-minute session ended with no report,
  // because every SESSION report was held back without an attestation.
  it("the end-of-session report still goes: it is about this customer's session, not a network", () => {
    const end = {
      kind: "SESSION" as const,
      outcome: "OTHER" as const,
      details: { sessionEnd: { cause: "disconnected" as const, seconds: 187 } },
    };
    const shaped = attempts.withNetwork(end, null, null);
    expect(shaped).not.toBeNull();
    expect(shaped).not.toHaveProperty("network");
    expect(shaped?.details).toEqual(end.details);
  });

  it("the ten-minute report still does not: it is per-network evidence", () => {
    expect(attempts.withNetwork({ kind: "SESSION", outcome: "SUCCESS", sessionSeconds: 700 }, null, null)).toBeNull();
  });
});

describe("a service check that cannot be delivered", () => {
  it("is not queued, so it never pushes a connect failure out of the queue", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify", noResponse: true } as ApiResult<void>);
    await attempts.reportAttempt({ kind: "CONNECT", outcome: "REJECTED" });
    await attempts.reportAttempt({ kind: "SERVICE_CHECK", outcome: "OTHER", details: { via: "direct" } });
    const queued = (files.get("attempt-reports.json")?.get("reports") ?? []) as { kind: string }[];
    expect(queued.map((r) => r.kind)).toEqual(["CONNECT"]);
  });
});

describe("a server that refuses the details", () => {
  it("is sent the report once more without them, and the rungs' times", async () => {
    publicRequest.mockResolvedValueOnce(refused);
    await attempts.reportAttempt({
      kind: "CONNECT",
      outcome: "SUCCESS",
      attempts: [{ protocol: "Stealth", result: "connected", ms: 1200 }],
    });
    const [first, second] = sentBodies();
    expect(first.details).toBeDefined();
    expect((first.attempts as { ms?: number }[])[0].ms).toBe(1200);
    expect(second).not.toHaveProperty("details");
    expect((second.attempts as { ms?: number }[])[0]).toEqual({ protocol: "Stealth", result: "connected" });
    expect(publicRequest).toHaveBeenCalledTimes(2);
  });

  it("is not asked twice: a second refusal counts as delivered, as before", async () => {
    publicRequest.mockResolvedValue(refused);
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(publicRequest).toHaveBeenCalledTimes(2);
    expect(files.get("attempt-reports.json")?.get("reports")).toBeUndefined();
  });

  it("never sees a resend for a report that carries neither", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "build_platform" ? "windows" : Promise.reject(new Error("no"))));
    publicRequest.mockResolvedValue(refused);
    await attempts.reportAttempt({ kind: "SIGN_IN", outcome: "SUCCESS" });
    expect(publicRequest).toHaveBeenCalledTimes(1);
  });
});

describe("each rung's time", () => {
  it("goes out by index beside the dials, within the server's bound", () => {
    expect(
      attempts.rungsFrom(
        ["Fast: up but unreachable", "Built-in: not available", "Stealth: connected"],
        [{ routeId: "r1", carried: false }, null, { routeId: "r2", carried: true }],
        [5400.4, 0, 9_999_999],
      ),
    ).toEqual([
      { protocol: "Fast", result: "up but unreachable", routeId: "r1", carried: false, ms: 5400 },
      { protocol: "Built-in", result: "not available", ms: 0 },
      { protocol: "Stealth", result: "connected", routeId: "r2", carried: true, ms: 600_000 },
    ]);
  });

  it("is left off a rung that has none", () => {
    expect(attempts.rungsFrom(["Fast: refused"], [], [])).toEqual([{ protocol: "Fast", result: "refused" }]);
  });

  it("is measured from the rung's start to its line, and follows a line taken back", () => {
    let clock = 0;
    const rungs = attempts.timedRungs(() => clock);
    rungs.start();
    clock = 700;
    rungs.lines.push("Fast: refused");
    rungs.start();
    clock = 1_000;
    rungs.lines.push("Stealth: up but slow");
    // Taken back and dialled again from its start.
    rungs.lines.pop();
    rungs.start();
    clock = 1_250;
    rungs.lines.push("Stealth: up but unreachable");
    expect(rungs.ms.slice(0, rungs.lines.length)).toEqual([700, 250]);
    // A fresh start of the pass.
    rungs.lines.length = 0;
    rungs.start();
    clock = 1_400;
    expect(rungs.landed()).toEqual([150]);
    expect(attempts.rungsFrom([...rungs.lines, "Stealth: connected"], [], rungs.landed())).toEqual([
      { protocol: "Stealth", result: "connected", ms: 150 },
    ]);
  });
});
