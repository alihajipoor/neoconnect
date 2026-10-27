/** Data checks from boxes inside the watched country, judged.
 *
 * The panel host runs `scripts/inside-probe/collect.sh` every half hour.
 * It asks each box -- over SSH, with a key that may run nothing but the
 * check -- to move 256 KB down and 256 KB up through every node's own
 * address, and posts what came back here. The boxes hold nothing secret:
 * no credentials, no token, and the list of nodes arrives on stdin.
 *
 * Why another monitor: check-host only asks whether a TCP connection
 * opens. In October 2026 every block found let one open -- an upload held
 * to about 0.1 Mbps after the first 63-95 KB, a connection that dies after
 * the hello, a blocked server name -- so the monitor saw nothing while
 * customers moved 1 MB a day. A timed upload past that first burst is what
 * shows the hold. */

/** What the check moves each way, and how long each leg may take. */
export const PROBE_BYTES = 256 * 1024;
export const PROBE_LEG_MS = 8_000;

export type InsideVerdict = "moves" | "slow" | "unreachable";

/** One leg as the box reports it: curl's status (0 when no answer), bytes
 * moved, and milliseconds taken. */
export interface ProbeLeg {
  status: number;
  bytes: number;
  ms: number;
}

/** Whether a node moved data from this box: both legs finished in time;
 * a connection that opened and then did not finish is held or dead after
 * the hello; no connection at all is unreachable. */
export function insideVerdict(connectMs: number | null, down: ProbeLeg, up: ProbeLeg): InsideVerdict {
  const done = (leg: ProbeLeg) => leg.status === 200 && leg.bytes >= PROBE_BYTES && leg.ms <= PROBE_LEG_MS + 1_000;
  if (done(down) && done(up)) return "moves";
  if (connectMs === null && down.status === 0 && up.status === 0) return "unreachable";
  return "slow";
}

export interface InsideRow {
  nodeName: string;
  vantage: string;
  verdict: string;
  upBytes: number;
  upMs: number;
  checkedAt: Date;
}

/** Per node and box over the rows given, the lines worth the owner's time:
 * a box that saw the node fail on at least half of its checks, with how
 * many and the upload speed it managed. Empty when every node moved data
 * from every box. */
export function insideSummary(rows: InsideRow[]): string[] {
  const series = new Map<string, InsideRow[]>();
  for (const row of rows) {
    const key = `${row.nodeName}\u0000${row.vantage}`;
    series.set(key, [...(series.get(key) ?? []), row]);
  }
  const lines: string[] = [];
  for (const [key, checks] of [...series.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [node, vantage] = key.split("\u0000");
    const failed = checks.filter((c) => c.verdict !== "moves");
    if (failed.length * 2 < checks.length) continue;
    const unreachable = failed.filter((c) => c.verdict === "unreachable").length;
    const uploads = failed.filter((c) => c.verdict === "slow" && c.upMs > 0).map((c) => (c.upBytes * 8) / c.upMs);
    const kbps = uploads.length > 0 ? Math.round(uploads.sort((a, b) => a - b)[Math.floor(uploads.length / 2)]) : null;
    const how =
      unreachable === failed.length
        ? "no connection"
        : kbps !== null
          ? `connects, but the upload managed about ${kbps} kbps`
          : "connects, but did not finish";
    lines.push(`${node} from ${vantage}: failed ${failed.length} of ${checks.length} checks -- ${how}`);
  }
  return lines;
}
