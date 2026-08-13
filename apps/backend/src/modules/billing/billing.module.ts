import { Module } from "@nestjs/common";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PaymentSettingsModule } from "../payment-settings/payment-settings.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { NowPaymentsProvider } from "./providers/nowpayments.provider";
import { PlisioProvider } from "./providers/plisio.provider";
import { StripeProvider } from "./providers/stripe.provider";
import { CheckoutReturnController, WebhooksController } from "./webhooks.controller";

@Module({
  imports: [ProtocolUsersModule, InvoicesModule, PaymentSettingsModule],
  controllers: [BillingController, WebhooksController, CheckoutReturnController],
  providers: [BillingService, StripeProvider, NowPaymentsProvider, PlisioProvider],
  exports: [BillingService],
})
export class BillingModule {}
