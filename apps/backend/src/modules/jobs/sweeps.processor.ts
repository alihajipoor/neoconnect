import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { UsageService } from "../usage/usage.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SWEEPS_QUEUE } from "./jobs.constants";

@Processor(SWEEPS_QUEUE)
export class SweepsProcessor extends WorkerHost {
  private readonly logger = new Logger(SweepsProcessor.name);

  constructor(
    private readonly usageService: UsageService,
    private readonly invoicesService: InvoicesService,
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
        if (overdue.length > 0) {
          this.logger.log(`invoice overdue sweep: marked ${overdue.length} invoice(s) overdue`);
        }
        break;
      }
      default:
        this.logger.warn(`unknown sweep job name: ${job.name}`);
    }
  }
}
