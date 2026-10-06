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
      save: async () => undefined,
    };
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("9.9.9") }));

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const publicRequest = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<void>>>();
vi.mock("./api", () => ({ publicRequest: (path: string, init?: RequestInit) => publicRequest(path, init) }));
vi.mock("./session", () => ({ getTokens: async () => null }));
vi.mock("./network-identity", () => ({ currentAttestation: () => null }));

type Attempts = typeof import("./attempts");
let attempts: Attempts;

/** Each body that was posted, parsed. */
function sentBodies(): Record<string, unknown>[] {
  return publicRequest.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

beforeEach(async () => {
  for (const data of files.values()) data.clear();
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

/** The field that lost every report it was on: a server limit of 200,
 * a list of 233, a 400 the client counted as delivered. */
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
    expect(String(bodies[1].apiEndpoint).endsWith("[cut]")).toBe(true);
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
