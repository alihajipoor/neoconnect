import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_TUNING } from "../block-watch/block-signals";
import { assertClock, floorToHour, pruneCommands, rollUpUsage, usageCutoff, USAGE_KEEP_DAYS } from "./retention";
import { lastUpstreamAt, upstreamGroups } from "./usage-reads";

/** The retention's SQL against a real, migrated Postgres: the DELETE ...
 * RETURNING feeding the hourly INSERT in one statement, the UTC hour of a
 * TIMESTAMP(3), the additive ON CONFLICT, the upload-only lastUpAt, the
 * finished-status check in the DELETE, and the cascades of the new
 * table. retention.spec.ts covers the batching on a stand-in.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * applying every migration to the job's empty database. Never point it at
 * a database that matters: it writes rows, and removes only the ones it
 * wrote. Every run is limited to its own nodes. */

const enabled = process.env.NEOXIFY_DB_SPECS === "1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

(enabled ? describe : describe.skip)("data retention against Postgres", () => {
  let prisma: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const now = Date.now();
  // An hour well past the days kept, as the job would choose it.
  const C = floorToHour(now - 40 * DAY);
  const cutoff = new Date(C);
  const ids = { customer: "", plan: "", node: "", other: "", sub: "", sub2: "", gone: "" };

  const usage = (nodeId: string, subscriptionId: string, at: number, up: bigint, down: bigint) => ({
    nodeId,
    subscriptionId,
    periodStart: new Date(at - 30_000),
    periodEnd: new Date(at),
    reportedAt: new Date(at),
    bytesUp: up,
    bytesDown: down,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    const customer = await prisma.customer.create({ data: { email: `dr-${tag}@example.test` }, select: { id: true } });
    const plan = await prisma.subscriptionPlan.create({ data: { name: `dr-${tag}`, durationDays: 30, priceUsd: 1 } });
    const node = await prisma.node.create({ data: { name: `dr-${tag}`, region: "test", publicIp: "192.0.2.31" } });
    const other = await prisma.node.create({ data: { name: `dr-${tag}-b`, region: "test", publicIp: "192.0.2.32" } });
    const expireAt = new Date(now + 30 * DAY);
    const sub = await prisma.subscription.create({ data: { customerId: customer.id, planId: plan.id, expireAt } });
    const sub2 = await prisma.subscription.create({ data: { customerId: customer.id, planId: plan.id, expireAt } });
    const gone = await prisma.subscription.create({ data: { customerId: customer.id, planId: plan.id, expireAt } });
    Object.assign(ids, { customer: customer.id, plan: plan.id, node: node.id, other: other.id, sub: sub.id, sub2: sub2.id, gone: gone.id });

    await prisma.usageRecord.createMany({
      data: [
        usage(node.id, sub.id, C - 3 * HOUR + 5 * MIN, 10n, 100n),
        usage(node.id, sub.id, C - 3 * HOUR + 40 * MIN, 20n, 9_007_199_254_740_993n),
        // Download only: the server's handshake retries to a gone peer.
        usage(node.id, sub2.id, C - 3 * HOUR + MIN, 0n, 888n),
        // Either side of an hour boundary, to the millisecond.
        usage(node.id, sub.id, C - HOUR - 1, 2n, 20n),
        usage(node.id, sub.id, C - HOUR, 5n, 50n),
        usage(node.id, sub2.id, C - 1, 1n, 1n),
        // The cutoff itself, and younger: never touched.
        usage(node.id, sub.id, C, 7n, 7n),
        usage(node.id, sub.id, now - MIN, 9n, 9n),
        // Another node, not in this run.
        usage(other.id, sub.id, C - 2 * DAY, 3n, 4n),
        // A subscription that is deleted below.
        usage(other.id, gone.id, C - 2 * DAY, 1n, 1n),
      ],
    });
  });

  afterAll(async () => {
    if (ids.node) {
      for (const nodeId of [ids.node, ids.other]) {
        await prisma.usageRecord.deleteMany({ where: { nodeId } });
        await prisma.usageHourly.deleteMany({ where: { nodeId } });
        await prisma.agentCommand.deleteMany({ where: { nodeId } });
      }
      await prisma.subscription.deleteMany({ where: { customerId: ids.customer } });
      await prisma.node.deleteMany({ where: { id: { in: [ids.node, ids.other] } } });
      await prisma.subscriptionPlan.delete({ where: { id: ids.plan } });
      await prisma.customer.delete({ where: { id: ids.customer } });
    }
    await prisma.$disconnect();
  });

  it("chooses a cutoff on the hour, at least 35 days back", async () => {
    const cut = await usageCutoff(prisma, new Date(now), DEFAULT_TUNING);
    expect(cut.cutoff.getTime() % HOUR).toBe(0);
    expect(cut.cutoff.getTime()).toBeLessThanOrEqual(now - USAGE_KEEP_DAYS * DAY);
  });

  it("counts on a dry run and changes nothing", async () => {
    const r = await rollUpUsage(prisma, { cutoff, dryRun: true, nodeIds: [ids.node] });
    expect(r.rows).toBe(6);
    expect(r.hours).toBe(5);
    expect(await prisma.usageRecord.count({ where: { nodeId: ids.node } })).toBe(8);
    expect(await prisma.usageHourly.count({ where: { nodeId: ids.node } })).toBe(0);
  });

  it("adds up exactly the rows before the cutoff by UTC hour, deleting them, in batches", async () => {
    const r = await rollUpUsage(prisma, { cutoff, nodeIds: [ids.node], batchSize: 2, pauseMs: 0 });
    expect(r.rows).toBe(6);
    expect(r.nodes[0].batches).toBe(3);
    expect(r.totals?.equal).toBe(true);

    const left = await prisma.usageRecord.findMany({ where: { nodeId: ids.node }, select: { reportedAt: true }, orderBy: { reportedAt: "asc" } });
    expect(left.map((l) => l.reportedAt.getTime())).toEqual([C, now - MIN]);
    expect(await prisma.usageRecord.count({ where: { nodeId: ids.other } })).toBe(2);

    const hours = await prisma.usageHourly.findMany({ where: { nodeId: ids.node }, orderBy: [{ hourStart: "asc" }, { subscriptionId: "asc" }] });
    const view = hours.map((h) => ({
      sub: h.subscriptionId === ids.sub ? "sub" : "sub2",
      hour: (h.hourStart.getTime() - C) / HOUR,
      up: h.bytesUp,
      down: h.bytesDown,
      records: h.records,
      last: h.lastReportedAt.getTime() - C,
      lastUp: h.lastUpAt ? h.lastUpAt.getTime() - C : null,
    }));
    expect(view).toEqual(
      expect.arrayContaining([
        // Two batches filled this hour; the second added to the first.
        { sub: "sub", hour: -3, up: 30n, down: 9_007_199_254_741_093n, records: 2, last: -3 * HOUR + 40 * MIN, lastUp: -3 * HOUR + 40 * MIN },
        { sub: "sub2", hour: -3, up: 0n, down: 888n, records: 1, last: -3 * HOUR + MIN, lastUp: null },
        { sub: "sub", hour: -2, up: 2n, down: 20n, records: 1, last: -HOUR - 1, lastUp: -HOUR - 1 },
        { sub: "sub", hour: -1, up: 5n, down: 50n, records: 1, last: -HOUR, lastUp: -HOUR },
        { sub: "sub2", hour: -1, up: 1n, down: 1n, records: 1, last: -1, lastUp: -1 },
      ]),
    );
    expect(view).toHaveLength(5);
  });

  it("changes nothing when run again", async () => {
    const before = await prisma.usageHourly.findMany({ where: { nodeId: ids.node }, orderBy: [{ hourStart: "asc" }, { subscriptionId: "asc" }] });
    const r = await rollUpUsage(prisma, { cutoff, nodeIds: [ids.node], pauseMs: 0 });
    expect(r.rows).toBe(0);
    expect(r.totals?.equal).toBe(true);
    const after = await prisma.usageHourly.findMany({ where: { nodeId: ids.node }, orderBy: [{ hourStart: "asc" }, { subscriptionId: "asc" }] });
    expect(after).toEqual(before);
  });

  it("keeps last seen, upload only, once the detailed rows are gone", async () => {
    // sub2's newest upload is the 1 byte just before the cutoff; its
    // download-only hour must not count.
    expect(await lastUpstreamAt(prisma, ids.sub2)).toEqual(new Date(C - 1));
    // sub still has detailed rows, which are newer.
    expect(await lastUpstreamAt(prisma, ids.sub)).toEqual(new Date(now - MIN));
  });

  it("counts rolled-up hours in an old window, by the hour's middle", async () => {
    const groups = await upstreamGroups(prisma, {
      nodeIds: [ids.node],
      start: C - 3 * HOUR,
      end: C - 2 * HOUR,
      now,
      atLeast: 25,
    });
    expect(groups).toEqual([{ nodeId: ids.node, subscriptionId: ids.sub }]);
  });

  it("takes rolled-up hours with their subscription and node", async () => {
    await rollUpUsage(prisma, { cutoff, nodeIds: [ids.other], pauseMs: 0 });
    expect(await prisma.usageHourly.count({ where: { subscriptionId: ids.gone } })).toBe(1);
    await prisma.subscription.delete({ where: { id: ids.gone } });
    expect(await prisma.usageHourly.count({ where: { subscriptionId: ids.gone } })).toBe(0);

    expect(await prisma.usageHourly.count({ where: { nodeId: ids.other } })).toBe(1);
    await prisma.node.delete({ where: { id: ids.other } });
    expect(await prisma.usageHourly.count({ where: { nodeId: ids.other } })).toBe(0);
    ids.other = ids.node;
  });

  it("deletes finished commands older than the cutoff, and never a queued or sent one", async () => {
    const old = new Date(now - 10 * DAY);
    const fresh = new Date(now - DAY);
    const make = (status: "QUEUED" | "SENT" | "ACKED" | "FAILED", createdAt: Date) =>
      prisma.agentCommand.create({
        data: { nodeId: ids.node, type: "DELETE_USER", payloadJson: { externalUserId: `dr-${tag}` }, status, createdAt },
        select: { id: true, status: true, createdAt: true },
      });
    const rows = [
      await make("QUEUED", old),
      await make("SENT", old),
      await make("ACKED", old),
      await make("FAILED", old),
      await make("ACKED", old),
      await make("ACKED", fresh),
      await make("QUEUED", fresh),
    ];
    const commandCut = new Date(now - 7 * DAY);

    const dry = await pruneCommands(prisma, { cutoff: commandCut, dryRun: true, nodeIds: [ids.node] });
    expect(dry).toMatchObject({ total: 3, deleted: { ACKED: 2, FAILED: 1 }, keptPending: { QUEUED: 1, SENT: 1 } });
    expect(await prisma.agentCommand.count({ where: { nodeId: ids.node } })).toBe(7);

    const real = await pruneCommands(prisma, { cutoff: commandCut, nodeIds: [ids.node], batchSize: 2, pauseMs: 0 });
    expect(real.total).toBe(3);
    const left = await prisma.agentCommand.findMany({ where: { nodeId: ids.node }, select: { id: true } });
    const kept = rows.filter((r) => !(r.createdAt < commandCut && (r.status === "ACKED" || r.status === "FAILED")));
    expect(left.map((l) => l.id).sort()).toEqual(kept.map((k) => k.id).sort());

    const again = await pruneCommands(prisma, { cutoff: commandCut, nodeIds: [ids.node], pauseMs: 0 });
    expect(again.total).toBe(0);
  });

  it("skips a row another transaction holds instead of waiting on it", async () => {
    const held = await prisma.usageRecord.create({ data: usage(ids.node, ids.sub, C - 5 * HOUR, 4n, 4n), select: { id: true } });
    await prisma.usageRecord.create({ data: usage(ids.node, ids.sub, C - 5 * HOUR + MIN, 6n, 6n) });
    const started = Date.now();
    const during = await prisma.$transaction(
      async (tx) => {
        // What a credential's delete does to its old rows (ON DELETE SET NULL).
        await tx.$executeRaw`UPDATE "usage_records" SET "protocolUserId" = NULL WHERE "id" = ${held.id}`;
        return rollUpUsage(prisma, { cutoff, nodeIds: [ids.node], pauseMs: 0, skipTotals: true });
      },
      { timeout: 30_000 },
    );
    expect(during.rows).toBe(1);
    expect(during.nodes[0].stopped).toBeUndefined();
    // No lock wait: lock_timeout is 2 s.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await prisma.usageRecord.count({ where: { id: held.id } })).toBe(1);

    const after = await rollUpUsage(prisma, { cutoff, nodeIds: [ids.node], pauseMs: 0 });
    expect(after.rows).toBe(1);
    expect(after.totals?.equal).toBe(true);
    const hour = await prisma.usageHourly.findFirst({ where: { nodeId: ids.node, subscriptionId: ids.sub, hourStart: new Date(C - 5 * HOUR) } });
    expect(hour).toMatchObject({ bytesUp: 10n, bytesDown: 10n, records: 2 });
  });

  it("refuses to run when the clock is far from the database's", async () => {
    await expect(assertClock(prisma, new Date())).resolves.toBeUndefined();
    await expect(assertClock(prisma, new Date(Date.now() + 10 * MIN))).rejects.toThrow(/nothing done/);
    await expect(assertClock(prisma, new Date(Date.now() - 10 * MIN))).rejects.toThrow(/nothing done/);
  });
});
