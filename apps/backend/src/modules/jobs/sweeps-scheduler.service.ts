import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { SWEEPS_QUEUE } from "./jobs.constants";

const QUOTA_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Same cadence as their non-warning counterparts above -- low-data
// warnings piggyback on the quota sweep's interval, expiry warnings on
// the expiry sweep's.
const LOW_DATA_WARNING_INTERVAL_MS = QUOTA_SWEEP_INTERVAL_MS;
const EXPIRY_WARNING_INTERVAL_MS = EXPIRY_SWEEP_INTERVAL_MS;
// Once a day is plenty: an invoice's due date is a date, not a moment,
// so checking it hourly would only mean marking something overdue a few
// hours sooner while sending the customer the same reminder.
const INVOICE_OVERDUE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    await this.queue.add(
      "low-data-warning",
      {},
      { repeat: { every: LOW_DATA_WARNING_INTERVAL_MS }, jobId: "low-data-warning-sweep" },
    );
    await this.queue.add(
      "expiry-warning",
      {},
      { repeat: { every: EXPIRY_WARNING_INTERVAL_MS }, jobId: "expiry-warning-sweep" },
    );
    await this.queue.add(
      "invoice-overdue",
      {},
      { repeat: { every: INVOICE_OVERDUE_INTERVAL_MS }, jobId: "invoice-overdue-sweep" },
    );
  }
}
