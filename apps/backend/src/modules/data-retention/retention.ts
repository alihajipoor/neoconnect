import { AgentCommandStatus, BlockIncidentStatus, Prisma, PrismaClient } from "@prisma/client";
import { MAX_DAYS } from "../account-activity/daily-usage.service";
import { MAX_AHEAD_OF_UTC_MS } from "../account-activity/daily-usage";
import { BlockTuning } from "../block-watch/block-signals";
import { REOPEN_WITHIN_MS } from "../block-watch/block-watch.service";
import { TRAFFIC_DAYS } from "../customer-activity/customer-activity.service";
import { SESSION_IDLE_LIFETIME_MS } from "../customer-auth/session-lifetime";
import { COMMAND_KEEP_DAYS, USAGE_KEEP_DAYS } from "./retention-constants";

export { COMMAND_KEEP_DAYS, ROLLED_UP_BEFORE_MS, USAGE_KEEP_DAYS } from "./retention-constants";

/** The database retention the owner approved on 2026-11-11
 * (docs/usage-retention.md):
 *
 * - usage_records: the detailed rows are kept 35 days. Older ones are
 *   added up into usage_hourly, one row per subscription, node and UTC
 *   hour, kept forever, and deleted in the same transaction.
 * - agent_commands: finished commands (ACKED, FAILED) older than 7 days
 *   are deleted. QUEUED and SENT never are -- among them the pending
 *   removals of retired servers, kept on purpose.
 *
 * Space comes back through plain VACUUM and REINDEX CONCURRENTLY, run by
 * an operator; never VACUUM FULL, whose exclusive lock would stall every
 * stats write and drop every node's stream. Nothing here vacuums.
 *
 * Plain functions over a PrismaClient, so the backend's nightly job and
 * the command-line entry (src/cli/data-retention.ts) run the same code. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The command statuses that are finished: nothing replays them (replay
 * reads QUEUED and SENT), and a late ack for a deleted one is ignored.
 * Every status is in exactly one of these two lists; a spec holds that,
 * so a new one has to be decided on. */
export const FINISHED_COMMAND_STATUSES = [AgentCommandStatus.ACKED, AgentCommandStatus.FAILED] as const;
export const PENDING_COMMAND_STATUSES = [AgentCommandStatus.QUEUED, AgentCommandStatus.SENT] as const;

const USAGE_LOCK = 7_461_011;
const COMMAND_LOCK = 7_461_012;
const LOCK_TIMEOUT = "2s";
const STATEMENT_TIMEOUT = "120s";
export const DEFAULT_USAGE_BATCH = 5_000;
export const DEFAULT_COMMAND_BATCH = 5_000;

export type Log = (message: string) => void;

export interface KeepReason {
  reader: string;
  ms: number;
}

/** How far back each reader of usage_records reaches, so the days kept
 * are never fewer than one of them needs. Readers that look back an hour
 * or a day (Live, ISP recommendations, the fleet tool) are under all of
 * these and left out. */
export function usageReaders(tuning: BlockTuning): KeepReason[] {
  const margin = Math.max(tuning.trafficWindow, tuning.recentWindow);
  return [
    { reader: "owner's rule", ms: USAGE_KEEP_DAYS * DAY_MS },
    // The apps' daily history: up to 31 local days, from before the first
    // local midnight in the zone furthest ahead of UTC.
    { reader: "daily usage history", ms: MAX_DAYS * DAY_MS + MAX_AHEAD_OF_UTC_MS + DAY_MS },
    { reader: "customer profile traffic", ms: TRAFFIC_DAYS * DAY_MS + DAY_MS },
    // An idle device's credentials are reclaimed when no row of its own
    // is this recent; the roll-up does not keep the credential.
    { reader: "idle device sweep", ms: SESSION_IDLE_LIFETIME_MS + DAY_MS },
    // The block watch's baseline, with BLOCK_WATCH_TUNING applied.
    { reader: "block watch baseline", ms: tuning.baselineWindow + margin + tuning.trafficWindow + DAY_MS },
  ];
}

/** The reach of the block watch for an incident that began at `anchor`:
 * it compares against the days before it began (loadTraffic,
 * loadCarriedBefore). Both read the roll-up as well for windows past the
 * days kept, so this is a second guard, not the only one: while such an
 * incident is open the detailed rows stay. */
export function incidentReach(anchor: number, now: number, tuning: BlockTuning): number {
  const margin = Math.max(tuning.trafficWindow, tuning.recentWindow);
  return Math.max(0, now - anchor) + margin + tuning.baselineWindow + tuning.trafficWindow + DAY_MS;
}

export function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export interface UsageCutoff {
  cutoff: Date;
  keepMs: number;
  /** What set it: the reader that needs the most. */
  reason: string;
}

/** The usage cutoff: the longest reach of any reader, the owner's 35
 * days at the least, rounded down to the UTC hour so no hour is ever
 * split between the detailed rows and the roll-up. */
export async function usageCutoff(prisma: PrismaClient, now: Date, tuning: BlockTuning): Promise<UsageCutoff> {
  const t = now.getTime();
  const reasons = usageReaders(tuning);
  // The oldest incident the block watch still compares against: one open,
  // or one cleared recently enough to be reopened.
  const oldest = await prisma.blockIncident.findFirst({
    where: {
      OR: [
        { status: BlockIncidentStatus.OPEN },
        { status: BlockIncidentStatus.CLEARED, closedAt: { gte: new Date(t - REOPEN_WITHIN_MS) } },
      ],
    },
    orderBy: { openedAt: "asc" },
    select: { openedAt: true },
  });
  if (oldest) reasons.push({ reader: "open block incident", ms: incidentReach(oldest.openedAt.getTime(), t, tuning) });
  const top = reasons.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { cutoff: new Date(floorToHour(t - top.ms)), keepMs: top.ms, reason: top.reader };
}

export function commandCutoff(now: Date): Date {
  return new Date(now.getTime() - COMMAND_KEEP_DAYS * DAY_MS);
}

export interface NodeUsageResult {
  nodeId: string;
  name: string;
  rows: number;
  hours: number;
  bytesUp: bigint;
  bytesDown: bigint;
  batches: number;
  /** Why this node stopped early, if it did: a lock it could not get
   * within the timeout, or an error. Its rows stay for the next run. */
  stopped?: string;
}

export interface UsageRunResult {
  dryRun: boolean;
  cutoff: Date;
  nodes: NodeUsageResult[];
  rows: number;
  hours: number;
  /** Raw rows before the cutoff plus rolled-up hours, per node, before
   * and after: equal when nothing was lost or counted twice. Absent on a
   * dry run. */
  totals?: { before: NodeTotals; after: NodeTotals; equal: boolean };
  interrupted: boolean;
}

export type NodeTotals = Record<string, { up: string; down: string }>;

export interface UsageRunOptions {
  cutoff: Date;
  dryRun?: boolean;
  /** Only these nodes. Every node when absent. */
  nodeIds?: string[];
  batchSize?: number;
  pauseMs?: number;
  /** Checked between batches: true stops the run cleanly. */
  shouldStop?: () => boolean;
  /** Skip the before/after totals (they read the rows before the
   * cutoff twice). */
  skipTotals?: boolean;
  log?: Log;
}

const cutoffSql = (cutoff: Date) => Prisma.sql`(${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** One batch for one node, as one statement in one transaction: the
 * oldest `batch` detailed rows before the cutoff are deleted, and what
 * the DELETE returned is added into their hours. A row is either still
 * in usage_records, not yet counted, or deleted and counted by the same
 * statement -- so a run stopped anywhere, or run twice, can neither lose
 * a row nor count one twice. The ON CONFLICT adds rather than replaces
 * because an hour can be filled by more than one batch. */
export function rollUpBatchSql(nodeId: string, cutoff: Date, batch: number): Prisma.Sql {
  return Prisma.sql`
    WITH doomed AS (
      SELECT "id" FROM "usage_records"
      WHERE "nodeId" = ${nodeId} AND "reportedAt" < ${cutoffSql(cutoff)}
      ORDER BY "reportedAt"
      LIMIT ${batch}
    ), gone AS (
      DELETE FROM "usage_records" u USING doomed d
      WHERE u."id" = d."id"
      RETURNING u."subscriptionId", u."nodeId", u."reportedAt", u."bytesUp", u."bytesDown"
    ), summed AS (
      INSERT INTO "usage_hourly"
        ("subscriptionId", "nodeId", "hourStart", "bytesUp", "bytesDown", "records", "lastReportedAt", "lastUpAt")
      SELECT "subscriptionId", "nodeId", date_trunc('hour', "reportedAt"),
             SUM("bytesUp")::bigint, SUM("bytesDown")::bigint, COUNT(*)::int,
             MAX("reportedAt"), MAX("reportedAt") FILTER (WHERE "bytesUp" > 0)
      FROM gone
      GROUP BY 1, 2, 3
      ON CONFLICT ("subscriptionId", "nodeId", "hourStart") DO UPDATE SET
        "bytesUp" = "usage_hourly"."bytesUp" + EXCLUDED."bytesUp",
        "bytesDown" = "usage_hourly"."bytesDown" + EXCLUDED."bytesDown",
        "records" = "usage_hourly"."records" + EXCLUDED."records",
        "lastReportedAt" = GREATEST("usage_hourly"."lastReportedAt", EXCLUDED."lastReportedAt"),
        "lastUpAt" = GREATEST("usage_hourly"."lastUpAt", EXCLUDED."lastUpAt")
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM gone)::int AS "rows",
           (SELECT COUNT(*) FROM summed)::int AS "hours",
           (SELECT COALESCE(SUM("bytesUp"), 0) FROM gone)::text AS "up",
           (SELECT COALESCE(SUM("bytesDown"), 0) FROM gone)::text AS "down"`;
}

interface BatchRow {
  rows: number;
  hours: number;
  up: string;
  down: string;
}

/** Runs `work` in a transaction with a lock timeout, a statement timeout
 * and the job's advisory lock. Null when another run holds the lock. */
async function guarded<T>(
  prisma: PrismaClient,
  lockKey: number,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock(${lockKey}) AS "locked"`,
      );
      if (!lock?.locked) return null;
      return work(tx);
    },
    { maxWait: 10_000, timeout: 180_000 },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw rows before the cutoff plus every rolled-up hour (all of which are
 * before it), per node. */
export async function usageTotals(prisma: PrismaClient, cutoff: Date, nodeIds?: string[]): Promise<NodeTotals> {
  const rawScope = nodeIds ? Prisma.sql`AND "nodeId" IN (${Prisma.join(nodeIds)})` : Prisma.empty;
  const hourScope = nodeIds ? Prisma.sql`AND "nodeId" IN (${Prisma.join(nodeIds)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ nodeId: string; up: string; down: string }[]>(Prisma.sql`
    SELECT "nodeId", SUM("up")::text AS "up", SUM("down")::text AS "down" FROM (
      SELECT "nodeId", "bytesUp" AS "up", "bytesDown" AS "down" FROM "usage_records"
      WHERE "reportedAt" < ${cutoffSql(cutoff)} ${rawScope}
      UNION ALL
      SELECT "nodeId", "bytesUp", "bytesDown" FROM "usage_hourly"
      WHERE "hourStart" < ${cutoffSql(cutoff)} ${hourScope}
    ) t
    GROUP BY 1`);
  const out: NodeTotals = {};
  for (const r of rows) out[r.nodeId] = { up: r.up ?? "0", down: r.down ?? "0" };
  return out;
}

function sameTotals(a: NodeTotals, b: NodeTotals): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k]?.up !== b[k]?.up || a[k]?.down !== b[k]?.down) return false;
  }
  return true;
}

/** Rolls usage_records before the cutoff up into usage_hourly and
 * deletes them, node by node, a batch per transaction. A dry run only
 * counts. */
export async function rollUpUsage(prisma: PrismaClient, options: UsageRunOptions): Promise<UsageRunResult> {
  const { cutoff, dryRun = false, batchSize = DEFAULT_USAGE_BATCH, pauseMs = 100, log = () => {} } = options;
  const shouldStop = options.shouldStop ?? (() => false);
  const nodes = await prisma.node.findMany({
    where: options.nodeIds ? { id: { in: options.nodeIds } } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const result: UsageRunResult = { dryRun, cutoff, nodes: [], rows: 0, hours: 0, interrupted: false };

  if (dryRun) {
    for (const node of nodes) {
      const [row] = await prisma.$queryRaw<BatchRow[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "rows",
               COUNT(DISTINCT ("subscriptionId", date_trunc('hour', "reportedAt")))::int AS "hours",
               COALESCE(SUM("bytesUp"), 0)::text AS "up",
               COALESCE(SUM("bytesDown"), 0)::text AS "down"
        FROM "usage_records"
        WHERE "nodeId" = ${node.id} AND "reportedAt" < ${cutoffSql(cutoff)}`);
      const entry = {
        nodeId: node.id,
        name: node.name,
        rows: row?.rows ?? 0,
        hours: row?.hours ?? 0,
        bytesUp: BigInt(row?.up ?? "0"),
        bytesDown: BigInt(row?.down ?? "0"),
        batches: 0,
      };
      result.nodes.push(entry);
      result.rows += entry.rows;
      result.hours += entry.hours;
    }
    return result;
  }

  const before = options.skipTotals ? undefined : await usageTotals(prisma, cutoff, options.nodeIds);
  for (const node of nodes) {
    const entry: NodeUsageResult = {
      nodeId: node.id,
      name: node.name,
      rows: 0,
      hours: 0,
      bytesUp: 0n,
      bytesDown: 0n,
      batches: 0,
    };
    result.nodes.push(entry);
    for (;;) {
      if (shouldStop()) {
        result.interrupted = true;
        break;
      }
      let row: BatchRow | null | undefined;
      try {
        row = await guarded(prisma, USAGE_LOCK, async (tx) => {
          const [r] = await tx.$queryRaw<BatchRow[]>(rollUpBatchSql(node.id, cutoff, batchSize));
          return r;
        });
      } catch (err) {
        entry.stopped = describe(err);
        log(`usage ${node.name}: stopped after ${entry.rows} rows: ${entry.stopped}`);
        break;
      }
      if (row === null) {
        entry.stopped = "another retention run holds the lock";
        result.interrupted = true;
        log(`usage: ${entry.stopped}; stopping`);
        break;
      }
      if (!row || row.rows === 0) break;
      entry.rows += row.rows;
      entry.hours += row.hours;
      entry.bytesUp += BigInt(row.up);
      entry.bytesDown += BigInt(row.down);
      entry.batches += 1;
      if (row.rows < batchSize) break;
      if (pauseMs > 0) await sleep(pauseMs);
    }
    result.rows += entry.rows;
    result.hours += entry.hours;
    if (entry.rows > 0) log(`usage ${node.name}: ${entry.rows} rows into ${entry.hours} hour updates`);
    if (result.interrupted) break;
  }
  if (before) {
    const after = await usageTotals(prisma, cutoff, options.nodeIds);
    result.totals = { before, after, equal: sameTotals(before, after) };
  }
  return result;
}

export interface CommandRunResult {
  dryRun: boolean;
  cutoff: Date;
  /** Deleted, or on a dry run that would be, per finished status. */
  deleted: Record<string, number>;
  /** Pending commands older than the cutoff, kept by rule, per status. */
  keptPending: Record<string, number>;
  total: number;
  interrupted: boolean;
  stopped?: string;
}

export interface CommandRunOptions {
  cutoff: Date;
  dryRun?: boolean;
  nodeIds?: string[];
  batchSize?: number;
  pauseMs?: number;
  shouldStop?: () => boolean;
  log?: Log;
}

const finishedSql = Prisma.join(FINISHED_COMMAND_STATUSES.map((s) => Prisma.sql`${s}::"AgentCommandStatus"`));

/** One batch of finished commands older than the cutoff. The status is
 * checked again in the DELETE itself, so nothing that is not finished at
 * the moment it is deleted can go. A status never moves back from
 * finished (QUEUED -> SENT -> ACKED | FAILED). */
export function commandBatchSql(nodeId: string, cutoff: Date, batch: number): Prisma.Sql {
  return Prisma.sql`
    WITH doomed AS (
      SELECT "id" FROM "agent_commands"
      WHERE "nodeId" = ${nodeId} AND "status" IN (${finishedSql}) AND "createdAt" < ${cutoffSql(cutoff)}
      LIMIT ${batch}
    )
    DELETE FROM "agent_commands" a USING doomed d
    WHERE a."id" = d."id" AND a."status" IN (${finishedSql})
    RETURNING a."status"::text AS "status"`;
}

/** Deletes finished agent_commands older than the cutoff, node by node, a
 * batch per transaction. A dry run only counts. */
export async function pruneCommands(prisma: PrismaClient, options: CommandRunOptions): Promise<CommandRunResult> {
  const { cutoff, dryRun = false, batchSize = DEFAULT_COMMAND_BATCH, pauseMs = 50, log = () => {} } = options;
  const shouldStop = options.shouldStop ?? (() => false);
  const scope = options.nodeIds ? { nodeId: { in: options.nodeIds } } : {};
  const pending = await prisma.agentCommand.groupBy({
    by: ["status"],
    where: { ...scope, status: { in: [...PENDING_COMMAND_STATUSES] }, createdAt: { lt: cutoff } },
    _count: { _all: true },
  });
  const keptPending: Record<string, number> = {};
  for (const p of pending) keptPending[p.status] = p._count._all;
  const result: CommandRunResult = { dryRun, cutoff, deleted: {}, keptPending, total: 0, interrupted: false };

  if (dryRun) {
    const finished = await prisma.agentCommand.groupBy({
      by: ["status"],
      where: { ...scope, status: { in: [...FINISHED_COMMAND_STATUSES] }, createdAt: { lt: cutoff } },
      _count: { _all: true },
    });
    for (const f of finished) {
      result.deleted[f.status] = f._count._all;
      result.total += f._count._all;
    }
    return result;
  }

  const nodes = await prisma.node.findMany({
    where: options.nodeIds ? { id: { in: options.nodeIds } } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  outer: for (const node of nodes) {
    for (;;) {
      if (shouldStop()) {
        result.interrupted = true;
        break outer;
      }
      let rows: { status: string }[] | null;
      try {
        rows = await guarded(prisma, COMMAND_LOCK, (tx) =>
          tx.$queryRaw<{ status: string }[]>(commandBatchSql(node.id, cutoff, batchSize)),
        );
      } catch (err) {
        result.stopped = `${node.name}: ${describe(err)}`;
        log(`commands ${result.stopped}`);
        break;
      }
      if (rows === null) {
        result.stopped = "another retention run holds the lock";
        result.interrupted = true;
        break outer;
      }
      for (const r of rows) result.deleted[r.status] = (result.deleted[r.status] ?? 0) + 1;
      result.total += rows.length;
      if (rows.length < batchSize) break;
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }
  if (result.total > 0) log(`commands: deleted ${result.total} finished command(s)`);
  return result;
}

/** An error's code and first line -- never the statement or its values. */
function describe(err: unknown): string {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  const code = e?.meta?.code ?? e?.code;
  const first = (e?.message ?? String(err)).split("\n").filter(Boolean).pop() ?? "error";
  return code ? `${code}: ${first.slice(0, 160)}` : first.slice(0, 160);
}
