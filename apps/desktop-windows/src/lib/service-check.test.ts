import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The service check (service-check.ts): when it runs by itself, how much
 * it runs at once and for how long, that it probes and reports only what
 * the server listed, and which way the customer's own run went. */

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

type Probe = { host: string; path: string; timeoutMs: number };
const probes: Probe[] = [];
let probeAnswer: (p: Probe) => Promise<unknown> = async () => ({ ok: true, stage: "ok", status: 200, tlsMs: 20 });
let status: unknown = { connected: true };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (cmd === "probe_service") {
      probes.push(args as Probe);
      return probeAnswer(args as Probe);
    }
    if (cmd === "vpn_status") return status;
    throw new Error(`no ${cmd}`);
  },
}));

const apiRequest = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock("./api", () => ({ apiRequest: (path: string, init?: RequestInit) => apiRequest(path, init) }));

const reportAttempt = vi.fn<(r: unknown) => Promise<void>>(async () => undefined);
vi.mock("./attempts", () => ({ reportAttempt: (r: unknown) => reportAttempt(r) }));

const lastReport = () => reportAttempt.mock.calls[reportAttempt.mock.calls.length - 1];

type Check = typeof import("./service-check");
let sc: Check;

const target = (key: string) => ({ key, label: key.toUpperCase(), host: `${key}.example.com`, path: "/" });
const LIST = { enabled: true, version: 3, everyHours: 24, targets: ["a", "b", "c", "d"].map(target) };

beforeEach(async () => {
  for (const data of files.values()) data.clear();
  probes.length = 0;
  probeAnswer = async () => ({ ok: true, stage: "ok", status: 200, tlsMs: 20 });
  status = { connected: true };
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ ok: true, data: LIST });
  reportAttempt.mockClear();
  vi.resetModules();
  sc = await import("./service-check");
  sc.resetServiceCheckForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

const run = (over: Partial<Parameters<Check["runScheduledServiceCheck"]>[0]> = {}) =>
  sc.runScheduledServiceCheck({
    routeId: "route-1",
    protocol: "Stealth",
    fullTunnel: true,
    stillUp: () => true,
    foreground: () => true,
    ...over,
  });

describe("the automatic run", () => {
  it("probes the listed targets through the tunnel and files one SERVICE_CHECK", async () => {
    expect(await run()).toBe(true);
    expect(probes.map((p) => p.host)).toEqual(["a.example.com", "b.example.com", "c.example.com", "d.example.com"]);
    expect(reportAttempt).toHaveBeenCalledTimes(1);
    const report = reportAttempt.mock.calls[0][0] as { kind: string; outcome: string; routeId: string; protocol: string; details: { via: string; targetsVersion: number; services: { key: string; host: string }[] } };
    expect(report).toMatchObject({ kind: "SERVICE_CHECK", outcome: "SUCCESS", routeId: "route-1", protocol: "Stealth" });
    expect(report.details.via).toBe("tunnel");
    expect(report.details.targetsVersion).toBe(3);
    expect(report.details.services.map((s) => [s.key, s.host])).toEqual(LIST.targets.map((t) => [t.key, t.host]));
  });

  it("is OTHER when any target was not reachable", async () => {
    probeAnswer = async (p) => (p.host.startsWith("b.") ? { ok: false, stage: "tls", error: "handshake failed" } : { ok: true, stage: "ok" });
    await run();
    expect(reportAttempt.mock.calls[0][0]).toMatchObject({ outcome: "OTHER" });
  });

  it("never runs when the server has it off", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { ...LIST, enabled: false } });
    expect(await run()).toBe(false);
    expect(probes).toEqual([]);
  });

  it("runs at most once per everyHours per route, and on another route at once", async () => {
    await run();
    expect(await run()).toBe(false);
    expect(reportAttempt).toHaveBeenCalledTimes(1);
    expect(await run({ routeId: "route-2" })).toBe(true);
    expect(reportAttempt).toHaveBeenCalledTimes(2);
  });

  it("asks the server for the list once a day", async () => {
    await run();
    await run({ routeId: "route-2" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith("/customer/service-checks/targets", undefined);
  });

  it("runs again for a route once everyHours has passed", async () => {
    let clock = 10_000_000;
    await run({ now: () => clock });
    clock += 24 * 3_600_000 + 1;
    // The list is a day old too: asked again.
    expect(await run({ now: () => clock })).toBe(true);
    expect(reportAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not run in the background", async () => {
    expect(await run({ foreground: () => false })).toBe(false);
    expect(probes).toEqual([]);
  });

  it("does not run when the app's own traffic bypasses the tunnel (Custom mode)", async () => {
    expect(await run({ fullTunnel: false })).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("does not run when the tunnel is already gone", async () => {
    expect(await run({ stillUp: () => false })).toBe(false);
    expect(probes).toEqual([]);
  });

  it("stops quietly when a disconnect starts, and reports nothing", async () => {
    let up = true;
    probeAnswer = async () => {
      up = false;
      return { ok: true, stage: "ok" };
    };
    expect(await run({ stillUp: () => up })).toBe(false);
    expect(probes.length).toBeLessThanOrEqual(3);
    expect(reportAttempt).not.toHaveBeenCalled();
    // Not counted as run: the next connect tries again.
    up = true;
    probeAnswer = async () => ({ ok: true, stage: "ok" });
    expect(await run()).toBe(true);
  });

  it("probes only what the server listed, under the list's own key and host", async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      data: {
        ...LIST,
        targets: [
          target("a"),
          { key: "ip", label: "IP", host: "192.0.2.1", path: "/" },
          { key: "port", label: "P", host: "example.com:8443", path: "/" },
          { key: "path", label: "P", host: "p.example.com", path: "no-slash" },
          { key: "scheme", label: "S", host: "https://s.example.com", path: "/" },
        ],
      },
    });
    probeAnswer = async () => ({ ok: true, stage: "ok", key: "other", host: "elsewhere.example.net" });
    await run();
    expect(probes.map((p) => p.host)).toEqual(["a.example.com"]);
    const report = reportAttempt.mock.calls[0][0] as { details: { services: { key: string; host: string }[] } };
    expect(report.details.services).toEqual([{ key: "a", host: "a.example.com", ok: true, stage: "ok" }]);
  });
});

describe("the run's limits", () => {
  it("runs at most three at once", async () => {
    let inFlight = 0;
    let most = 0;
    probeAnswer = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, stage: "ok" };
    };
    const result = await sc.runTargets(["a", "b", "c", "d", "e", "f", "g"].map(target), () => false);
    expect(most).toBe(sc.CONCURRENCY);
    expect(result?.services).toHaveLength(7);
    expect(result?.complete).toBe(true);
  });

  it("gives each target 8 s and the whole run 25 s, leaving out what did not finish", async () => {
    vi.useFakeTimers();
    // Every probe hangs past its own time: the JS guard gives up on each.
    probeAnswer = () => new Promise(() => undefined);
    const pending = sc.runTargets("abcdefghijkl".split("").map(target), () => false);
    await vi.advanceTimersByTimeAsync(sc.RUN_MS + 1_000);
    const result = await pending;
    // Three waves of three fit in 25 s, the last given only what is left;
    // the other three never began.
    expect(probes.map((p) => p.timeoutMs)).toEqual([8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 7_000, 7_000, 7_000]);
    expect(result).toEqual({ services: [], complete: false });
  });

  it("is a partial run, not a success, when the budget ran out", async () => {
    vi.useFakeTimers();
    probeAnswer = async (p) => (p.host.startsWith("a.") ? { ok: true, stage: "ok" } : new Promise(() => undefined));
    const pending = sc.runTargets(["a", "b", "c", "d"].map(target), () => false);
    await vi.advanceTimersByTimeAsync(sc.RUN_MS + 1_000);
    const result = await pending;
    expect(result?.services.map((s) => s.key)).toEqual(["a"]);
    expect(result?.complete).toBe(false);
  });
});

describe("the customer's own run", () => {
  it("goes through the tunnel when the last connect here landed on a full tunnel that is up", async () => {
    await run({ foreground: () => false });
    const answer = await sc.runServiceCheckNow();
    expect(answer).toMatchObject({ kind: "done", via: "tunnel", listed: 4, complete: true });
    expect(lastReport()?.[0]).toMatchObject({ routeId: "route-1", details: { via: "tunnel" } });
  });

  it("goes directly when nothing is up", async () => {
    status = { connected: false };
    const answer = await sc.runServiceCheckNow();
    expect(answer).toMatchObject({ kind: "done", via: "direct" });
    expect(lastReport()?.[0]).not.toHaveProperty("routeId");
  });

  it("goes directly in Custom mode, where the app's own traffic bypasses the tunnel", async () => {
    status = { connected: true, splitTunnelActive: true };
    expect(await sc.runServiceCheckNow()).toMatchObject({ via: "direct" });
  });

  it("says neither when a tunnel is up that this run of the app did not bring up", async () => {
    const answer = await sc.runServiceCheckNow();
    expect(answer).toMatchObject({ kind: "done", via: undefined });
    expect((lastReport()?.[0] as { details: object }).details).not.toHaveProperty("via");
  });

  it("names each result by its label", async () => {
    status = { connected: false };
    const answer = await sc.runServiceCheckNow();
    expect(answer.kind === "done" && answer.results.map((r) => r.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("says when the check is off, and when the list could not be had", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { ...LIST, enabled: false } });
    expect(await sc.runServiceCheckNow()).toEqual({ kind: "off" });
    for (const data of files.values()) data.clear();
    apiRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify" });
    expect(await sc.runServiceCheckNow()).toEqual({ kind: "unavailable" });
    expect(probes).toEqual([]);
  });
});

describe("a build without the probe", () => {
  it("says the test could not start rather than that nothing was reachable", async () => {
    probeAnswer = () => Promise.reject(new Error("command probe_service not found"));
    status = { connected: false };
    expect(await sc.runServiceCheckNow()).toEqual({ kind: "unavailable" });
    expect(reportAttempt).not.toHaveBeenCalled();
    expect(await run()).toBe(false);
    expect(reportAttempt).not.toHaveBeenCalled();
  });
});
