import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";
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

/** The one API call the refresh makes. */
const fetchUsers = vi.fn<() => Promise<ApiResult<ProtocolUser[]>>>();
vi.mock("./customer", () => ({ getProtocolUsers: () => fetchUsers() }));

/** Telemetry, spied on rather than sent. Whether a stale connect is
 * *visible* is half of what this change is for, so it is asserted rather
 * than assumed. */
const reportAttempt = vi.fn();
vi.mock("./attempts", () => ({ reportAttempt: (r: unknown) => reportAttempt(r) }));

const { refreshConnectionConfig, describeConfigDrift } = await import("./connection-config");
const { SNAPSHOT_TTL_MS, isSnapshotStale, saveSnapshot, loadSnapshot } = await import("./credential-cache");

/** A REALITY credential. `serverName` is the decoy SNI -- the field this
 * whole change exists to make changeable. */
function reality(serverName: string, id = "pu-1"): ProtocolUser {
  return {
    id,
    routeId: "route-france-1",
    protocol: "XRAY_VLESS_REALITY",
    connection: {
      host: "38.60.249.229",
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
