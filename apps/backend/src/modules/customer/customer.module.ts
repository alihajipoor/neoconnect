import { Module } from "@nestjs/common";
import { ReferralsModule } from "../referrals/referrals.module";
import { VouchersModule } from "../vouchers/vouchers.module";
import { AppLinksModule } from "../app-links/app-links.module";
import { SupportModule } from "../support/support.module";
import { CustomerController } from "./customer.controller";
import { CustomersModule } from "../customers/customers.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { PlansModule } from "../plans/plans.module";
import { RoutesModule } from "../routes/routes.module";
import { BillingModule } from "../billing/billing.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PaymentSettingsModule } from "../payment-settings/payment-settings.module";

@Module({
  imports: [
    CustomersModule,
    SubscriptionsModule,
    ProtocolUsersModule,
    PlansModule,
    RoutesModule,
    BillingModule,
    InvoicesModule,
    PaymentSettingsModule,
    ReferralsModule,
    VouchersModule,
    AppLinksModule,
    SupportModule,
  ],
  controllers: [CustomerController],
})
export class CustomerModule {}
