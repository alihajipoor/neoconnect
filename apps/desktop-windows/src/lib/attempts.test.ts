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
