import { Module } from "@nestjs/common";
import { DataRetentionService } from "./data-retention.service";

/** The nightly database retention (docs/usage-retention.md). Prisma and
 * config are global; the cadence is the sweeps queue's, in modules/jobs. */
@Module({
  providers: [DataRetentionService],
  exports: [DataRetentionService],
})
export class DataRetentionModule {}
