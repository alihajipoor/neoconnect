import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { UsageService } from "../usage/usage.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ReferralsService } from "../referrals/referrals.service";
import { ClientAttemptsService } from "../client-attempts/client-attempts.service";
import { SWEEPS_QUEUE, STALE_PENDING_AFTER_MS } from "./jobs.constants";

@Processor(SWEEPS_QUEUE)
export class SweepsProcessor extends WorkerHost {
  private readonly logger = new Logger(SweepsProcessor.name);

  constructor(
    private readonly usageService: UsageService,
    private readonly invoicesService: InvoicesService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly referralsService: ReferralsService,
    private readonly clientAttemptsService: ClientAttemptsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case "quota": {
        const count = await this.usageService.sweepQuota();
        this.logger.log(`quota sweep: suspended ${count} subscription(s) the real-time path missed`);
        break;
      }
      case "expiry": {
        const count = await this.usageService.sweepExpiry();
        this.logger.log(`expiry sweep: expired ${count} subscription(s)`);
        break;
      }
      case "low-data-warning": {
        const count = await this.usageService.sweepLowDataWarnings();
        this.logger.log(`low-data warning sweep: warned ${count} subscription(s)`);
        break;
      }
      case "expiry-warning": {
        const count = await this.usageService.sweepExpiryWarnings();
        this.logger.log(`expiry warning sweep: warned ${count} subscription(s)`);
        break;
      }
      case "invoice-overdue": {
        // Expected to find nothing almost every run: this product is
        // prepaid, so invoices are issued already paid and never carry a
        // due date. Only slow-settling crypto leaves one outstanding.
        const overdue = await this.invoicesService.markOverdue();
        if (overdue > 0) {
          this.logger.log(`invoice overdue sweep: marked ${overdue} invoice(s) overdue`);
        }
        break;
      }
      case "referral": {
        const granted = await this.referralsService.sweep();
        if (granted > 0) {
          this.logger.log(`referral sweep: granted ${granted} free period(s)`);
        }
        break;
      }
      case "stale-pending": {
        const count = await this.subscriptionsService.cancelStalePending(STALE_PENDING_AFTER_MS);
        if (count > 0) {
          this.logger.log(`stale pending sweep: cancelled ${count} abandoned purchase attempt(s)`);
        }
        break;
      }
      case "client-attempt-retention": {
        // Not tidying -- this is the only thing that actually enforces
        // the retention promise on a table of IP addresses belonging to
        // people in a country where holding them is dangerous. The
        // service logs the count itself when it deletes anything.
        await this.clientAttemptsService.prune();
        break;
      }
      default:
        this.logger.warn(`unknown sweep job name: ${job.name}`);
    }
  }
}
