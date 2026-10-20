import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: (key: string) => Promise.resolve(saved.get(key)),
      set: (key: string, value: unknown) => {
        saved.set(key, structuredClone(value));
        return Promise.resolve();
      },
      save: () => Promise.resolve(),
    }),
}));

import {
  closeLeftOpen,
  createRecordBytes,
  loggedCredential,
  movedRoute,
  prune,
  PRUNE_EVERY_MS,
  readLog,
  RETENTION_MS,
  sessionLog,
  type SessionRecord,
} from "./session-log";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const record = (id: string, start: number, over: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  start,
  end: start + 60_000,
  open: false,
  routeId: "de-stealth",
  protocol: "XRAY_VLESS_TLS",
  rxBytes: 1000,
  txBytes: 100,
  ended: "disconnected",
  ...over,
});

beforeEach(() => {
  saved.clear();
  sessionLog.resetForTests();
});

describe("what a record carried", () => {
  it("adds up a drop and a reconnect onto the same route: both sessions, not the last", () => {
    const bytes = createRecordBytes();
    bytes.see(0, { rx: 1_000, tx: 100 });
    bytes.see(0, { rx: 5_000, tx: 400 });
    // The drop: no tunnel, the meter reset.
    bytes.see(1, null);
    // The reconnect's session, from nothing.
    bytes.see(1, { rx: 300, tx: 30 });
    bytes.see(1, { rx: 2_000, tx: 90 });
    expect(bytes.total()).toEqual({ rx: 7_000, tx: 490 });
  });

  it("takes totals going backwards for a new session's, and a stale gap for none", () => {
    const bytes = createRecordBytes();
    bytes.see(0, { rx: 5_000, tx: 400 });
    bytes.see(0, null); // gone stale: the same session, read again later
    bytes.see(0, { rx: 6_000, tx: 450 });
    bytes.see(0, { rx: 200, tx: 10 }); // an engine restarted under the same screen
    expect(bytes.total()).toEqual({ rx: 6_200, tx: 460 });
  });

  it("closes a record the route moved from with its own sessions, and goes on counting the new one", () => {
    const bytes = createRecordBytes();
    bytes.see(0, { rx: 5_000, tx: 400 });
    bytes.see(1, null);
    // The new route's first reading came before the screen moved the record.
    bytes.see(1, { rx: 700, tx: 70 });
    expect(bytes.split()).toEqual({ rx: 5_000, tx: 400 });
    bytes.see(1, { rx: 900, tx: 80 });
    expect(bytes.total()).toEqual({ rx: 900, tx: 80 });
  });

  it("gives everything to the old record when the route moved before any new session was read", () => {
    const bytes = createRecordBytes();
    bytes.see(0, { rx: 5_000, tx: 400 });
    expect(bytes.split()).toEqual({ rx: 5_000, tx: 400 });
    expect(bytes.total()).toBeNull();
    bytes.see(1, null);
    bytes.see(1, { rx: 50, tx: 5 });
    expect(bytes.total()).toEqual({ rx: 50, tx: 5 });
  });

  it("starts a record from nothing banked, keeping the session already up", () => {
    const bytes = createRecordBytes();
    bytes.see(0, { rx: 5_000, tx: 400 });
    bytes.see(1, null);
    bytes.see(1, { rx: 10, tx: 1 });
    bytes.restart();
    bytes.see(1, { rx: 20, tx: 2 });
    expect(bytes.total()).toEqual({ rx: 20, tx: 2 });
  });
});

describe("the session log", () => {
  it("drops a record past its seven days on the hourly tick, while the app runs", async () => {
    saved.set("log", { enabled: true, records: [record("old", NOW - 6 * DAY - 23 * 3_600_000), record("new", NOW - DAY)] });
    await sessionLog.load(NOW);
    expect(sessionLog.current().records.map((r) => r.id)).toEqual(["old", "new"]);
    let tick: (() => void) | null = null;
    const stop = vi.fn();
    expect(
      sessionLog.keepPruned((fn, ms) => {
        expect(ms).toBe(PRUNE_EVERY_MS);
        tick = fn;
        return stop;
      }),
    ).toBe(stop);
    // Two hours on, the first is past RETENTION_MS: the tick drops it, on
    // disk too.
    vi.useFakeTimers({ now: NOW + 2 * 3_600_000, toFake: ["Date"] });
    try {
      tick!();
      await vi.waitFor(() => expect(sessionLog.current().records.map((r) => r.id)).toEqual(["new"]));
      expect((saved.get("log") as { records: SessionRecord[] }).records.map((r) => r.id)).toEqual(["new"]);
    } finally {
      vi.useRealTimers();
    }
    expect(NOW + 2 * 3_600_000 - (NOW - 6 * DAY - 23 * 3_600_000)).toBeGreaterThan(RETENTION_MS);
  });

  it("keeps nothing to prune while it is off", async () => {
    await sessionLog.load(NOW);
    await sessionLog.pruneNow(NOW + 30 * DAY);
    expect(sessionLog.current()).toEqual({ enabled: false, records: [] });
    expect(saved.get("log")).toEqual({ enabled: false, records: [] });
  });

  it("is off, and empty, until the customer turns it on", async () => {
    expect(await sessionLog.load(NOW)).toEqual({ enabled: false, records: [] });
    await sessionLog.begin({ start: NOW, routeId: "de-stealth", protocol: "WIREGUARD" }, NOW);
    expect(sessionLog.current().records).toEqual([]);
    expect(saved.get("log")).toEqual({ enabled: false, records: [] });
  });

  it("records a connection from up to gone, with what the adapter counted and how it ended", async () => {
    await sessionLog.setEnabled(true);
    await sessionLog.begin({ start: NOW, routeId: "de-stealth", protocol: "XRAY_VLESS_TLS", transport: "WS" }, NOW);
    expect(sessionLog.openRecord()).toMatchObject({ open: true, routeId: "de-stealth" });
    // A second look at the same tunnel opens nothing new.
    await sessionLog.begin({ start: NOW + 5, routeId: "de-stealth", protocol: "XRAY_VLESS_TLS" }, NOW + 5);
    await sessionLog.finish({ end: NOW + 90_000, rxBytes: 5_000, txBytes: 700, ended: "lost" }, NOW + 90_000);
    const records = sessionLog.current().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ start: NOW, end: NOW + 90_000, open: false, rxBytes: 5_000, txBytes: 700, ended: "lost", transport: "WS" });
    expect(sessionLog.openRecord()).toBeNull();
  });

  it("keeps an end it did not see as unknown, never a made-up one", () => {
    const left = closeLeftOpen([record("a", NOW, { open: true, end: null, ended: null }), record("b", NOW)]);
    expect(left[0]).toMatchObject({ open: false, end: null, ended: null });
    expect(left[1]).toEqual(record("b", NOW));
  });

  it("closes what the last run left open, and drops anything older than seven days, on load", async () => {
    saved.set("log", {
      enabled: true,
      records: [record("old", NOW - RETENTION_MS - DAY), record("open", NOW - DAY, { open: true, end: null, ended: null })],
    });
    const loaded = await sessionLog.load(NOW);
    expect(loaded.records.map((r) => r.id)).toEqual(["open"]);
    expect(loaded.records[0]).toMatchObject({ open: false, end: null });
  });

  it("keeps seven days", () => {
    const kept = prune([record("a", NOW - 8 * DAY), record("b", NOW - 6 * DAY), record("c", NOW)], NOW);
    expect(kept.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("deletes everything when turned off, and on Clear, and on sign-out -- which also turns it off", async () => {
    await sessionLog.setEnabled(true);
    await sessionLog.begin({ start: NOW, routeId: "x", protocol: "WIREGUARD" }, NOW);
    await sessionLog.clear();
    expect(sessionLog.current()).toEqual({ enabled: true, records: [] });

    await sessionLog.begin({ start: NOW, routeId: "x", protocol: "WIREGUARD" }, NOW);
    await sessionLog.setEnabled(false);
    expect(sessionLog.current()).toEqual({ enabled: false, records: [] });
    expect(saved.get("log")).toEqual({ enabled: false, records: [] });

    await sessionLog.setEnabled(true);
    await sessionLog.begin({ start: NOW, routeId: "x", protocol: "WIREGUARD" }, NOW);
    await sessionLog.wipe();
    expect(sessionLog.current()).toEqual({ enabled: false, records: [] });
    expect(saved.get("log")).toEqual({ enabled: false, records: [] });
  });

  it("reads only records, and nothing at all while it is off", () => {
    expect(readLog({ enabled: true, records: [{ id: "a", start: 5 }, { start: 6 }, "junk", null] }).records.map((r) => r.id)).toEqual(["a"]);
    expect(readLog({ enabled: false, records: [record("a", NOW)] }).records).toEqual([]);
    expect(readLog("nonsense")).toEqual({ enabled: false, records: [] });
  });

  it("never stores an address or a network", async () => {
    await sessionLog.setEnabled(true);
    await sessionLog.begin({ start: NOW, routeId: "de-stealth", protocol: "WIREGUARD" }, NOW);
    await sessionLog.finish({ end: NOW + 1000, rxBytes: null, txBytes: null, ended: "disconnected" }, NOW + 1000);
    const keys = Object.keys((saved.get("log") as { records: Record<string, unknown>[] }).records[0]).sort();
    expect(keys).toEqual(["end", "ended", "id", "open", "protocol", "routeId", "rxBytes", "start", "txBytes"]);
  });
});

/* Seen on the VM against 0.9.51: Singapore on Stealth, then Settings and
 * back, and the screen named the pin -- the UK on Stealth Web. The screen
 * holds the pin's credential after every load; only a pass, or a read of
 * the service that names the tunnel (lib/tunnel-credential.ts), says which
 * credential the tunnel is on. The log reads the same credential as the
 * location card, so it takes the same rule. */
describe("the session log names the tunnel the screen can name, and nothing else", () => {
  const ukWeb = { id: "pu-uk-web", routeId: "uk-web", protocol: "XRAY_VLESS_TLS", connection: { transport: "WS" } };
  const sgStealth = { id: "pu-sg", routeId: "sg-reality", protocol: "XRAY_VLESS_REALITY" };
  const deStealth = { id: "pu-de", routeId: "de-reality", protocol: "XRAY_VLESS_REALITY" };

  it("takes the held credential only while the screen names the tunnel", () => {
    expect(loggedCredential(sgStealth, true)).toBe(sgStealth);
    // Back from Settings: the screen holds the pin, and cannot name the tunnel.
    expect(loggedCredential(ukWeb, false)).toBeNull();
    expect(loggedCredential(null, true)).toBeNull();
    expect(loggedCredential(undefined, true)).toBeNull();
  });

  it("keeps a session's record over a remount that cannot name the tunnel, rather than closing it as lost and opening one on the pin", () => {
    const open = { routeId: sgStealth.routeId };
    expect(movedRoute(open, loggedCredential(ukWeb, false))).toBe(false);
    // 0.9.51's comparison, against the credential held: the session ended
    // as "Lost" and a new one on the UK began.
    expect(open.routeId !== ukWeb.routeId).toBe(true);
    // And once the service's read names it again, it is the same session.
    expect(movedRoute(open, loggedCredential(sgStealth, true))).toBe(false);
  });

  it("counts a move only between two routes it knows", () => {
    // A failover or a switch, both named: the record closes, the next begins.
    expect(movedRoute({ routeId: sgStealth.routeId }, deStealth)).toBe(true);
    // A record begun over a tunnel nobody could name, named later: the same tunnel.
    expect(movedRoute({ routeId: null }, sgStealth)).toBe(false);
    expect(movedRoute(null, sgStealth)).toBe(false);
    expect(movedRoute({ routeId: sgStealth.routeId }, null)).toBe(false);
  });

  it("records a tunnel it cannot name with no place and no protocol", async () => {
    await sessionLog.setEnabled(true);
    const user = loggedCredential(ukWeb, false);
    await sessionLog.begin({ start: NOW, routeId: user?.routeId ?? null, protocol: user?.protocol ?? null }, NOW);
    expect(sessionLog.openRecord()).toMatchObject({ open: true, routeId: null, protocol: null });
  });
});
