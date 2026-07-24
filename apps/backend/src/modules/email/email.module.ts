import { Module } from "@nestjs/common";
import { EmailSettingsController } from "./email-settings.controller";
import { EmailSettingsService } from "./email-settings.service";
import { EmailService } from "./email.service";

@Module({
  controllers: [EmailSettingsController],
  providers: [EmailSettingsService, EmailService],
  exports: [EmailSettingsService, EmailService],
})
export class EmailModule {}
