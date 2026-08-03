import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { VouchersService } from "./vouchers.service";
import { VouchersController } from "./vouchers.controller";

// Exported as well as controlled here, because the customer-facing
// redeem endpoint lives on the customer controller alongside the rest of
// "your account" rather than on this admin surface.
@Module({
  imports: [PrismaModule, SubscriptionsModule, ProtocolUsersModule],
  controllers: [VouchersController],
  providers: [VouchersService],
  exports: [VouchersService],
})
export class VouchersModule {}
