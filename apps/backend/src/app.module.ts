import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import configuration from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { LoginGuardModule } from "./modules/login-guard/login-guard.module";
import { AdminsModule } from "./modules/admins/admins.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { PlansModule } from "./modules/plans/plans.module";
import { NodesModule } from "./modules/nodes/nodes.module";
import { EnrollmentModule } from "./modules/enrollment/enrollment.module";
import { AgentGatewayModule } from "./modules/agent-gateway/agent-gateway.module";
import { SubscriptionsModule } from "./modules/subscriptions/subscriptions.module";
import { ProtocolConfigsModule } from "./modules/protocol-configs/protocol-configs.module";
import { ProtocolUsersModule } from "./modules/protocol-users/protocol-users.module";
import { RoutesModule } from "./modules/routes/routes.module";
import { UsageModule } from "./modules/usage/usage.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { BillingModule } from "./modules/billing/billing.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { PaymentSettingsModule } from "./modules/payment-settings/payment-settings.module";
import { CustomerAuthModule } from "./modules/customer-auth/customer-auth.module";
import { CustomerModule } from "./modules/customer/customer.module";
import { FreeTrialSettingsModule } from "./modules/free-trial-settings/free-trial-settings.module";
import { ReferralsModule } from "./modules/referrals/referrals.module";
import { VouchersModule } from "./modules/vouchers/vouchers.module";
import { AppLinksModule } from "./modules/app-links/app-links.module";
import { SupportModule } from "./modules/support/support.module";
import { BrandModule } from "./modules/brand/brand.module";
import { UpdatesModule } from "./modules/updates/updates.module";
import { EmailModule } from "./modules/email/email.module";
import { AnnouncementsModule } from "./modules/announcements/announcements.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { ClientAttemptsModule } from "./modules/client-attempts/client-attempts.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Global default: generous enough for normal panel/API use, applied
    // per-IP via APP_GUARD below. Individual routes (login, enrollment
    // claim) override this with a tighter limit -- see their
    // controllers. Webhook endpoints skip throttling entirely (signature
    // verification is what protects them, and a legitimate provider
    // retry storm shouldn't get blocked) -- see billing/webhooks.controller.ts.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
    // @Global, so both auth modules share one set of failure counters.
    LoginGuardModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    AdminsModule,
    CustomersModule,
    PlansModule,
    NodesModule,
    EnrollmentModule,
    AgentGatewayModule,
    SubscriptionsModule,
    ProtocolConfigsModule,
    ProtocolUsersModule,
    RoutesModule,
    UsageModule,
    JobsModule,
    BillingModule,
    InvoicesModule,
    PaymentSettingsModule,
    CustomerAuthModule,
    CustomerModule,
    FreeTrialSettingsModule,
    ReferralsModule,
    VouchersModule,
    AppLinksModule,
    SupportModule,
    BrandModule,
    UpdatesModule,
    EmailModule,
    AnnouncementsModule,
    IntegrationsModule,
    ClientAttemptsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
