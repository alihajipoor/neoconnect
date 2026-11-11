import { Prisma, PrismaClient } from "@prisma/client";
import { ROLLED_UP_BEFORE_MS } from "./retention-constants";

/** Reads of usage that may reach past the days of detail kept, and so
 * into usage_hourly (docs/usage-retention.md). A rolled-up hour is
 * counted when its middle falls inside the window: for a window that
 * does not start or end on the hour that is the nearest the roll-up can
 * say, so such counts are approximate past the days kept, and exact
 * inside them. */

type UsagePrisma = Pick<PrismaClient, "usageRecord" | "usageHourly">;

const HALF_HOUR_MS = 30 * 60_000;

/** Whether a window that starts at `start` can reach a rolled-up hour. */
export function reachesRollUp(start: number, now: number): boolean {
  return start < now - ROLLED_UP_BEFORE_MS;
}

export interface UpstreamQuery {
  nodeIds: string[];
  subscriptionIds?: string[];
  start: number;
  end: number;
  now: number;
  /** Groups whose upstream in the window is at least this. */
  atLeast: number;
}

/** (node, subscription) pairs that sent at least `atLeast` bytes upstream
 * in [start, end). Inside the days kept this is the one grouped query it
 * always was; further back the detailed rows and the roll-up are added
 * before the threshold is applied. */
export async function upstreamGroups(
  prisma: UsagePrisma,
  q: UpstreamQuery,
): Promise<{ nodeId: string; subscriptionId: string }[]> {
  const subscriptionScope = q.subscriptionIds ? { subscriptionId: { in: q.subscriptionIds } } : {};
  const rawWhere: Prisma.UsageRecordWhereInput = {
    nodeId: { in: q.nodeIds },
    ...subscriptionScope,
    reportedAt: { gte: new Date(q.start), lt: new Date(q.end) },
  };
  if (!reachesRollUp(q.start, q.now)) {
    const groups = await prisma.usageRecord.groupBy({
      by: ["nodeId", "subscriptionId"],
      where: rawWhere,
      _sum: { bytesUp: true },
      having: { bytesUp: { _sum: { gte: q.atLeast } } },
    });
    return groups.map(({ nodeId, subscriptionId }) => ({ nodeId, subscriptionId }));
  }
  const [raw, hourly] = await Promise.all([
    prisma.usageRecord.groupBy({ by: ["nodeId", "subscriptionId"], where: rawWhere, _sum: { bytesUp: true } }),
    prisma.usageHourly.groupBy({
      by: ["nodeId", "subscriptionId"],
      where: {
        nodeId: { in: q.nodeIds },
        ...subscriptionScope,
        hourStart: { gte: new Date(q.start - HALF_HOUR_MS), lt: new Date(q.end - HALF_HOUR_MS) },
      },
      _sum: { bytesUp: true },
    }),
  ]);
  const sums = new Map<string, { nodeId: string; subscriptionId: string; up: bigint }>();
  for (const g of [...raw, ...hourly]) {
    const key = `${g.nodeId}\u0000${g.subscriptionId}`;
    const entry = sums.get(key) ?? { nodeId: g.nodeId, subscriptionId: g.subscriptionId, up: 0n };
    entry.up += BigInt(g._sum.bytesUp ?? 0);
    sums.set(key, entry);
  }
  const atLeast = BigInt(Math.ceil(q.atLeast));
  return [...sums.values()]
    .filter((s) => s.up >= atLeast)
    .map(({ nodeId, subscriptionId }) => ({ nodeId, subscriptionId }));
}

/** The newest time the device sent something (bytesUp > 0) on this
 * subscription: the newer of the detailed rows' and the rolled-up hours',
 * whose lastUpAt keeps the same meaning. Both, not one as a fallback: a
 * node whose roll-up stopped early can leave detailed rows older than
 * another node's rolled-up hours. */
export async function lastUpstreamAt(prisma: UsagePrisma, subscriptionId: string): Promise<Date | null> {
  const [raw, hourly] = await Promise.all([
    prisma.usageRecord.findFirst({
      where: { subscriptionId, bytesUp: { gt: 0 } },
      orderBy: { reportedAt: "desc" },
      select: { reportedAt: true },
    }),
    prisma.usageHourly.aggregate({
      where: { subscriptionId, lastUpAt: { not: null } },
      _max: { lastUpAt: true },
    }),
  ]);
  const times = [raw?.reportedAt, hourly._max.lastUpAt].filter((d): d is Date => !!d).map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}
