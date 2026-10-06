import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";
import { beginAttempt, settleAttempt, type EndpointTrace } from "./endpoint-trace";
import type { ProtocolUser } from "./types";

/** The disk cache, stood in for. `credential-cache.ts` itself is the real
 * thing in these tests -- the TTL being exercised is its own -- so only
 * the Tauri store underneath it is replaced. */
const files = new Map<string, Map<string, unknown>>();
function fileOf(name: string): Map<string, unknown> {
  let data = files.get(name);
  if (!data) {
    data = new Map<string, unknown>();
    files.set(name, data);
  }
  return data;
}
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    // Resolved per call rather than captured, because credential-cache
    // memoises its store handle for the life of the process: a test that
    // emptied `files` between cases would leave the module writing into
    // a Map nothing else can see.
    const data = fileOf(name);
    return {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key),
      save: async () => undefined,
    };
  },
}));

/** The one API call the refresh makes. Handed the trace the refresh
 * passes down, so a test can record on it what the real request would. */
const fetchUsers = vi.fn<(trace?: EndpointTrace) => Promise<ApiResult<ProtocolUser[]>>>();
vi.mock("./customer", () => ({ getProtocolUsers: (trace?: EndpointTrace) => fetchUsers(trace) }));

/** Telemetry, spied on rather than sent. Whether a stale connect is
 * *visible* is half of what this change is for, so it is asserted rather
 * than assumed. */
const reportAttempt = vi.fn();
vi.mock("./attempts", () => ({ reportAttempt: (r: unknown) => reportAttempt(r) }));

/** The socket-level probe, stood in for: its own tests are elsewhere.
 * What matters here is when the refresh asks for it. */
const probeControlPlane = vi.fn<(entries: unknown[]) => Promise<string | undefined>>();
vi.mock("./control-plane-probe", () => ({ probeControlPlane: (e: unknown[]) => probeControlPlane(e) }));

/** The report goes out after the probe when there is one, so a test
 * waits for it rather than reading it the moment the refresh returns. */
async function firstReport<T>(): Promise<T> {
  await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalled());
  return reportAttempt.mock.calls[0][0] as T;
}

const { refreshConnectionConfig, describeConfigDrift } = await import("./connection-config");
const { SNAPSHOT_TTL_MS, isSnapshotStale, saveSnapshot, loadSnapshot } = await import("./credential-cache");

/** A REALITY credential. `serverName` is the decoy SNI -- the field this
 * whole change exists to make changeable. The `host` is a documentation
 * address standing in for a node (RFC 5737); node addresses are never
 * committed -- see docs/node-address-hygiene.md. */
function reality(serverName: string, id = "pu-1"): ProtocolUser {
  return {
    id,
    routeId: "route-france-1",
    protocol: "XRAY_VLESS_REALITY",
    connection: {
      host: "203.0.113.10",
      port: 443,
      transport: "TCP",
      security: "REALITY",
      publicParams: { serverName, dest: `${serverName}:443`, shortIds: ["0123abcd"] },
    },
  } as unknown as ProtocolUser;
}

async function seedCache(users: ProtocolUser[], savedAt: number) {
  await saveSnapshot({ subscription: null, protocolUsers: users, routes: [] });
  // saveSnapshot stamps Date.now(); rewrite the age directly so a test
  // can describe a week-old cache without waiting a week.
  const data = fileOf("connection-cache.json");
  data.set("snapshot", { ...(data.get("snapshot") as object), savedAt });
}

beforeEach(() => {
  for (const data of files.values()) data.clear();
  fetchUsers.mockReset();
  reportAttempt.mockReset();
  probeControlPlane.mockReset();
  probeControlPlane.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* The control.                                                        */
/* ------------------------------------------------------------------ */

/** What the app did before this change, reproduced exactly.
 *
 * `getProtocolUsers()` had one call site -- the screen's initial load --
 * and the connect path dialled whatever that had put in React state.
 * Nothing between the two ever asked again. This is that, in four lines,
 * and it is here so the assertions below are anchored to a demonstrated
 * failure rather than to a claim about one.
 */
async function legacyConnect(heldInMemory: ProtocolUser[]): Promise<string> {
  const dialled = heldInMemory[0];
  return String(dialled.connection.publicParams.serverName);
}

describe("the stale-SNI window (control)", () => {
  it("dials a decoy the server has already moved off, indefinitely", async () => {
    // The customer opened the app while the decoy was cloudflare.com.
    const held = [reality("cloudflare.com")];
    // The operator has since moved it. The server would say so if asked.
    fetchUsers.mockResolvedValue({ ok: true, data: [reality("www.samsung.com")] });

    // The old path does not ask. Toggling the VPN off and on re-runs
    // exactly this, so the dead value survives every reconnect.
    expect(await legacyConnect(held)).toBe("cloudflare.com");
    expect(await legacyConnect(held)).toBe("cloudflare.com");
    expect(fetchUsers).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* The fix.                                                            */
/* ------------------------------------------------------------------ */

describe("refreshConnectionConfig", () => {
  it("dials the decoy the server has now, not the one held since launch", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: true, data: [reality("www.samsung.com")] });

    const result = await refreshConnectionConfig({ held });

    expect(result.source).toBe("network");
    expect(String(result.protocolUsers[0].connection.publicParams.serverName)).toBe("www.samsung.com");
    // The same values an offline start would come back to, so the fix
    // survives the app being closed.
    //
    // Waited for rather than read straight away: the cache write is
    // fired and not awaited, on purpose -- the connect should not sit
    // behind a disk write it does not need. That makes it a real race in
    // a test and only in a test.
    await vi.waitFor(async () => {
      expect(String((await loadSnapshot())!.protocolUsers[0].connection.publicParams.serverName)).toBe(
        "www.samsung.com",
      );
    });
  });

  it("connects on what it holds when the control plane cannot be reached", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    const result = await refreshConnectionConfig({ held });

    // The whole point: a failed refresh costs freshness, never the
    // connection. Somebody in Iran with a filtered panel still dials.
    expect(result.source).toBe("stale");
    expect(result.protocolUsers).toEqual(held);
    expect(result.sessionExpired).toBe(false);
  });

  it("makes a stale connect visible instead of silent", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - 3 * 60 * 60_000);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    await refreshConnectionConfig({ held });

    expect(reportAttempt).toHaveBeenCalledTimes(1);
    const report = reportAttempt.mock.calls[0][0] as { outcome: string; reason: string };
    expect(report.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    // The age is the operative detail. "Connected on a cache" and
    // "connected on a cache from three hours ago" send an operator to
    // different places.
    expect(report.reason).toContain("180 min old");
    expect(console.warn).toHaveBeenCalled();
  });

  it("gives up on its own budget rather than the API's, and still connects", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    // A filtered address blackholes packets: the request neither
    // succeeds nor fails, it hangs. This is that.
    fetchUsers.mockReturnValue(new Promise(() => undefined));

    const started = Date.now();
    const result = await refreshConnectionConfig({ held, budgetMs: 30 });

    expect(result.source).toBe("stale");
    expect(result.protocolUsers).toEqual(held);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((reportAttempt.mock.calls[0][0] as { reason: string }).reason).toContain("no answer within 30ms");
  });

  /** The field that was null on every row, and then a list of what the
   * client *would* have tried. Now: what it did try, in which leg, and
   * how each ended. RFC 2606 names stand in for the real list. */
  it("reports each address tried, by leg, when the refresh fails", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockImplementation(async (trace) => {
      // The usual shape after fifteen idle minutes: the GET answers 401,
      // and the token refresh it triggers gets nowhere.
      settleAttempt(beginAttempt(trace, "https://api.example.net/api", 0), "h401", 900);
      settleAttempt(beginAttempt(trace, "https://edge.example.org:2053/api", 0), "cancel", 901);
      trace!.phase = "refresh";
      settleAttempt(beginAttempt(trace, "https://api.example.net/api", 1_000), "net", 1_200);
      return { ok: false, error: "Could not renew your session just now. Try again in a moment." };
    });

    await refreshConnectionConfig({ held });

    const report = reportAttempt.mock.calls[0][0] as { outcome: string; apiEndpoint: string };
    expect(report.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    expect(report.apiEndpoint).toBe(
      "req: api.example.net=h401@900 edge.example.org:2053=cancel@901; refresh: api.example.net=net@200",
    );
  });

  /** The question the old field could never answer: the refresh gave up
   * while an address was still being waited on. */
  it("names the address the budget ran out on", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockImplementation((trace) => {
      beginAttempt(trace, "https://api.example.net/api");
      return new Promise(() => undefined);
    });

    await refreshConnectionConfig({ held, budgetMs: 30 });

    const report = reportAttempt.mock.calls[0][0] as { apiEndpoint: string };
    expect(report.apiEndpoint).toMatch(/^req: api\.example\.net=budget@\d+$/);
  });

  /** A foreground or a returning network runs the same refresh with
   * nothing connecting afterwards. Its report said "connecting on cached
   * credentials" all the same, so on the phones -- where it fires on
   * every foreground past the horizon -- most "connect" rows were not
   * connects at all. */
  it.each([
    ["resume", "resume config refresh failed"],
    ["online", "online config refresh failed"],
  ] as const)("does not describe a %s refresh as a connect", async (trigger, prefix) => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    await refreshConnectionConfig({ held, force: true, trigger });

    const { reason } = await firstReport<{ reason: string }>();
    expect(reason.startsWith(prefix)).toBe(true);
    expect(reason).not.toContain("connecting");
    expect(reason).toContain("nothing is being dialled");
  });

  /** The connect keeps the wording every earlier build used, so old and
   * new rows still split on the same prefix. */
  it("keeps the connect's own wording for a connect", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    await refreshConnectionConfig({ held });

    const reason = (reportAttempt.mock.calls[0][0] as { reason: string }).reason;
    expect(reason.startsWith("pre-connect config refresh failed (Could not reach Neoxify.")).toBe(true);
    expect(reason).toContain("connecting on cached credentials");
  });

  /** With a tunnel up the refresh went through it, which is a different
   * failure from one on the bare network. Labelled as what the screen
   * showed, because that is all it is. And how long it waited, which is
   * the other half of "no answer". */
  it("says what the app showed and how long it waited", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockReturnValue(new Promise(() => undefined));

    await refreshConnectionConfig({ held, budgetMs: 30, trigger: "resume", appState: "connected" });

    const { reason } = await firstReport<{ reason: string }>();
    expect(reason).toMatch(/^resume config refresh failed \(no answer within 30ms\) after \d+ms; /);
    expect(reason.endsWith("; app showed connected")).toBe(true);
  });

  /** iOS suspends a backgrounded app, so a refresh caught by that
   * "times out" without the network having had a say. The report says
   * when that happened, so those rows can be told apart. */
  it("says when the app went to the background during the refresh", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    Object.assign(globalThis, { document: doc });
    try {
      fetchUsers.mockImplementation(async () => {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
        return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
      });

      await refreshConnectionConfig({ held, force: true, trigger: "resume" });

      const { reason } = await firstReport<{ reason: string }>();
      expect(reason.endsWith("; app was in the background during it")).toBe(true);
    } finally {
      Object.assign(globalThis, { document: undefined });
    }
  });

  it("does not say so when it stayed in front", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    await refreshConnectionConfig({ held });

    expect((await firstReport<{ reason: string }>()).reason).not.toContain("background");
  });

  /** After a refresh nothing follows, the probe's answer -- which stage
   * each failed address failed at -- goes on the end of the trace. */
  it("adds the probe's answer to a failed resume refresh", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockImplementation(async (trace) => {
      settleAttempt(beginAttempt(trace, "https://api.example.net/api", 0), "timeout", 8_000);
      return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
    });
    probeControlPlane.mockResolvedValue("probe: api.example.net=tls@310");

    await refreshConnectionConfig({ held, force: true, trigger: "resume" });

    const { apiEndpoint } = await firstReport<{ apiEndpoint: string }>();
    expect(apiEndpoint).toBe("req: api.example.net=timeout@8000; probe: api.example.net=tls@310");
    expect(probeControlPlane).toHaveBeenCalledTimes(1);
  });

  /** A connect starts the moment the refresh gives up, and changes the
   * path under anything still measuring it. No probe there. */
  it("does not probe before a connect", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockImplementation(async (trace) => {
      settleAttempt(beginAttempt(trace, "https://api.example.net/api", 0), "timeout", 8_000);
      return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
    });

    await refreshConnectionConfig({ held });

    expect(probeControlPlane).not.toHaveBeenCalled();
    expect((await firstReport<{ apiEndpoint: string }>()).apiEndpoint).toBe("req: api.example.net=timeout@8000");
  });

  /** Never a list of addresses that were not dialled. */
  it("says so when nothing was dialled", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    await refreshConnectionConfig({ held });

    expect((reportAttempt.mock.calls[0][0] as { apiEndpoint: string }).apiEndpoint).toBe("none dialled");
  });

  it("reports an expired session without deciding what to do about it", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - SNAPSHOT_TTL_MS - 1);
    fetchUsers.mockResolvedValue({ ok: false, error: "Your session expired.", sessionExpired: true });

    const result = await refreshConnectionConfig({ held });

    expect(result.sessionExpired).toBe(true);
    // Still dialable. The tunnel does not authenticate against the
    // control plane, so a stale token is no reason to refuse to connect.
    expect(result.protocolUsers).toEqual(held);
    // Not reported as unreachable -- the server answered.
    expect(reportAttempt).not.toHaveBeenCalled();
  });

  it("asks nothing at all while what it holds is still fresh", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - 30_000);

    const result = await refreshConnectionConfig({ held });

    expect(result.source).toBe("fresh");
    // One request on connect, not a poll, and not even that when the
    // answer is minutes old. A customer reconnecting after a hiccup pays
    // nothing.
    expect(fetchUsers).not.toHaveBeenCalled();
  });

  it("asks anyway when the customer explicitly retried", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, Date.now() - 30_000);
    fetchUsers.mockResolvedValue({ ok: true, data: [reality("www.samsung.com")] });

    const result = await refreshConnectionConfig({ held, force: true });

    expect(result.source).toBe("network");
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("treats a cache of unknown age as stale rather than as new", async () => {
    const held = [reality("cloudflare.com")];
    await seedCache(held, 0);
    fetchUsers.mockResolvedValue({ ok: true, data: [reality("www.samsung.com")] });

    expect((await refreshConnectionConfig({ held })).source).toBe("network");
  });
});

describe("isSnapshotStale", () => {
  const now = 1_700_000_000_000;

  it("is fresh right up to the horizon and stale past it", () => {
    expect(isSnapshotStale({ savedAt: now - SNAPSHOT_TTL_MS }, now)).toBe(false);
    expect(isSnapshotStale({ savedAt: now - SNAPSHOT_TTL_MS - 1 }, now)).toBe(true);
  });

  it("does not trust a snapshot from the future", () => {
    // A clock that moved backwards would otherwise pin a cache as fresh
    // for as long as the skew lasts.
    expect(isSnapshotStale({ savedAt: now + 60_000 }, now)).toBe(true);
  });

  it("has no snapshot count as stale", () => {
    expect(isSnapshotStale(null, now)).toBe(true);
  });
});

describe("describeConfigDrift", () => {
  it("names a credential whose decoy moved", () => {
    const drift = describeConfigDrift([reality("cloudflare.com")], [reality("www.samsung.com")]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("route-france-1");
  });

  it("says nothing when nothing moved", () => {
    expect(describeConfigDrift([reality("cloudflare.com")], [reality("cloudflare.com")])).toEqual([]);
  });

  it("is not fooled by key order", () => {
    const before = reality("cloudflare.com");
    const after = reality("cloudflare.com");
    after.connection.publicParams = {
      shortIds: ["0123abcd"],
      dest: "cloudflare.com:443",
      serverName: "cloudflare.com",
    };
    // A re-serialisation is not a change, and reporting it as one would
    // put a drift line on every single connect.
    expect(describeConfigDrift([before], [after])).toEqual([]);
  });

  it("does not report a route that has only just appeared", () => {
    const drift = describeConfigDrift([reality("cloudflare.com", "pu-1")], [
      reality("cloudflare.com", "pu-1"),
      reality("www.samsung.com", "pu-2"),
    ]);
    expect(drift).toEqual([]);
  });

  it("never puts a secret in a drift line", () => {
    const before = reality("cloudflare.com");
    const after = reality("www.samsung.com");
    (before as { credentials: Record<string, string> }).credentials = { uuid: "SECRET-BEFORE" };
    (after as { credentials: Record<string, string> }).credentials = { uuid: "SECRET-AFTER" };
    // Drift lines go to telemetry. The one field here that is a secret
    // stays out of the fingerprint for that reason.
    const line = describeConfigDrift([before], [after]).join(" ");
    expect(line).not.toContain("SECRET");
  });
});
