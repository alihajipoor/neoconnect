/* The database retention, by hand (docs/usage-retention.md). Inside the
 * backend container:
 *
 *   node dist/cli/data-retention.js            dry run: counts only
 *   node dist/cli/data-retention.js --run      roll up and delete
 *
 * Options: --only usage|commands, --batch N, --node <name> (repeatable).
 * Ctrl-C stops it between batches; every batch already done is complete
 * and committed, and a later run carries on from there.
 *
 * Prints node names and counts only, never a row's contents. */
import { PrismaClient } from "@prisma/client";
import { parseTuning } from "../modules/block-watch/block-signals";
import {
  assertClock,
  commandCutoff,
  pruneCommands,
  rollUpUsage,
  usageCutoff,
  type NodeTotals,
} from "../modules/data-retention/retention";

interface Args {
  run: boolean;
  only?: "usage" | "commands";
  batch?: number;
  nodes: string[];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { run: false, nodes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--run") args.run = true;
    else if (a === "--dry-run") args.run = false;
    else if (a === "--only") {
      const v = argv[++i];
      if (v !== "usage" && v !== "commands") throw new Error("--only takes usage or commands");
      args.only = v;
    } else if (a === "--batch") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 50_000) throw new Error("--batch takes a whole number from 1 to 50000");
      args.batch = n;
    } else if (a === "--node") {
      const v = argv[++i];
      if (!v) throw new Error("--node takes a node name");
      args.nodes.push(v);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  let stop = false;
  const onSignal = () => {
    if (!stop) console.error("stopping after the current batch...");
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);
  const shouldStop = () => stop;
  let code = 0;
  try {
    const now = new Date();
    await assertClock(prisma, now);
    const nodes = await prisma.node.findMany({ select: { id: true, name: true } });
    const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
    let nodeIds: string[] | undefined;
    if (args.nodes.length) {
      nodeIds = args.nodes.map((name) => {
        const found = nodes.find((n) => n.name === name);
        if (!found) throw new Error(`no node named ${name}`);
        return found.id;
      });
    }
    const named = (t: NodeTotals) =>
      Object.fromEntries(Object.entries(t).map(([id, v]) => [nameOf.get(id) ?? id, v]));
    const out: Record<string, unknown> = { mode: args.run ? "run" : "dry run", at: now.toISOString() };

    if (args.only !== "commands") {
      const { tuning } = parseTuning(process.env.BLOCK_WATCH_TUNING);
      const cut = await usageCutoff(prisma, now, tuning);
      log(`usage: cutoff ${cut.cutoff.toISOString()} (${Math.round(cut.keepMs / 3_600_000)} h kept, set by ${cut.reason})`);
      const r = await rollUpUsage(prisma, {
        cutoff: cut.cutoff,
        dryRun: !args.run,
        nodeIds,
        batchSize: args.batch,
        shouldStop,
        log,
      });
      out.usage = {
        cutoff: r.cutoff.toISOString(),
        setBy: cut.reason,
        rows: r.rows,
        hours: r.hours,
        interrupted: r.interrupted,
        nodes: r.nodes
          .filter((n) => n.rows > 0 || n.stopped)
          .map((n) => ({
            node: n.name,
            rows: n.rows,
            hours: n.hours,
            bytesUp: n.bytesUp.toString(),
            bytesDown: n.bytesDown.toString(),
            ...(n.stopped ? { stopped: n.stopped } : {}),
          })),
        ...(r.totals
          ? { totalsEqual: r.totals.equal, totalsBefore: named(r.totals.before), totalsAfter: named(r.totals.after) }
          : {}),
      };
      if (r.totals && !r.totals.equal) code = 2;
    }

    if (args.only !== "usage" && !stop) {
      const r = await pruneCommands(prisma, {
        cutoff: commandCutoff(now),
        dryRun: !args.run,
        nodeIds,
        batchSize: args.batch,
        shouldStop,
        log,
      });
      out.commands = {
        cutoff: r.cutoff.toISOString(),
        finished: r.deleted,
        total: r.total,
        keptPendingOlderThanCutoff: r.keptPending,
        interrupted: r.interrupted,
        ...(r.stopped ? { stopped: r.stopped } : {}),
      };
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
  process.exitCode = code;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`data retention: ${(err as Error).message?.split("\n").pop()}`);
    process.exitCode = 1;
  });
}
