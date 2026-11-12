import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queue } from "bullmq";
import { ANNOUNCEMENTS_FINISHED, SWEEPS_FINISHED } from "./jobs.constants";
import { SweepsSchedulerService } from "./sweeps-scheduler.service";

/** Finished jobs are removed from Redis, on every queue.
 *
 * What these cannot show is what BullMQ then does with the settings --
 * above all that a repeat chain already running takes them from the
 * worker and from nowhere else. That is finished-jobs.redis.spec.ts,
 * against a real Redis. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Name, jobId and timing as they were before the removal settings were
 * added. BullMQ identifies a schedule by all three: change one and the old
 * schedule stays in Redis beside the new one, and both run. A change here
 * has to come with the removal of the schedule it replaces. */
const SCHEDULES: [name: string, jobId: string, repeat: object][] = [
  ["quota", "quota-sweep", { every: 5 * MINUTE }],
  ["expiry", "expiry-sweep", { every: HOUR }],
  ["low-data-warning", "low-data-warning-sweep", { every: 5 * MINUTE }],
  ["expiry-warning", "expiry-warning-sweep", { every: HOUR }],
  ["invoice-overdue", "invoice-overdue-sweep", { every: DAY }],
  ["stale-pending", "stale-pending-sweep", { every: HOUR }],
  ["referral", "referral-sweep", { every: 6 * HOUR }],
  ["client-attempt-retention", "client-attempt-retention-sweep", { every: DAY }],
  ["reachability", "reachability-sweep", { every: 30 * MINUTE }],
  ["device-credentials", "device-credentials-sweep", { every: HOUR }],
  ["relay-unverified", "relay-unverified-sweep", { every: DAY }],
  ["block-watch", "block-watch-sweep", { every: 30 * MINUTE }],
  ["data-retention", "data-retention-sweep", { pattern: "15 1 * * *", tz: "UTC" }],
  ["node-doors", "node-doors-sweep", { every: 15 * MINUTE }],
];

describe("the sweep schedules", () => {
  const add = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    await new SweepsSchedulerService({ add } as unknown as Queue).onModuleInit();
  });

  it("are the same schedules as before, so a restart adds no second copy of any", () => {
    const added = add.mock.calls.map(([name, , opts]) => [name, opts.jobId, opts.repeat]);
    expect(added).toEqual(SCHEDULES);
  });

  it("each remove their finished runs", () => {
    expect(add).toHaveBeenCalledTimes(SCHEDULES.length);
    for (const [name, data, opts] of add.mock.calls) {
      expect({ name, removeOnComplete: opts.removeOnComplete, removeOnFail: opts.removeOnFail }).toEqual({
        name,
        ...SWEEPS_FINISHED,
      });
      expect(data).toEqual({});
    }
  });
});

describe("what is kept of a finished job", () => {
  it("is bounded for both outcomes on both queues", () => {
    for (const kept of [SWEEPS_FINISHED, ANNOUNCEMENTS_FINISHED]) {
      for (const keep of [kept.removeOnComplete, kept.removeOnFail]) {
        const bound = "age" in keep ? keep.age : keep.count;
        expect(bound).toBeGreaterThan(0);
      }
    }
  });

  // A count is enforced in one Redis script however far over it the queue
  // is. See SWEEPS_FINISHED for what that would have done on the first
  // run after this shipped.
  it("bounds completed sweeps by age alone", () => {
    expect(SWEEPS_FINISHED.removeOnComplete).toEqual({ age: 24 * 60 * 60 });
  });
});

/** The omission this guards against was made twice, once per queue, by
 * leaving something out -- which no test of the existing queues notices
 * when a third is added. So the source is read instead. */
describe("every queue in the backend", () => {
  const src = join(__dirname, "..", "..");
  const sources = (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: readFileSync(join(src, file), "utf8") }));

  const uses = (pattern: RegExp) =>
    sources.flatMap(({ file, text }) => [...text.matchAll(pattern)].map((match) => ({ file, call: match[0] })));

  it("is registered with the removal of finished jobs as its default", () => {
    const registrations = uses(/registerQueue\([^)]*\)/g);
    expect(registrations.length).toBeGreaterThanOrEqual(2);
    for (const registration of registrations) {
      expect(registration).toEqual({ file: registration.file, call: expect.stringMatching(/defaultJobOptions: \w+_FINISHED\b/) });
    }
  });

  it("has a worker that removes them too", () => {
    const processors = uses(/@Processor\([^)]*\)/g);
    expect(processors.length).toBeGreaterThanOrEqual(2);
    for (const processor of processors) {
      expect(processor).toEqual({ file: processor.file, call: expect.stringMatching(/, \w+_FINISHED\)$/) });
    }
  });

  it("is reached through Nest, where those two are checked", () => {
    expect(uses(/new (Queue|Worker)\(/g)).toEqual([]);
  });
});
