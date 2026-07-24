import { Module } from "@nestjs/common";
import { FreeTrialSettingsController } from "./free-trial-settings.controller";
import { FreeTrialSettingsService } from "./free-trial-settings.service";

@Module({
  controllers: [FreeTrialSettingsController],
  providers: [FreeTrialSettingsService],
  exports: [FreeTrialSettingsService],
})
export class FreeTrialSettingsModule {}
