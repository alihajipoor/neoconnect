import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceEntry } from "./endpoint-trace";

/** Which addresses get probed, and how the Rust side's answer is turned
 * into the report's `probe:` section. The command itself is stood in for
 * here; its classification has its own tests in control_plane_probe.rs.
 * Names are RFC 2606 stand-ins. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const { CONNECT_QUIET_MS, connectStarting, probeAddendum, probeControlPlane, probeTargets, resetProbeForTests } =
  await import("./control-plane-probe");
const { demotedLast, resetDemotionsForTests } = await import("./endpoint-demotion");

const entry = (base: string, outcome: TraceEntry["outcome"]): TraceEntry => ({
  phase: "req",
  base,
  startedAt: 0,
  outcome,
});

beforeEach(() => {
  invoke.mockReset();
  resetProbeForTests();
  resetDemotionsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a probe of what this machine refused", () => {
  /** Refused on this PC, so a probe would only measure the filter that
   * refused it, and report it as the network's doing. */
  it("does not probe an address refused locally", () => {
    expect(probeTargets([entry("https://a.example.net/api", "local")])).toEqual([]);
  });

  /** The Rust side's own class for the same refusal at the TCP stage, passed
   * on rather than turned into "?". */
  it("passes the probe's local refusal on as its own class", async () => {
    invoke.mockResolvedValueOnce([{ outcome: "local", ms: 3 }]);
    const section = await probeControlPlane([entry("https://a.example.net/api", "net")], 0);
    expect(section).toBe("probe: a.example.net=local@3");
  });
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

  /** Iran's DNS block page for a name: every address under it goes to
   * the back of the next race's order, whatever its port, because the
   * resolver's answer is for the name -- here including one this request
   * never tried. Before: it was reported and nothing else, and every race
   * asked it again. */
  it("demotes every address under a name that resolved into the block page", async () => {
    invoke.mockResolvedValue([
      { outcome: "blockpage", ms: 12 },
      { outcome: "tls", ms: 312 },
      { outcome: "tcp-timeout", ms: 4001 },
    ]);
    const tried = [
      entry("https://a.example.net/api", "net"),
      entry("https://b.example.net:2053/api", "net"),
      entry("https://c.example.net/api", "timeout"),
    ];
    expect(await probeControlPlane(tried, 0)).toBe(
      "probe: a.example.net=blockpage@12 b.example.net:2053=tls@312 c.example.net=tcp-timeout@4001",
    );

    const list = [
      "https://a.example.net/api",
      "https://a.example.net:2053/api",
      "https://b.example.net:2053/api",
      "https://d.example.net/api",
    ];
    expect(demotedLast(list).ordered).toEqual([
      "https://b.example.net:2053/api",
      "https://d.example.net/api",
      "https://a.example.net/api",
      "https://a.example.net:2053/api",
    ]);
  });

  /** A name the app reaches through a proxy is not probed (Rust's
   * `probe_unless_proxied`): the report says so, and nothing is demoted.
   * Before, the probe asked this machine's resolver, found the block page,
   * and every race after it held back a name the proxy reached. */
  it("says a proxy was in the way, and demotes nothing for it", async () => {
    invoke.mockResolvedValue([
      { outcome: "proxy", ms: 0 },
      { outcome: "proxy", ms: 0 },
    ]);
    const tried = [entry("https://a.example.net/api", "net"), entry("https://b.example.net:2053/api", "timeout")];
    expect(await probeControlPlane(tried, 0)).toBe("probe: a.example.net=proxy@0 b.example.net:2053=proxy@0");
    const list = ["https://a.example.net/api", "https://b.example.net:2053/api", "https://d.example.net/api"];
    expect(demotedLast(list).ordered).toEqual(list);
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

/** The probe as it follows a report that has already been made. */
describe("probeAddendum", () => {
  const failed = [entry("https://a.example.net/api", "timeout"), entry("https://b.example.net:2053/api", "net")];
  const answer = [
    { outcome: "tcp-timeout", ms: 4001 },
    { outcome: "tls", ms: 312 },
  ];
  const SECTION = "probe: a.example.net=tcp-timeout@4001 b.example.net:2053=tls@312";

  it("carries the probe's section for the report's apiEndpoint", async () => {
    invoke.mockResolvedValue(answer);
    expect(await probeAddendum(failed)).toEqual({ apiEndpoint: SECTION });
  });

  it("is nothing when nothing was probed", async () => {
    expect(await probeAddendum([entry("https://a.example.net/api", "h200")])).toBeUndefined();
  });

  /** iOS suspends a backgrounded app, probe threads and all; a timeout
   * then measured the suspension. The addendum says so. */
  it("says when the app went to the background while it ran", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    Object.assign(globalThis, { document: doc });
    try {
      invoke.mockImplementation(async () => {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
        return answer;
      });
      expect(await probeAddendum(failed)).toEqual({
        apiEndpoint: SECTION,
        reason: "app was in the background during the probe",
      });
    } finally {
      Object.assign(globalThis, { document: undefined });
    }
  });

  /** Every address refused by this PC (os error 10013), which the probe
   * alone can tell: the HTTP plugin's errors carry no cause, so the
   * request itself is traced `net` and the report is filed as
   * CONTROL_PLANE_UNREACHABLE -- an outcome the panel reads as a filtered
   * address. The report's reason now says it was this machine. */
  it("says when this PC refused every address, which the outcome cannot", async () => {
    invoke.mockResolvedValue([
      { outcome: "local", ms: 2 },
      { outcome: "local", ms: 3 },
    ]);
    expect(await probeAddendum(failed)).toEqual({
      apiEndpoint: "probe: a.example.net=local@2 b.example.net:2053=local@3",
      reason: LOCAL_REASON,
    });
  });

  /** One refused here and one by the network is the network's answer
   * still, and is left to the section to tell. */
  it("says nothing more when only some were refused here", async () => {
    invoke.mockResolvedValue([
      { outcome: "local", ms: 2 },
      { outcome: "tcp-timeout", ms: 4001 },
    ]);
    expect(await probeAddendum(failed)).toEqual({
      apiEndpoint: "probe: a.example.net=local@2 b.example.net:2053=tcp-timeout@4001",
    });
  });
});

const LOCAL_REASON =
  "every address probed was refused by a filter on this PC (os error 10013), not by the network";

const REFILED_REASON =
  "refused by this device, not by the network: every attempt failed within 50ms and the probe's connect " +
  "was refused here (permission denied: os error 10013 on Windows); filed as OTHER, not CONTROL_PLANE_UNREACHABLE";

/** A request this machine refused, through the HTTP plugin.
 *
 * The plugin's error drops the OS error, so the request is traced `net`
 * and the report would go out as CONTROL_PLANE_UNREACHABLE -- "the
 * signature of a filtered address" on the panel -- for a request that
 * never left the PC: a firewall here, or one of this app's own filters.
 * A local refusal fails at once; the probe, which connects by itself,
 * sees the permission error. When both say so, the report is filed as
 * OTHER with the reason, which is the outcome the panel reads off the
 * row. */
describe("a request refused on this machine", () => {
  /** Failed in transport, `ms` after it started. */
  const failedIn = (base: string, ms: number): TraceEntry => ({
    phase: "req",
    base,
    startedAt: 1_000,
    settledAt: 1_000 + ms,
    outcome: "net",
  });
  const atOnce = [failedIn("https://a.example.net/api", 3), failedIn("https://b.example.net:2053/api", 4)];

  it("is filed as OTHER when every attempt failed at once and the probe was refused here", async () => {
    invoke.mockResolvedValue([
      { outcome: "local", ms: 2 },
      { outcome: "local", ms: 3 },
    ]);
    expect(await probeAddendum(atOnce)).toEqual({
      apiEndpoint: "probe: a.example.net=local@2 b.example.net:2053=local@3",
      reason: REFILED_REASON,
      outcome: "OTHER",
    });
  });

  /** A reset from the network can be as quick; the probe tells them apart. */
  it("keeps its outcome when the probe says the network refused it", async () => {
    invoke.mockResolvedValue([
      { outcome: "tcp", ms: 30 },
      { outcome: "tcp", ms: 31 },
    ]);
    expect(await probeAddendum(atOnce)).toEqual({
      apiEndpoint: "probe: a.example.net=tcp@30 b.example.net:2053=tcp@31",
    });
  });

  /** The probe says this PC refuses now; attempts that took their time
   * were not that, or not only that. The reason says what the probe saw,
   * and the outcome stays. */
  it("keeps its outcome when the attempts did not fail at once", async () => {
    invoke.mockResolvedValue([
      { outcome: "local", ms: 2 },
      { outcome: "local", ms: 3 },
    ]);
    const slowly = [failedIn("https://a.example.net/api", 3), failedIn("https://b.example.net:2053/api", 400)];
    expect(await probeAddendum(slowly)).toEqual({
      apiEndpoint: "probe: a.example.net=local@2 b.example.net:2053=local@3",
      reason: LOCAL_REASON,
    });
  });

  /** One answered, so the report is not an unreachable one to refile. */
  it("keeps its outcome when anything else is in the trace", async () => {
    invoke.mockResolvedValue([{ outcome: "local", ms: 2 }]);
    const mixed = [failedIn("https://a.example.net/api", 3), { ...failedIn("https://b.example.net/api", 3), outcome: "h502" as const }];
    expect((await probeAddendum(mixed))?.outcome).toBeUndefined();
  });

  /** The ten-minute interval is for probes of a blocked network, every
   * address a lookup, a handshake and a ClientHello. A request refused at
   * once is checked anyway, at one address, and that check does not spend
   * the interval. */
  it("is checked at one address within the ten-minute interval, which it does not spend", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    invoke.mockResolvedValue([{ outcome: "dns", ms: 40 }]);
    expect(await probeAddendum([entry("https://c.example.net/api", "timeout")])).toEqual({
      apiEndpoint: "probe: c.example.net=dns@40",
    });

    vi.setSystemTime(10_000_000 + 60_000);
    invoke.mockReset();
    invoke.mockResolvedValue([{ outcome: "local", ms: 2 }]);
    expect(await probeAddendum(atOnce)).toEqual({
      apiEndpoint: "probe: a.example.net=local@2",
      reason: REFILED_REASON,
      outcome: "OTHER",
    });
    expect(invoke).toHaveBeenCalledWith("probe_control_plane", { targets: [{ host: "a.example.net", port: 443 }] });

    // The interval still runs from the first probe.
    vi.setSystemTime(10_000_000 + 9 * 60_000);
    invoke.mockReset();
    expect(await probeAddendum([entry("https://c.example.net/api", "timeout")])).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  /** A connect may be putting up filters of its own: what the probe sees
   * then is not what the request met. */
  it("is not checked across a connect", async () => {
    connectStarting();
    expect(await probeAddendum(atOnce)).toEqual({ apiEndpoint: "probe: skipped=connect" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

/** A connect changes the path a probe measures, and resume -- when a
 * failed resume refresh probes -- is exactly when people press Connect. */
describe("a probe and a connect", () => {
  const failed = [entry("https://a.example.net/api", "timeout")];
  const answer = [{ outcome: "dns", ms: 40 }];
  const SECTION = "probe: a.example.net=dns@40";

  it("is not begun while the screen shows the path changing, and says so", async () => {
    expect(await probeControlPlane(failed, 0, { pathChanging: true })).toBe("probe: skipped=connect");
    expect(invoke).not.toHaveBeenCalled();
    // Nothing was learned, so the interval is not spent.
    invoke.mockResolvedValue(answer);
    expect(await probeControlPlane(failed, 1)).toBe(SECTION);
  });

  /** The mobile app shows "connecting" only once its pre-connect refresh
   * is over; this covers the seconds before. */
  it("is not begun within a minute of a connect starting", async () => {
    connectStarting(0);
    expect(await probeControlPlane(failed, CONNECT_QUIET_MS - 1)).toBe("probe: skipped=connect");
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue(answer);
    expect(await probeControlPlane(failed, CONNECT_QUIET_MS)).toBe(SECTION);
  });

  it("is abandoned, and told to stop, when a connect starts while it runs", async () => {
    invoke.mockImplementation((cmd) => (cmd === "probe_control_plane" ? new Promise(() => undefined) : Promise.resolve()));
    const pending = probeControlPlane(failed, 0);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("probe_control_plane", expect.anything()));

    connectStarting();

    expect(await pending).toMatch(/^probe: abandoned=connect@\d+$/);
    expect(invoke).toHaveBeenCalledWith("cancel_control_plane_probe", undefined);
    // Abandoned, it taught nothing: once the connect is past, the next
    // failure may probe without waiting out the interval.
    invoke.mockReset();
    invoke.mockResolvedValue(answer);
    expect(await probeControlPlane(failed, Date.now() + CONNECT_QUIET_MS)).toBe(SECTION);
  });

  it("is left alone by a connect that starts after it answered", async () => {
    invoke.mockResolvedValue(answer);
    expect(await probeControlPlane(failed, 0)).toBe(SECTION);
    connectStarting();
    expect(invoke).not.toHaveBeenCalledWith("cancel_control_plane_probe", undefined);
  });

  /** No note for a probe that would not have run anyway. */
  it("says nothing when there was nothing to probe", async () => {
    connectStarting(0);
    expect(await probeControlPlane([entry("https://a.example.net/api", "h200")], 1)).toBeUndefined();
    expect(await probeControlPlane(failed, 1, { pathChanging: false })).toBe("probe: skipped=connect");
    invoke.mockResolvedValue(answer);
    expect(await probeControlPlane(failed, CONNECT_QUIET_MS)).toBe(SECTION);
    // Within the interval now: nothing would run, so nothing is said.
    connectStarting(CONNECT_QUIET_MS + 1);
    expect(await probeControlPlane(failed, CONNECT_QUIET_MS + 2)).toBeUndefined();
  });

  /** A skipped or abandoned probe measured nothing, so nothing of it can
   * have been distorted by a suspension. */
  it("as an addendum, carries the note and no background flag", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    Object.assign(globalThis, { document: doc });
    try {
      expect(await probeAddendum(failed, { pathChanging: true })).toEqual({ apiEndpoint: "probe: skipped=connect" });
    } finally {
      Object.assign(globalThis, { document: undefined });
    }
  });
});
