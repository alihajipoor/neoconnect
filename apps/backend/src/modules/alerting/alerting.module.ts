import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { AlertingService } from "./alerting.service";
import { PagerService } from "./pager.service";

@Module({
  imports: [EmailModule],
  providers: [AlertingService, PagerService],
  exports: [AlertingService, PagerService],
})
export class AlertingModule {}
