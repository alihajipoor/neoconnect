import { Module } from "@nestjs/common";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { NowPaymentsProvider } from "./providers/nowpayments.provider";
import { StripeProvider } from "./providers/stripe.provider";
import { CheckoutReturnController, WebhooksController } from "./webhooks.controller";

@Module({
  imports: [ProtocolUsersModule, InvoicesModule],
  controllers: [BillingController, WebhooksController, CheckoutReturnController],
  providers: [BillingService, StripeProvider, NowPaymentsProvider],
  exports: [BillingService],
})
export class BillingModule {}
