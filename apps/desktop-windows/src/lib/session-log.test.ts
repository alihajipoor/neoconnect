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

import { closeLeftOpen, prune, readLog, RETENTION_MS, sessionLog, type SessionRecord } from "./session-log";

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

describe("the session log", () => {
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
