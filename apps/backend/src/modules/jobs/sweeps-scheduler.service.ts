import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { Queue, RepeatOptions } from "bullmq";
import { DOOR_CYCLE_MS } from "../node-doors/door";
import { SWEEPS_FINISHED, SWEEPS_QUEUE } from "./jobs.constants";

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
// Half-hourly, which with the two-cycle alert threshold means an outage
// is reported after roughly an hour. Faster would not help: a block
// takes effect in seconds but is not worth paging on until it has
// persisted, and every cycle spends requests at a rate-limited third
// party on behalf of the whole fleet. Slower would leave a filtered node
// serving nobody for an afternoon before anyone heard about it.
const REACHABILITY_INTERVAL_MS = 30 * 60 * 1000;
// Hourly. Sign-out revokes a device's credentials immediately; this only
// retries the ones a node could not be told about then, and reclaims
// those of devices idle for 30 days -- neither is improved by minutes.
const DEVICE_CREDENTIALS_INTERVAL_MS = 60 * 60 * 1000;
const RELAY_UNVERIFIED_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The reachability probe's cadence: the block watch reads its results,
// and nothing else it reads changes faster. Runs whatever BLOCK_WATCH
// says, and does nothing when it is off.
const BLOCK_WATCH_INTERVAL_MS = 30 * 60 * 1000;
// The database retention (docs/usage-retention.md), once a night at
// 01:15 UTC: late night in the watched country, and clear of the 03:00
// pg_dump (which holds a lock on every table for its whole run) and the
// 03:40 dump pruning. Runs whatever DATA_RETENTION says; off by default.
export const DATA_RETENTION_PATTERN = "15 1 * * *";

/** Registers the repeatable sweep jobs on startup. Adding a repeatable
 * job with the same name, jobId and repeat config is idempotent in
 * BullMQ -- safe to call on every app restart without piling up
 * duplicate schedules. Change any of the three and the old schedule
 * stays in Redis beside the new one, running both. */
@Injectable()
export class SweepsSchedulerService implements OnModuleInit {
  constructor(@InjectQueue(SWEEPS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    await this.schedule("quota", { every: QUOTA_SWEEP_INTERVAL_MS }, "quota-sweep");
    await this.schedule("expiry", { every: EXPIRY_SWEEP_INTERVAL_MS }, "expiry-sweep");
    await this.schedule("low-data-warning", { every: LOW_DATA_WARNING_INTERVAL_MS }, "low-data-warning-sweep");
    await this.schedule("expiry-warning", { every: EXPIRY_WARNING_INTERVAL_MS }, "expiry-warning-sweep");
    await this.schedule("invoice-overdue", { every: INVOICE_OVERDUE_INTERVAL_MS }, "invoice-overdue-sweep");
    await this.schedule("stale-pending", { every: STALE_PENDING_INTERVAL_MS }, "stale-pending-sweep");
    await this.schedule("referral", { every: REFERRAL_INTERVAL_MS }, "referral-sweep");
    await this.schedule(
      "client-attempt-retention",
      { every: CLIENT_ATTEMPT_INTERVAL_MS },
      "client-attempt-retention-sweep",
    );
    await this.schedule("reachability", { every: REACHABILITY_INTERVAL_MS }, "reachability-sweep");
    await this.schedule("device-credentials", { every: DEVICE_CREDENTIALS_INTERVAL_MS }, "device-credentials-sweep");
    await this.schedule("relay-unverified", { every: RELAY_UNVERIFIED_INTERVAL_MS }, "relay-unverified-sweep");
    await this.schedule("block-watch", { every: BLOCK_WATCH_INTERVAL_MS }, "block-watch-sweep");
    await this.schedule("data-retention", { pattern: DATA_RETENTION_PATTERN, tz: "UTC" }, "data-retention-sweep");
    // Each node's door to the panel API (modules/node-doors). The cadence
    // is the door's own: what is handed out is measured in these rounds.
    // Runs whatever NODE_DOORS says, and does nothing when it is off.
    await this.schedule("node-doors", { every: DOOR_CYCLE_MS }, "node-doors-sweep");
  }

  /** Every sweep is added through here, so that none can be added without
   * the removal of its finished runs (FinishedJobs in jobs.constants). */
  private schedule(name: string, repeat: RepeatOptions, jobId: string) {
    return this.queue.add(name, {}, { repeat, jobId, ...SWEEPS_FINISHED });
  }
}
