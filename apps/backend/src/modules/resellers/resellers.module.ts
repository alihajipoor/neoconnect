import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { AppLinksModule } from "../app-links/app-links.module";
import { ResellerController, ResellersAdminController } from "./resellers.controller";
import { ResellersService } from "./resellers.service";

@Module({
  imports: [EmailModule, AppLinksModule],
  controllers: [ResellerController, ResellersAdminController],
  providers: [ResellersService],
  exports: [ResellersService],
})
export class ResellersModule {}
