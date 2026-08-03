import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ReferralSettingsService } from "./referral-settings.service";
import { ReferralSettingsController } from "./referral-settings.controller";
import { ReferralsService } from "./referrals.service";

// Exports both services: customer-auth needs the settings and the
// signup/activation hooks, and the sweeps processor needs the
// evaluation. forwardRef on SubscriptionsModule because granting a
// reward creates a subscription, and subscription code already reaches
// into this direction for referral bookkeeping.
@Module({
  imports: [PrismaModule, EmailModule, ProtocolUsersModule, forwardRef(() => SubscriptionsModule)],
  controllers: [ReferralSettingsController],
  providers: [ReferralSettingsService, ReferralsService],
  exports: [ReferralSettingsService, ReferralsService],
})
export class ReferralsModule {}
