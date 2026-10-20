/** Live download and upload speeds, from Windows' own counters on the
 * tunnel's adapter (the service's `engines::traffic`, `GetIfEntry2`):
 * what the adapter carried, not an estimate.
 *
 * The service measures the rate itself, over about a second between two
 * of its readings, and leaves it out until it has two; it sends nothing
 * at all when it read nothing -- no session, an adapter it could not find,
 * a service too busy to look. So:
 *
 *  - a rate is shown only as the service measured it -- 0 B/s included,
 *    when that is what it measured -- and never made up from totals here;
 *  - before the first rate there is a dash, not a zero;
 *  - with no reading for `STALE_AFTER_MS` there is no speed section at
 *    all: a number the app cannot stand behind is not shown
 *    (design-system.md, 4.9). One poll the service could not answer does
 *    not take it away and bring it back a second later.
 *
 * The main page's one-second liveness poll is what reads it, so it moves
 * once a second, in steps. One meter per run, like the pass it belongs to;
 * reset whenever no tunnel is up, so a session's numbers are its own. */

export interface TunnelTraffic {
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly rxPerSec: number | null;
  readonly txPerSec: number | null;
}

/** The status's `traffic` field, or null for nothing read -- or a shape
 * this app does not know, which says nothing rather than a wrong number. */
export function readTraffic(raw: unknown): TunnelTraffic | null {
  if (raw === null || typeof raw !== "object") return null;
  const field = raw as Record<string, unknown>;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const rx = count(field.rx_bytes);
  const tx = count(field.tx_bytes);
  if (rx === null || tx === null) return null;
  return { rxBytes: rx, txBytes: tx, rxPerSec: count(field.rx_per_sec), txPerSec: count(field.tx_per_sec) };
}

export const SERIES_LENGTH = 60;
export const STALE_AFTER_MS = 5_000;

export interface TrafficView {
  readonly rxPerSec: number | null;
  readonly txPerSec: number | null;
  readonly rxBytes: number;
  readonly txBytes: number;
  /** The last `SERIES_LENGTH` measured rates, oldest first. */
  readonly rxSeries: readonly number[];
  readonly txSeries: readonly number[];
}

export interface TrafficMeter {
  /** A status's `traffic`, as read at `at`. Nothing read is not a reading. */
  observe(raw: unknown, at?: number): void;
  /** What to show at `at`, or null for no speed section. */
  view(at?: number): TrafficView | null;
  /** Whether there is anything to show at `at`. */
  available(at?: number): boolean;
  /** No tunnel: the next session starts from nothing. */
  reset(): void;
  /** Counts the resets that cleared something: a reading under a
   * different number belongs to a different session. */
  generation(): number;
  subscribe(listener: () => void): () => void;
}

export function createTrafficMeter(
  clock: () => number = Date.now,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): TrafficMeter {
  let last: { at: number; traffic: TunnelTraffic } | null = null;
  let rxSeries: number[] = [];
  let txSeries: number[] = [];
  let staleTimer: unknown = null;
  let resets = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const push = (series: number[], value: number | null) => {
    if (value === null) return series;
    const next = series.length >= SERIES_LENGTH ? series.slice(series.length - SERIES_LENGTH + 1) : series.slice();
    next.push(value);
    return next;
  };

  const meter: TrafficMeter = {
    observe(raw, at = clock()) {
      const traffic = readTraffic(raw);
      if (traffic === null) return;
      last = { at, traffic };
      rxSeries = push(rxSeries, traffic.rxPerSec);
      txSeries = push(txSeries, traffic.txPerSec);
      // Told again when this reading goes stale, so the section leaves on
      // time whether or not anything else moves.
      if (staleTimer !== null) timers.clear(staleTimer);
      staleTimer = timers.set(() => {
        staleTimer = null;
        notify();
      }, STALE_AFTER_MS + 50);
      notify();
    },
    view(at = clock()) {
      if (last === null || at - last.at > STALE_AFTER_MS) return null;
      return {
        rxPerSec: last.traffic.rxPerSec,
        txPerSec: last.traffic.txPerSec,
        rxBytes: last.traffic.rxBytes,
        txBytes: last.traffic.txBytes,
        rxSeries,
        txSeries,
      };
    },
    available(at = clock()) {
      return meter.view(at) !== null;
    },
    reset() {
      if (last === null && rxSeries.length === 0 && txSeries.length === 0) return;
      resets += 1;
      last = null;
      rxSeries = [];
      txSeries = [];
      if (staleTimer !== null) timers.clear(staleTimer);
      staleTimer = null;
      notify();
    },
    generation() {
      return resets;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return meter;
}

export const trafficMeter = createTrafficMeter();

/** The points of a sparkline in a `width` x `height` box, newest at the
 * end, scaled to the largest value shown (and never to less than 1 KB/s,
 * so an idle line lies flat at the bottom rather than magnifying noise).
 * Empty under two values: one point is not a line. */
export function sparkPoints(series: readonly number[], width: number, height: number): string {
  if (series.length < 2) return "";
  const max = Math.max(1024, ...series);
  const step = width / (SERIES_LENGTH - 1);
  const start = width - step * (series.length - 1);
  return series
    .map((value, i) => {
      const x = start + step * i;
      const y = height - (value / max) * height;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}
