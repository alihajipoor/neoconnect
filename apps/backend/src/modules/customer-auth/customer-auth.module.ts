import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { CustomerAuthController } from "./customer-auth.controller";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtStrategy } from "./strategies/customer-jwt.strategy";
import { CustomersModule } from "../customers/customers.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { FreeTrialSettingsModule } from "../free-trial-settings/free-trial-settings.module";
import { ReferralsModule } from "../referrals/referrals.module";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    CustomersModule,
    SubscriptionsModule,
    ProtocolUsersModule,
    FreeTrialSettingsModule,
    ReferralsModule,
    EmailModule,
  ],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService, CustomerJwtStrategy],
  exports: [CustomerAuthService],
})
export class CustomerAuthModule {}
