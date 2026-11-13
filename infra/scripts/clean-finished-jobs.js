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
// What it removes: on each queue, completed jobs that finished more than
// a day ago (GRACE_HOURS) and failed jobs that finished more than a week
// ago (FAILED_GRACE_HOURS, default 168) -- their entry in the finished set
// and the job's own keys. Failures get the longer grace because the
// backend keeps them for a week to be read; a manual run must not remove
// what that policy keeps. Nothing else: no schedule, no job that is
// waiting, delayed or running, and nothing finished within its grace. It
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
const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = {
  completed: Number(process.env.GRACE_HOURS ?? 24) * HOUR_MS,
  failed: Number(process.env.FAILED_GRACE_HOURS ?? 168) * HOUR_MS,
};
const BATCH = 1000;
const APPLY = process.env.APPLY === "1";

async function main() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set: run this inside the backend container");
  if (!(GRACE_MS.completed >= HOUR_MS)) throw new Error("GRACE_HOURS must be at least 1");
  if (!(GRACE_MS.failed >= HOUR_MS)) throw new Error("FAILED_GRACE_HOURS must be at least 1");
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const now = Date.now();
  console.log(
    `${APPLY ? "REMOVING" : "Counting (nothing is removed without APPLY=1)"}: completed jobs finished before ` +
      `${new Date(now - GRACE_MS.completed).toISOString()}, failed jobs finished before ${new Date(now - GRACE_MS.failed).toISOString()}`,
  );

  for (const name of QUEUES) {
    // skipMetasUpdate: a script that only tidies should not write this
    // queue's metadata as though it were the application.
    const queue = new Queue(name, { connection, skipMetasUpdate: true });
    for (const type of ["completed", "failed"]) {
      const grace = GRACE_MS[type];
      const cutoff = now - grace;
      const key = queue.toKey(type);
      const total = await connection.zcard(key);
      const old = await connection.zcount(key, "-inf", cutoff);
      let removed = 0;
      if (APPLY) {
        for (;;) {
          const ids = await queue.clean(grace, BATCH, type);
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
