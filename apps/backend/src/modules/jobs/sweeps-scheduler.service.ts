import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { SWEEPS_QUEUE } from "./jobs.constants";

const QUOTA_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Registers the two repeatable sweep jobs on startup. Adding a
 * repeatable job with the same jobId+repeat config is idempotent in
 * BullMQ -- safe to call on every app restart without piling up
 * duplicate schedules. */
@Injectable()
export class SweepsSchedulerService implements OnModuleInit {
  constructor(@InjectQueue(SWEEPS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    await this.queue.add("quota", {}, { repeat: { every: QUOTA_SWEEP_INTERVAL_MS }, jobId: "quota-sweep" });
    await this.queue.add("expiry", {}, { repeat: { every: EXPIRY_SWEEP_INTERVAL_MS }, jobId: "expiry-sweep" });
  }
}
