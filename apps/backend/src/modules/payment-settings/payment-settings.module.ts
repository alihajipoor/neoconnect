import { Module } from "@nestjs/common";
import { PaymentSettingsService } from "./payment-settings.service";
import { PaymentSettingsController } from "./payment-settings.controller";

@Module({
  controllers: [PaymentSettingsController],
  providers: [PaymentSettingsService],
  // Exported because the billing providers read their credentials from
  // here instead of from environment variables.
  exports: [PaymentSettingsService],
})
export class PaymentSettingsModule {}
