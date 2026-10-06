import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceEntry } from "./endpoint-trace";

/** Which addresses get probed, and how the Rust side's answer is turned
 * into the report's `probe:` section. The command itself is stood in for
 * here; its classification has its own tests in control_plane_probe.rs.
 * Names are RFC 2606 stand-ins. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { probeControlPlane, probeTargets, resetProbeForTests } = await import("./control-plane-probe");

const entry = (base: string, outcome: TraceEntry["outcome"]): TraceEntry => ({
  phase: "req",
  base,
  startedAt: 0,
  outcome,
});

beforeEach(() => {
  invoke.mockReset();
  resetProbeForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("probeTargets", () => {
  /** Only what failed without an answer. An HTTP status means reachable;
   * a scope refusal never left the device; a cancelled one lost a race
   * it was not losing on its own. */
  it("probes each address that failed without an answer, once", () => {
    const targets = probeTargets([
      entry("https://a.example.net/api", "timeout"),
      entry("https://b.example.net:2053/api", "net"),
      entry("https://c.example.net/api", "pending"),
      entry("https://d.example.net/api", "h401"),
      entry("https://e.example.net/api", "scope"),
      entry("https://f.example.net/api", "cancel"),
      entry("https://a.example.net/api", "net"),
    ]);
    expect(targets).toEqual([
      { host: "a.example.net", port: 443, label: "a.example.net" },
      { host: "b.example.net", port: 2053, label: "b.example.net:2053" },
      { host: "c.example.net", port: 443, label: "c.example.net" },
    ]);
  });

  /** Same hostname, different port: a different path, probed separately. */
  it("keeps a mirror's ports apart", () => {
    const targets = probeTargets([
      entry("https://a.example.net/api", "net"),
      entry("https://a.example.net:2053/api", "net"),
    ]);
    expect(targets.map((t) => t.label)).toEqual(["a.example.net", "a.example.net:2053"]);
  });

  /** A TLS handshake to a plain-HTTP dev server would only ever fail. */
  it("skips what is not HTTPS", () => {
    expect(probeTargets([entry("http://localhost:4000", "net")])).toEqual([]);
  });

  it("asks about sixteen at most", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`https://m${i}.example.net/api`, "timeout"));
    expect(probeTargets(many)).toHaveLength(16);
  });
});

describe("probeControlPlane", () => {
  const failed = [entry("https://a.example.net/api", "timeout"), entry("https://b.example.net:2053/api", "net")];

  it("asks the Rust side and renders its answer in order", async () => {
    invoke.mockResolvedValue([
      { outcome: "dns", ms: 41 },
      { outcome: "tls", ms: 312 },
    ]);
    expect(await probeControlPlane(failed, 0)).toBe("probe: a.example.net=dns@41 b.example.net:2053=tls@312");
    expect(invoke).toHaveBeenCalledWith("probe_control_plane", {
      targets: [
        { host: "a.example.net", port: 443 },
        { host: "b.example.net", port: 2053 },
      ],
    });
  });

  /** A resume refresh fails on every foreground on a blocked network;
   * the answer will not have changed in ten minutes. */
  it("probes at most once in ten minutes", async () => {
    invoke.mockResolvedValue([
      { outcome: "dns", ms: 1 },
      { outcome: "dns", ms: 1 },
    ]);
    expect(await probeControlPlane(failed, 0)).toBeDefined();
    expect(await probeControlPlane(failed, 9 * 60_000)).toBeUndefined();
    expect(await probeControlPlane(failed, 10 * 60_000)).toBeDefined();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not ask when nothing failed in a way worth probing", async () => {
    expect(await probeControlPlane([entry("https://a.example.net/api", "h200")], 0)).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  /** A shell without the command -- the macOS app -- reports without it. */
  it("says nothing when the command is not there", async () => {
    invoke.mockRejectedValue("command probe_control_plane not found");
    expect(await probeControlPlane(failed, 0)).toBeUndefined();
  });

  it("passes on only the classes it knows, and never a malformed answer", async () => {
    invoke.mockResolvedValue([
      { outcome: "something new", ms: 5 },
      { outcome: "tcp-timeout", ms: "soon" },
    ]);
    expect(await probeControlPlane(failed, 0)).toBe("probe: a.example.net=?@5 b.example.net:2053=tcp-timeout@0");

    resetProbeForTests();
    invoke.mockResolvedValue([{ outcome: "ok", ms: 1 }]);
    expect(await probeControlPlane(failed, 0)).toBeUndefined();
  });

  /** It decorates a report; it must not hold one up indefinitely. */
  it("gives up on a command that never answers", async () => {
    vi.useFakeTimers();
    invoke.mockReturnValue(new Promise(() => undefined));
    const pending = probeControlPlane(failed, 0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBeUndefined();
  });
});
