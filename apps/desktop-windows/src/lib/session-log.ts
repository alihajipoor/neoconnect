import { load, type Store } from "@tauri-apps/plugin-store";

/** "Keep a session log on this device" (owner, 2026-10-19): off unless the
 * customer turns it on; on this device only -- nothing here is sent
 * anywhere; seven days, then gone; a Clear button; turning it off deletes
 * it; signing out deletes it and turns it off.
 *
 * Off by default for a reason the screen says: a record of VPN use kept
 * on a device can be read by anyone who can open it, which in Iran is
 * not hypothetical. So it records as little as is useful -- when a
 * verified tunnel came up and went, through which location and protocol,
 * and what the tunnel adapter counted, if it counted -- and never an
 * address, a network, or what was visited.
 *
 * A record opens when the main page first shows a tunnel up and closes
 * when it shows it gone, saying whether the customer ended it or it was
 * lost. One the app could not close -- the app ended first -- has no end
 * rather than a made-up one. */

export interface SessionRecord {
  readonly id: string;
  readonly start: number;
  /** Null: the app ended before the tunnel did, and nothing saw it go. */
  readonly end: number | null;
  readonly open: boolean;
  readonly routeId: string | null;
  readonly protocol: string | null;
  readonly transport?: string;
  /** What the tunnel's adapter counted, when the platform counts it. */
  readonly rxBytes: number | null;
  readonly txBytes: number | null;
  /** How it ended: the customer's own Disconnect (or a switch), or lost. */
  readonly ended: "disconnected" | "lost" | null;
}

export interface SessionLogState {
  readonly enabled: boolean;
  readonly records: readonly SessionRecord[];
}

export const RETENTION_MS = 7 * 86_400_000;
export const MAX_RECORDS = 500;

export const EMPTY_LOG: SessionLogState = { enabled: false, records: [] };

/** Older than seven days -- by when it started -- is gone; so is anything
 * past `MAX_RECORDS`, oldest first. */
export function prune(records: readonly SessionRecord[], now: number): SessionRecord[] {
  return records.filter((r) => now - r.start <= RETENTION_MS).slice(-MAX_RECORDS);
}

/** A run of the app starts here: whatever the last one left open, it did
 * not see close. Its end stays unknown. */
export function closeLeftOpen(records: readonly SessionRecord[]): SessionRecord[] {
  return records.map((r) => (r.open ? { ...r, open: false, end: null, ended: null } : r));
}

export function openRecord(
  records: readonly SessionRecord[],
  entry: { id: string; start: number; routeId: string | null; protocol: string | null; transport?: string },
): SessionRecord[] {
  return [
    ...records,
    { ...entry, end: null, open: true, rxBytes: null, txBytes: null, ended: null },
  ];
}

export function closeRecord(
  records: readonly SessionRecord[],
  id: string,
  { end, rxBytes, txBytes, ended }: { end: number; rxBytes: number | null; txBytes: number | null; ended: "disconnected" | "lost" },
): SessionRecord[] {
  return records.map((r) => (r.id === id && r.open ? { ...r, open: false, end: Math.max(r.start, end), rxBytes, txBytes, ended } : r));
}

/** What a stored value holds, read defensively: anything that is not a
 * record is dropped. */
export function readLog(raw: unknown): SessionLogState {
  if (raw === null || typeof raw !== "object") return EMPTY_LOG;
  const from = raw as Record<string, unknown>;
  const enabled = from.enabled === true;
  const list = Array.isArray(from.records) ? from.records : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const records: SessionRecord[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    const start = num(r.start);
    if (id === null || start === null) continue;
    records.push({
      id,
      start,
      end: num(r.end),
      open: r.open === true,
      routeId: str(r.routeId),
      protocol: str(r.protocol),
      ...(typeof r.transport === "string" ? { transport: r.transport } : {}),
      rxBytes: num(r.rxBytes),
      txBytes: num(r.txBytes),
      ended: r.ended === "disconnected" || r.ended === "lost" ? r.ended : null,
    });
  }
  // Nothing is kept while it is off.
  return { enabled, records: enabled ? records : [] };
}

// --- the store -----------------------------------------------------------------

const STORE_FILE = "session-log.json";
const KEY = "log";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

let state: SessionLogState = EMPTY_LOG;
let loaded = false;
let loading: Promise<SessionLogState> | null = null;
/** The record this run has open, if any. */
let openId: string | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function publish(next: SessionLogState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

async function persist(): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, state);
    await store.save();
  } catch {
    // Kept for this run. A log that could not be written is a log that
    // is not on the disk -- the safe side of this feature.
  }
}

export const sessionLog = {
  current(): SessionLogState {
    return state;
  },
  loaded(): boolean {
    return loaded;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Reads the store once per run: what an earlier run left open is
   * closed with no end, and anything past seven days goes. */
  load(now = Date.now()): Promise<SessionLogState> {
    if (loaded) return Promise.resolve(state);
    loading ??= getStore()
      .then((store) => store.get<unknown>(KEY))
      .then(readLog, () => EMPTY_LOG)
      .then((read) => {
        if (!loaded) {
          loaded = true;
          publish({ enabled: read.enabled, records: prune(closeLeftOpen(read.records), now) });
          void persist();
        }
        return state;
      });
    return loading;
  },

  /** Turning it on starts recording from now; turning it off deletes it. */
  async setEnabled(enabled: boolean): Promise<void> {
    await sessionLog.load();
    openId = null;
    publish({ enabled, records: enabled ? state.records : [] });
    await persist();
  },

  /** The Clear button: everything recorded goes; it stays on. */
  async clear(): Promise<void> {
    await sessionLog.load();
    openId = null;
    publish({ enabled: state.enabled, records: [] });
    await persist();
  },

  /** Signing out: everything goes, and it is off for whoever signs in next. */
  async wipe(): Promise<void> {
    await sessionLog.load();
    openId = null;
    publish(EMPTY_LOG);
    await persist();
  },

  /** A tunnel is up. Nothing is recorded while it is off. */
  async begin(entry: { start: number; routeId: string | null; protocol: string | null; transport?: string }, now = Date.now()): Promise<void> {
    await sessionLog.load(now);
    if (!state.enabled || openId !== null) return;
    counter += 1;
    const id = `${entry.start.toString(36)}-${counter}`;
    openId = id;
    publish({ enabled: true, records: prune(openRecord(state.records, { id, ...entry }), now) });
    await persist();
  },

  /** The tunnel shown is gone. */
  async finish(
    outcome: { end: number; rxBytes: number | null; txBytes: number | null; ended: "disconnected" | "lost" },
    now = Date.now(),
  ): Promise<void> {
    await sessionLog.load(now);
    const id = openId;
    openId = null;
    if (id === null || !state.enabled) return;
    publish({ enabled: true, records: prune(closeRecord(state.records, id, outcome), now) });
    await persist();
  },

  /** The record open in this run, if any. */
  openRecord(): SessionRecord | null {
    if (openId === null) return null;
    return state.records.find((r) => r.id === openId) ?? null;
  },

  /** For tests: a fresh run. */
  resetForTests(): void {
    state = EMPTY_LOG;
    loaded = false;
    loading = null;
    storePromise = null;
    openId = null;
    counter = 0;
    listeners.clear();
  },
};
