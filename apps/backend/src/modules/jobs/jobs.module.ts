import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";
import { UsageModule } from "../usage/usage.module";
import { EmailModule } from "../email/email.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ClientAttemptsModule } from "../client-attempts/client-attempts.module";
import { ANNOUNCEMENTS_QUEUE, SWEEPS_QUEUE } from "./jobs.constants";
import { ReferralsModule } from "../referrals/referrals.module";
import { SweepsProcessor } from "./sweeps.processor";
import { SweepsSchedulerService } from "./sweeps-scheduler.service";
import { AnnouncementsProcessor } from "./announcements.processor";

// Registered here (rather than in a new announcements module) so this
// stays the single place BullMQ's Redis connection is configured -- the
// announcements module imports JobsModule and re-exports below to get
// its own @InjectQueue(ANNOUNCEMENTS_QUEUE), same as sweeps-scheduler
// does for SWEEPS_QUEUE from within this same module.
const announcementsQueue = BullModule.registerQueue({ name: ANNOUNCEMENTS_QUEUE });

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
    ReferralsModule,
    announcementsQueue,
    UsageModule,
    EmailModule,
    InvoicesModule,
    // For the stale-pending sweep. No cycle: SubscriptionsModule pulls in
    // nothing from here.
    SubscriptionsModule,
    // For the retention sweep only.
    ClientAttemptsModule,
  ],
  providers: [SweepsProcessor, SweepsSchedulerService, AnnouncementsProcessor],
  exports: [announcementsQueue],
})
export class JobsModule {}
