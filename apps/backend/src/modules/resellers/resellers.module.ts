import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { AppLinksModule } from "../app-links/app-links.module";
import { VouchersModule } from "../vouchers/vouchers.module";
import { ResellerController, ResellersAdminController } from "./resellers.controller";
import { ResellersService } from "./resellers.service";

@Module({
  // VouchersModule for its redeem: activating a plan on a customer's
  // account is a code minted here and redeemed there, by the one path
  // that knows how.
  imports: [EmailModule, AppLinksModule, VouchersModule],
  controllers: [ResellerController, ResellersAdminController],
  providers: [ResellersService],
  exports: [ResellersService],
})
export class ResellersModule {}
