import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { UsageService } from "../usage/usage.service";
import { SWEEPS_QUEUE } from "./jobs.constants";

@Processor(SWEEPS_QUEUE)
export class SweepsProcessor extends WorkerHost {
  private readonly logger = new Logger(SweepsProcessor.name);

  constructor(private readonly usageService: UsageService) {
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
      default:
        this.logger.warn(`unknown sweep job name: ${job.name}`);
    }
  }
}
