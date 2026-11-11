/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call --
 * stand-ins for Prisma: async to match its signatures, reached through `as any`. */
import { AgentCommandStatus } from "@prisma/client";
import { DEFAULT_TUNING, parseTuning } from "../block-watch/block-signals";
import {
  COMMAND_KEEP_DAYS,
  FINISHED_COMMAND_STATUSES,
  PENDING_COMMAND_STATUSES,
  USAGE_KEEP_DAYS,
  commandBatchSql,
  commandCutoff,
  floorToHour,
  pruneCommands,
  rollUpBatchSql,
  rollUpUsage,
  usageCutoff,
  usageReaders,
} from "./retention";
import { lastUpstreamAt, reachesRollUp, upstreamGroups } from "./usage-reads";
import { parseDataRetentionMode } from "./data-retention.service";
import { parseArgs } from "../../cli/data-retention";

/** The retention's rules and its batching, on an in-memory stand-in for
 * Postgres. What the SQL itself means to Postgres -- the DELETE ...
 * RETURNING feeding the hourly INSERT, the UTC hour, the status re-check,
 * the cascades -- is proven in retention.db.spec.ts, which CI runs against
 * a migrated database (this PC has none). */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 10, 11, 22, 17, 31, 250));

describe("the days of usage detail kept", () => {
  const prismaWith = (incident: Date | null) =>
    ({ blockIncident: { findFirst: jest.fn().mockResolvedValue(incident ? { openedAt: incident } : null) } }) as never;

  it("is the owner's 35 days with the default tuning, rounded down to the UTC hour", async () => {
    const cut = await usageCutoff(prismaWith(null), NOW, DEFAULT_TUNING);
    expect(cut.reason).toBe("owner's rule");
    expect(cut.keepMs).toBe(USAGE_KEEP_DAYS * DAY);
    expect(cut.cutoff.toISOString()).toBe("2026-10-07T22:00:00.000Z");
    expect(cut.cutoff.getTime() % HOUR).toBe(0);
  });

  it("is never fewer than any reader needs", () => {
    for (const r of usageReaders(DEFAULT_TUNING)) expect(r.ms).toBeLessThanOrEqual(USAGE_KEEP_DAYS * DAY);
    // The apps' daily history is the longest after the owner's rule: 31
    // days, 14 h of time zones and a day of slack.
    expect(usageReaders(DEFAULT_TUNING).find((r) => r.reader === "daily usage history")!.ms).toBe(
      31 * DAY + 14 * HOUR + DAY,
    );
  });

  it("grows when BLOCK_WATCH_TUNING lengthens the block watch's baseline", async () => {
    const { tuning } = parseTuning("baselineWindow=40d");
    const cut = await usageCutoff(prismaWith(null), NOW, tuning);
    expect(cut.reason).toBe("block watch baseline");
    expect(cut.keepMs).toBe(40 * DAY + 3 * HOUR + 2 * HOUR + DAY);
    expect(cut.cutoff.getTime()).toBe(floorToHour(NOW.getTime() - cut.keepMs));
  });

  it("grows while an old block incident is still compared against", async () => {
    const opened = new Date(NOW.getTime() - 50 * DAY);
    const prisma = prismaWith(opened);
    const cut = await usageCutoff(prisma, NOW, DEFAULT_TUNING);
    expect(cut.reason).toBe("open block incident");
    expect(cut.keepMs).toBe(50 * DAY + 3 * HOUR + 7 * DAY + 2 * HOUR + DAY);
    // Open ones, and cleared ones recent enough to be reopened.
    const where = (prisma as any).blockIncident.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { status: "OPEN" },
      { status: "CLEARED", closedAt: { gte: new Date(NOW.getTime() - 48 * HOUR) } },
    ]);
  });

  it("stays at 35 days for a young incident", async () => {
    const cut = await usageCutoff(prismaWith(new Date(NOW.getTime() - 5 * DAY)), NOW, DEFAULT_TUNING);
    expect(cut.reason).toBe("owner's rule");
  });

  it("finished commands go after 7 days", () => {
    expect(COMMAND_KEEP_DAYS).toBe(7);
    expect(commandCutoff(NOW).getTime()).toBe(NOW.getTime() - 7 * DAY);
  });
});

describe("which commands are finished", () => {
  it("puts every status in exactly one list, so a new one has to be decided on", () => {
    const all = Object.values(AgentCommandStatus).sort();
    const listed = [...FINISHED_COMMAND_STATUSES, ...PENDING_COMMAND_STATUSES].sort();
    expect(listed).toEqual(all);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("never names QUEUED or SENT as finished", () => {
    expect(FINISHED_COMMAND_STATUSES).not.toContain("QUEUED");
    expect(FINISHED_COMMAND_STATUSES).not.toContain("SENT");
  });

  it("checks the status in the DELETE itself, not only when choosing rows", () => {
    const sql = commandBatchSql("node-1", NOW, 10);
    const text = sql.strings.join("?");
    expect(text).toMatch(/DELETE FROM "agent_commands"[\s\S]*WHERE a\."id" = d\."id" AND a\."status" IN \(/);
    expect(sql.values.filter((v) => v === "ACKED" || v === "FAILED")).toEqual(["ACKED", "FAILED", "ACKED", "FAILED"]);
    expect(sql.values).not.toContain("QUEUED");
    expect(sql.values).not.toContain("SENT");
  });
});

describe("the roll-up statement", () => {
  it("deletes and adds up in one statement, adding into an hour rather than replacing it", () => {
    const text = rollUpBatchSql("node-1", NOW, 10).strings.join("?");
    expect(text).toMatch(/DELETE FROM "usage_records"[\s\S]*RETURNING[\s\S]*INSERT INTO "usage_hourly"[\s\S]*FROM gone/);
    expect(text).toContain(`"bytesUp" = "usage_hourly"."bytesUp" + EXCLUDED."bytesUp"`);
    expect(text).toContain(`MAX("reportedAt") FILTER (WHERE "bytesUp" > 0)`);
    expect(text).toContain(`date_trunc('hour', "reportedAt")`);
  });
});

/** An in-memory stand-in that answers the retention's statements the way
 * the SQL says Postgres does, so the batching around them can be tested. */
type Raw = { id: string; subscriptionId: string; nodeId: string; reportedAt: number; up: bigint; down: bigint };
type Hour = { up: bigint; down: bigint; records: number; last: number; lastUp: number | null };

function world(raw: Raw[], opts: { lockHeld?: boolean; failOn?: string } = {}) {
  const hourly = new Map<string, Hour>();
  const nodes = [...new Set(raw.map((r) => r.nodeId))].sort().map((id) => ({ id, name: `name-${id}` }));
  let batches = 0;
  const cutoffOf = (iso: unknown) => Date.parse(String(iso));
  // Called as a tagged template or with a Prisma.sql object.
  const queryRaw = jest.fn(async (first: any, ...rest: unknown[]) => {
    const sql: { strings: readonly string[]; values: unknown[] } = Array.isArray(first)
      ? { strings: first, values: rest }
      : first;
    const text = sql.strings.join("?");
    if (text.includes("UNION ALL")) {
      const cutoff = cutoffOf(sql.values[0]);
      const out = new Map<string, { up: bigint; down: bigint }>();
      for (const r of raw.filter((r) => r.reportedAt < cutoff)) {
        const t = out.get(r.nodeId) ?? { up: 0n, down: 0n };
        t.up += r.up;
        t.down += r.down;
        out.set(r.nodeId, t);
      }
      for (const [key, h] of hourly) {
        const nodeId = key.split("|")[1];
        const t = out.get(nodeId) ?? { up: 0n, down: 0n };
        t.up += h.up;
        t.down += h.down;
        out.set(nodeId, t);
      }
      return [...out].map(([nodeId, t]) => ({ nodeId, up: String(t.up), down: String(t.down) }));
    }
    if (text.includes("COUNT(DISTINCT")) {
      const [nodeId, iso] = sql.values;
      const rows = raw.filter((r) => r.nodeId === nodeId && r.reportedAt < cutoffOf(iso));
      const hours = new Set(rows.map((r) => `${r.subscriptionId}|${floorToHour(r.reportedAt)}`));
      return [{ rows: rows.length, hours: hours.size, up: "0", down: "0" }];
    }
    throw new Error(`unexpected statement ${text.slice(0, 60)}`);
  });
  const tx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRawUnsafe: jest.fn(async () => [{ locked: !opts.lockHeld }]),
    $queryRaw: jest.fn(async (sql: { strings: readonly string[]; values: unknown[] }) => {
      const [nodeId, iso, batch] = sql.values as [string, string, number];
      if (nodeId === opts.failOn) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      batches += 1;
      const chosen = raw
        .filter((r) => r.nodeId === nodeId && r.reportedAt < cutoffOf(iso))
        .sort((a, b) => a.reportedAt - b.reportedAt)
        .slice(0, batch);
      const keys = new Set<string>();
      for (const r of chosen) {
        raw.splice(raw.indexOf(r), 1);
        const key = `${r.subscriptionId}|${r.nodeId}|${floorToHour(r.reportedAt)}`;
        keys.add(key);
        const h = hourly.get(key) ?? { up: 0n, down: 0n, records: 0, last: 0, lastUp: null };
        h.up += r.up;
        h.down += r.down;
        h.records += 1;
        h.last = Math.max(h.last, r.reportedAt);
        if (r.up > 0n) h.lastUp = Math.max(h.lastUp ?? 0, r.reportedAt);
        hourly.set(key, h);
      }
      const up = chosen.reduce((s, r) => s + r.up, 0n);
      const down = chosen.reduce((s, r) => s + r.down, 0n);
      return [{ rows: chosen.length, hours: keys.size, up: String(up), down: String(down) }];
    }),
  };
  const prisma = {
    node: { findMany: jest.fn(async ({ where }: any) => nodes.filter((n) => !where?.id || where.id.in.includes(n.id))) },
    $queryRaw: queryRaw,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma: prisma as never, raw, hourly, tx, batches: () => batches };
}

const CUTOFF = new Date(Date.UTC(2026, 9, 7, 22));
const C = CUTOFF.getTime();

function sample(): Raw[] {
  let n = 0;
  const row = (nodeId: string, subscriptionId: string, at: number, up: bigint, down: bigint): Raw => ({
    id: `r${++n}`,
    nodeId,
    subscriptionId,
    reportedAt: at,
    up,
    down,
  });
  return [
    row("n1", "s1", C - 3 * HOUR + 5 * 60_000, 10n, 100n),
    row("n1", "s1", C - 3 * HOUR + 40 * 60_000, 20n, 200n),
    row("n1", "s2", C - 3 * HOUR + 60_000, 0n, 888n), // download only: a handshake retry
    row("n1", "s1", C - HOUR - 1, 2n, 20n), // last millisecond of its hour
    row("n1", "s1", C - HOUR, 5n, 50n), // first of the next
    row("n1", "s2", C - 1, 1n, 1n), // the last instant before the cutoff
    row("n1", "s1", C, 7n, 7n), // the cutoff itself: kept
    row("n1", "s1", C + HOUR, 9n, 9n), // younger: kept
    row("n2", "s3", C - 10 * DAY, 3n, 4n),
  ];
}

describe("rollUpUsage", () => {
  it("adds up exactly the rows before the cutoff, by UTC hour, and deletes them", async () => {
    const w = world(sample());
    const result = await rollUpUsage(w.prisma, { cutoff: CUTOFF, batchSize: 2, pauseMs: 0 });

    expect(result.rows).toBe(7);
    expect(w.raw.map((r) => r.reportedAt)).toEqual([C, C + HOUR]);
    const h = (sub: string, node: string, hour: number) => w.hourly.get(`${sub}|${node}|${hour}`);
    expect(h("s1", "n1", C - 3 * HOUR)).toEqual({
      up: 30n,
      down: 300n,
      records: 2,
      last: C - 3 * HOUR + 40 * 60_000,
      lastUp: C - 3 * HOUR + 40 * 60_000,
    });
    // An hour that saw only the server's handshake retries is not "seen".
    expect(h("s2", "n1", C - 3 * HOUR)).toEqual({ up: 0n, down: 888n, records: 1, last: C - 3 * HOUR + 60_000, lastUp: null });
    // Either side of an hour boundary: two hours.
    expect(h("s1", "n1", C - 2 * HOUR)).toEqual({ up: 2n, down: 20n, records: 1, last: C - HOUR - 1, lastUp: C - HOUR - 1 });
    expect(h("s1", "n1", C - HOUR)).toEqual({ up: 5n, down: 50n, records: 1, last: C - HOUR, lastUp: C - HOUR });
    expect(h("s2", "n1", C - HOUR)).toEqual({ up: 1n, down: 1n, records: 1, last: C - 1, lastUp: C - 1 });
    expect(w.hourly.size).toBe(6);
    expect(result.totals?.equal).toBe(true);
    expect(result.totals?.before).toEqual(result.totals?.after);
  });

  it("changes nothing when run a second time", async () => {
    const w = world(sample());
    await rollUpUsage(w.prisma, { cutoff: CUTOFF, batchSize: 2, pauseMs: 0 });
    const hours = JSON.stringify([...w.hourly], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const again = await rollUpUsage(w.prisma, { cutoff: CUTOFF, batchSize: 2, pauseMs: 0 });
    expect(again.rows).toBe(0);
    expect(JSON.stringify([...w.hourly], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(hours);
    expect(w.raw).toHaveLength(2);
  });

  it("stops between batches when asked, and a later run finishes the job with the same sums", async () => {
    const w = world(sample());
    let calls = 0;
    const first = await rollUpUsage(w.prisma, { cutoff: CUTOFF, batchSize: 2, pauseMs: 0, shouldStop: () => ++calls > 1 });
    expect(first.interrupted).toBe(true);
    expect(first.rows).toBe(2);
    await rollUpUsage(w.prisma, { cutoff: CUTOFF, batchSize: 2, pauseMs: 0 });

    const whole = world(sample());
    await rollUpUsage(whole.prisma, { cutoff: CUTOFF, batchSize: 1000, pauseMs: 0 });
    expect([...w.hourly].sort()).toEqual([...whole.hourly].sort());
  });

  it("only counts on a dry run", async () => {
    const w = world(sample());
    const result = await rollUpUsage(w.prisma, { cutoff: CUTOFF, dryRun: true });
    expect(result.rows).toBe(7);
    expect(result.hours).toBe(6);
    expect(w.tx.$queryRaw).not.toHaveBeenCalled();
    expect(w.raw).toHaveLength(9);
  });

  it("leaves a node whose batch times out for the next run, and carries on with the others", async () => {
    const w = world(sample(), { failOn: "n1" });
    const result = await rollUpUsage(w.prisma, { cutoff: CUTOFF, pauseMs: 0 });
    expect(result.nodes.find((n) => n.nodeId === "n1")!.stopped).toMatch(/55P03/);
    expect(result.nodes.find((n) => n.nodeId === "n2")!.rows).toBe(1);
    expect(w.raw).toHaveLength(8);
  });

  it("does nothing while another run holds the lock", async () => {
    const w = world(sample(), { lockHeld: true });
    const result = await rollUpUsage(w.prisma, { cutoff: CUTOFF, pauseMs: 0 });
    expect(result.rows).toBe(0);
    expect(result.interrupted).toBe(true);
    expect(w.batches()).toBe(0);
  });

  it("sets a lock timeout in every batch's transaction", async () => {
    const w = world(sample());
    await rollUpUsage(w.prisma, { cutoff: CUTOFF, pauseMs: 0 });
    expect(w.tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2s'");
  });
});

describe("pruneCommands", () => {
  it("counts finished and kept pending commands on a dry run, deleting nothing", async () => {
    const groupBy = jest.fn(async ({ where }: any) =>
      where.status.in.includes("ACKED")
        ? [
            { status: "ACKED", _count: { _all: 5 } },
            { status: "FAILED", _count: { _all: 1 } },
          ]
        : [{ status: "QUEUED", _count: { _all: 3 } }],
    );
    const prisma = { agentCommand: { groupBy }, $transaction: jest.fn() } as never;
    const result = await pruneCommands(prisma, { cutoff: commandCutoff(NOW), dryRun: true });
    expect(result).toMatchObject({ total: 6, deleted: { ACKED: 5, FAILED: 1 }, keptPending: { QUEUED: 3 } });
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(groupBy.mock.calls[0][0].where.status.in).toEqual(["QUEUED", "SENT"]);
    expect(groupBy.mock.calls[1][0].where.status.in).toEqual(["ACKED", "FAILED"]);
  });

  it("deletes in batches until a short one", async () => {
    const sizes = [3, 3, 1];
    const tx = {
      $executeRawUnsafe: jest.fn(),
      $queryRawUnsafe: jest.fn(async () => [{ locked: true }]),
      $queryRaw: jest.fn(async () => Array.from({ length: sizes.shift() ?? 0 }, () => ({ status: "ACKED" }))),
    };
    const prisma = {
      agentCommand: { groupBy: jest.fn(async () => []) },
      node: { findMany: jest.fn(async () => [{ id: "n1", name: "a" }]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    } as never;
    const result = await pruneCommands(prisma, { cutoff: commandCutoff(NOW), batchSize: 3, pauseMs: 0 });
    expect(result.total).toBe(7);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
});

describe("reading past the days kept", () => {
  const T = NOW.getTime();

  it("reads the detailed rows alone inside them, exactly as before", async () => {
    const prisma = {
      usageRecord: { groupBy: jest.fn(async () => [{ nodeId: "n1", subscriptionId: "s1", _sum: { bytesUp: 99n } }]) },
      usageHourly: { groupBy: jest.fn() },
    } as never;
    const groups = await upstreamGroups(prisma, { nodeIds: ["n1"], start: T - 7 * DAY, end: T - 7 * DAY + 2 * HOUR, now: T, atLeast: 20 });
    expect(groups).toEqual([{ nodeId: "n1", subscriptionId: "s1" }]);
    expect((prisma as any).usageHourly.groupBy).not.toHaveBeenCalled();
    expect((prisma as any).usageRecord.groupBy.mock.calls[0][0].having).toEqual({ bytesUp: { _sum: { gte: 20 } } });
    expect(reachesRollUp(T - 34 * DAY, T)).toBe(false);
    expect(reachesRollUp(T - 35 * DAY, T)).toBe(true);
  });

  it("adds the rolled-up hours whose middle falls in the window before the threshold", async () => {
    const start = T - 40 * DAY;
    const end = start + 2 * HOUR;
    const prisma = {
      usageRecord: { groupBy: jest.fn(async () => [{ nodeId: "n1", subscriptionId: "s1", _sum: { bytesUp: 10n } }]) },
      usageHourly: {
        groupBy: jest.fn(async () => [
          { nodeId: "n1", subscriptionId: "s1", _sum: { bytesUp: 15n } },
          { nodeId: "n1", subscriptionId: "s2", _sum: { bytesUp: 19n } },
        ]),
      },
    } as never;
    const groups = await upstreamGroups(prisma, { nodeIds: ["n1"], start, end, now: T, atLeast: 20 });
    expect(groups).toEqual([{ nodeId: "n1", subscriptionId: "s1" }]);
    expect((prisma as any).usageHourly.groupBy.mock.calls[0][0].where.hourStart).toEqual({
      gte: new Date(start - 30 * 60_000),
      lt: new Date(end - 30 * 60_000),
    });
  });

  it("takes last seen from the newer of the detailed rows and the roll-up, upload only", async () => {
    const older = new Date(T - 50 * DAY);
    const newer = new Date(T - 40 * DAY);
    const prisma = {
      usageRecord: { findFirst: jest.fn(async () => ({ reportedAt: older })) },
      usageHourly: { aggregate: jest.fn(async () => ({ _max: { lastUpAt: newer } })) },
    } as never;
    expect(await lastUpstreamAt(prisma, "s1")).toEqual(newer);
    expect((prisma as any).usageRecord.findFirst.mock.calls[0][0].where).toEqual({ subscriptionId: "s1", bytesUp: { gt: 0 } });
    expect((prisma as any).usageHourly.aggregate.mock.calls[0][0].where).toEqual({ subscriptionId: "s1", lastUpAt: { not: null } });
  });
});

describe("switches", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["ON", "on"],
    [" dry ", "dry"],
    ["yes", "off"],
  ])("DATA_RETENTION=%j is %s", (raw, mode) => {
    expect(parseDataRetentionMode(raw)).toBe(mode);
  });

  it("the command line is a dry run unless --run is given", () => {
    expect(parseArgs([]).run).toBe(false);
    expect(parseArgs(["--run"]).run).toBe(true);
    expect(parseArgs(["--only", "commands", "--batch", "100", "--node", "uk-1"])).toEqual({
      run: false,
      only: "commands",
      batch: 100,
      nodes: ["uk-1"],
    });
    expect(() => parseArgs(["--only", "all"])).toThrow();
    expect(() => parseArgs(["--vacuum"])).toThrow();
  });
});
