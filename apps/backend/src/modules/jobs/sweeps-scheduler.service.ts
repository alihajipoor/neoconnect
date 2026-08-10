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
// Hourly is ample for tidying abandoned purchase attempts -- they are
// clutter, not a live problem, and the age threshold does the real work.
const STALE_PENDING_INTERVAL_MS = 60 * 60 * 1000;
// Referral rewards are earned by accumulating whole months of paid
// subscription, so nothing can change more than once a day. Running it
// hourly would only mean a customer hears about their free month a few
// hours sooner, at the cost of a table scan every hour forever.
const REFERRAL_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Attempt reports expire on a 14-day window, so a daily pass is as
// precise as the window is. This one is not merely tidying: those rows
// are IP addresses belonging to people in a country where holding them
// is dangerous, and the sweep is the only thing that actually enforces
// the retention promise.
const CLIENT_ATTEMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    await this.queue.add(
      "stale-pending",
      {},
      { repeat: { every: STALE_PENDING_INTERVAL_MS }, jobId: "stale-pending-sweep" },
    );
    await this.queue.add(
      "referral",
      {},
      { repeat: { every: REFERRAL_INTERVAL_MS }, jobId: "referral-sweep" },
    );
    await this.queue.add(
      "client-attempt-retention",
      {},
      { repeat: { every: CLIENT_ATTEMPT_INTERVAL_MS }, jobId: "client-attempt-retention-sweep" },
    );
  }
}
