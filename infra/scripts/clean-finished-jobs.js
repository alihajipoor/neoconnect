// One-time removal of the finished jobs BullMQ kept before it was told
// to remove them (apps/backend/src/modules/jobs/jobs.constants.ts,
// FinishedJobs). On 2026-11-12 the sweeps queue held about 65,000.
//
// It only counts, unless APPLY=1 is set. Deleting is the owner's to
// approve: read the counts first.
//
// Run inside the backend container, which has BullMQ and REDIS_URL, by
// handing it this file on standard input -- from the panel host:
//
//   docker exec -i neoxify-backend-1 node - < infra/scripts/clean-finished-jobs.js
//   docker exec -i -e APPLY=1 neoxify-backend-1 node - < infra/scripts/clean-finished-jobs.js
//
// What it removes: on each queue, completed and failed jobs that finished
// more than a day ago (GRACE_HOURS) -- their entry in the finished set
// and the job's own keys. Nothing else: no schedule, no job that is
// waiting, delayed or running, and nothing finished within the day. It
// goes 1,000 jobs to a call, so Redis is never held for long, and it is
// safe to stop and run again.
//
// Once the backend that removes finished jobs is deployed, it clears the
// same completed backlog by itself, 1,000 a run, within a few hours. So
// this is needed only to clear it before that deploy, or for the failed
// jobs, which the backend trims only when another job fails.

const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUES = ["sweeps", "announcements"];
const GRACE_MS = Number(process.env.GRACE_HOURS ?? 24) * 60 * 60 * 1000;
const BATCH = 1000;
const APPLY = process.env.APPLY === "1";

async function main() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set: run this inside the backend container");
  if (!(GRACE_MS >= 60 * 60 * 1000)) throw new Error("GRACE_HOURS must be at least 1");
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const cutoff = Date.now() - GRACE_MS;
  console.log(`${APPLY ? "REMOVING" : "Counting (nothing is removed without APPLY=1)"}: jobs finished before ${new Date(cutoff).toISOString()}`);

  for (const name of QUEUES) {
    // skipMetasUpdate: a script that only tidies should not write this
    // queue's metadata as though it were the application.
    const queue = new Queue(name, { connection, skipMetasUpdate: true });
    for (const type of ["completed", "failed"]) {
      const key = queue.toKey(type);
      const total = await connection.zcard(key);
      const old = await connection.zcount(key, "-inf", cutoff);
      let removed = 0;
      if (APPLY) {
        for (;;) {
          const ids = await queue.clean(GRACE_MS, BATCH, type);
          removed += ids.length;
          if (ids.length === 0) break;
        }
      }
      const left = await connection.zcard(key);
      console.log(
        `${name} ${type}: ${total} held, ${old} older than the cut-off, ` +
          (APPLY ? `${removed} removed, ${left} left` : `${total - old} would be left`),
      );
    }
    await queue.close();
  }
  console.log(`keys in this Redis database now: ${await connection.dbsize()}`);
  await connection.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
