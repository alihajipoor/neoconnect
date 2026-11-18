/** Connection sessions rebuilt from the usage the servers counted.
 *
 * A node reports each credential's traffic about every 30 seconds while
 * it flows. Consecutive periods on the same server and protocol, with no
 * more than `SESSION_GAP_MS` between one period's end and the next one's
 * start, are taken as one session. That is a reading of the servers'
 * counters, not of an app's state: a tunnel that is up and idle carries
 * nothing and is not seen, so one long idle stretch splits a session in
 * two.
 *
 * Only periods in which the device sent something count. A WireGuard
 * peer whose device has gone keeps being sent the server's handshake
 * attempts -- download, no upload -- forever, and those periods would
 * read as a session nobody was having (the same rule as the live view
 * and the device limit). */

export const SESSION_GAP_MS = 15 * 60_000;
export const MAX_SESSIONS = 200;

export interface UsagePeriod {
  nodeName: string;
  protocol: string;
  start: number;
  end: number;
  bytesUp: bigint;
  bytesDown: bigint;
}

export interface UsageSession {
  start: string;
  end: string;
  seconds: number;
  nodeName: string;
  protocol: string;
  bytesUp: string;
  bytesDown: string;
}

/** Sessions, newest first, at most `max`. `periods` may come in any order. */
export function buildSessions(
  periods: UsagePeriod[],
  gapMs: number = SESSION_GAP_MS,
  max: number = MAX_SESSIONS,
): UsageSession[] {
  const byKey = new Map<string, UsagePeriod[]>();
  for (const p of periods) {
    if (p.bytesUp <= 0n) continue;
    const key = `${p.nodeName}\u0000${p.protocol}`;
    const list = byKey.get(key);
    if (list) list.push(p);
    else byKey.set(key, [p]);
  }

  const sessions: { start: number; end: number; nodeName: string; protocol: string; up: bigint; down: bigint }[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let open: (typeof sessions)[number] | null = null;
    for (const p of list) {
      if (open && p.start - open.end <= gapMs) {
        open.end = Math.max(open.end, p.end);
        open.up += p.bytesUp;
        open.down += p.bytesDown;
        continue;
      }
      open = { start: p.start, end: p.end, nodeName: p.nodeName, protocol: p.protocol, up: p.bytesUp, down: p.bytesDown };
      sessions.push(open);
    }
  }

  return sessions
    .sort((a, b) => b.start - a.start || a.nodeName.localeCompare(b.nodeName))
    .slice(0, max)
    .map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      seconds: Math.max(0, Math.round((s.end - s.start) / 1000)),
      nodeName: s.nodeName,
      protocol: s.protocol,
      bytesUp: s.up.toString(),
      bytesDown: s.down.toString(),
    }));
}
