import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";
import { UsageModule } from "../usage/usage.module";
import { SWEEPS_QUEUE } from "./jobs.constants";
import { SweepsProcessor } from "./sweeps.processor";
import { SweepsSchedulerService } from "./sweeps-scheduler.service";

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // BullMQ requires maxRetriesPerRequest: null on the ioredis
        // connection it's given -- its blocking commands (BRPOPLPUSH
        // etc.) don't work correctly under ioredis's default retry
        // behavior otherwise.
        connection: new IORedis(config.get<string>("redis.url")!, { maxRetriesPerRequest: null }),
      }),
    }),
    BullModule.registerQueue({ name: SWEEPS_QUEUE }),
    UsageModule,
  ],
  providers: [SweepsProcessor, SweepsSchedulerService],
})
export class JobsModule {}
