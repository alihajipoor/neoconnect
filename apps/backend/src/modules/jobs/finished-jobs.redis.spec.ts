import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { type FinishedJobs, SWEEPS_FINISHED } from "./jobs.constants";
import { SweepsSchedulerService } from "./sweeps-scheduler.service";

/** The removal of finished jobs against a real Redis, run by BullMQ's own
 * scripts -- the part finished-jobs.spec.ts cannot check, since a mocked
 * queue only shows which options were passed, and the options passed at
 * startup are exactly what does not reach a repeat chain already running.
 *
 * Runs only with NEOXIFY_REDIS_SPECS=1, which CI sets for its own step
 * against the job's Redis service (.github/workflows/ci.yml). It works
 * in queues of its own, named for one run, and removes them afterwards. */

const enabled = process.env.NEOXIFY_REDIS_SPECS === "1";

const DAY_MS = 24 * 60 * 60 * 1000;

(enabled ? describe : describe.skip)("finished jobs against Redis", () => {
  jest.setTimeout(60_000);

  const tag = randomUUID().slice(0, 8);
  let connection: IORedis;
  const queues: Queue[] = [];
  const workers: Worker[] = [];

  beforeAll(() => {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    const removed = new Set<string>();
    for (const queue of queues) {
      if (!removed.has(queue.name)) await queue.obliterate({ force: true });
      removed.add(queue.name);
      await queue.close();
    }
    await connection.quit();
  });

  /** Without `defaultJobOptions`, the queue as it was registered before. */
  const queueNamed = (name: string, opts: { defaultJobOptions?: FinishedJobs } = {}) => {
    const queue = new Queue(`spec-finished-${tag}-${name}`, { connection, ...opts });
    queues.push(queue);
    return queue;
  };

  /** A worker whose jobs do nothing. `removal` is what @Processor is
   * given; without it, this is the worker as it was before. */
  const workerOn = async (queue: Queue, removal: Partial<FinishedJobs> = {}) => {
    const worker = new Worker(queue.name, () => Promise.resolve(), { connection, concurrency: 50, ...removal });
    worker.on("error", () => undefined);
    workers.push(worker);
    await worker.waitUntilReady();
    return worker;
  };

  const until = async (what: string, done: () => Promise<boolean>) => {
    const deadline = Date.now() + 30_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /** `count` jobs that finished two days ago under the worker as it was:
   * no removal anywhere, so every one of them is still there. */
  const backlogOf = async (queue: Queue, count: number) => {
    await queue.addBulk(Array.from({ length: count }, () => ({ name: "old", data: {} })));
    const asBefore = await workerOn(queue);
    await until("the backlog has run", async () => (await queue.getCompletedCount()) === count);
    await asBefore.close();

    const completed = queue.toKey("completed");
    const ids = await connection.zrange(completed, 0, -1);
    const twoDaysAgo = Date.now() - 2 * DAY_MS;
    await connection.zadd(completed, ...ids.flatMap((id) => [twoDaysAgo, id]));
    return ids;
  };

  const stillStored = async (queue: Queue, ids: string[]) => {
    const pipeline = connection.pipeline();
    for (const id of ids) pipeline.exists(queue.toKey(id));
    const results = (await pipeline.exec()) ?? [];
    return results.filter(([, exists]) => exists === 1).length;
  };

  const finishOne = async (queue: Queue) => {
    const job = await queue.add("new", {});
    await until("the new job has finished", async () => (await job.getState()) === "completed");
  };

  it("the worker's setting clears a backlog left by jobs that carry none, 1,000 a run", async () => {
    const queue = queueNamed("backlog");
    const old = await backlogOf(queue, 1_500);
    expect(await queue.getCompletedCount()).toBe(1_500);

    await workerOn(queue, SWEEPS_FINISHED);

    // The job that finishes is added to no queue default and carries no
    // option of its own: all that removes anything is the worker.
    await finishOne(queue);
    expect(await queue.getCompletedCount()).toBe(501);
    // The jobs themselves, not only their entries in the completed set.
    expect(await stillStored(queue, old)).toBe(500);

    await finishOne(queue);
    expect(await stillStored(queue, old)).toBe(0);
    // Two finished in the last minute, and a day has not passed.
    expect(await queue.getCompletedCount()).toBe(2);
  });

  it("a repeat chain started before the setting keeps running without it, and the worker covers it", async () => {
    const before = queueNamed("chain");
    const after = queueNamed("chain", { defaultJobOptions: SWEEPS_FINISHED });
    const repeat = { every: DAY_MS };

    // The chain as production has it: started by the code before.
    await before.add("quota", {}, { repeat, jobId: "quota-sweep" });
    // A restart on the code after: same schedule, now with the removal.
    await after.add("quota", {}, { repeat, jobId: "quota-sweep", ...SWEEPS_FINISHED });

    expect(await after.getRepeatableJobs()).toHaveLength(1);
    const scheduled = await after.getDelayed();
    expect(scheduled).toHaveLength(1);
    // The run already scheduled is not replaced, and has no setting.
    expect(scheduled[0].opts.removeOnComplete).toBeUndefined();
    expect(scheduled[0].opts.removeOnFail).toBeUndefined();

    const old = await backlogOf(before, 3);
    await workerOn(after, SWEEPS_FINISHED);
    await scheduled[0].promote();
    await until("the scheduled run has finished", async () => (await scheduled[0].getState()) === "completed");

    // Removed by the worker's setting: the run had none of its own.
    expect(await stillStored(after, old)).toBe(0);
    expect(await after.getCompletedCount()).toBe(1);

    // And it handed its options, still without one, to the run after it.
    const next = await after.getDelayed();
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(scheduled[0].id);
    expect(next[0].opts.removeOnComplete).toBeUndefined();
  });

  it("the sweeps as scheduled at startup carry the removal, and scheduling twice adds nothing", async () => {
    const queue = queueNamed("startup", { defaultJobOptions: SWEEPS_FINISHED });
    const scheduler = new SweepsSchedulerService(queue);

    await scheduler.onModuleInit();
    await scheduler.onModuleInit();

    expect(await queue.getRepeatableJobs()).toHaveLength(14);
    const scheduled = await queue.getDelayed();
    expect(scheduled).toHaveLength(14);
    for (const job of scheduled) {
      expect({ name: job.name, ...job.opts }).toMatchObject({ name: job.name, ...SWEEPS_FINISHED });
    }
  });
});
