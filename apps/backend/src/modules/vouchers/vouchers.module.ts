import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { VouchersService } from "./vouchers.service";
import { VouchersController } from "./vouchers.controller";
import { PublicVouchersController } from "./public-vouchers.controller";

// Exported as well as controlled here, because the customer-facing
// redeem endpoint lives on the customer controller alongside the rest of
// "your account" rather than on this admin surface.
@Module({
  imports: [PrismaModule, SubscriptionsModule, ProtocolUsersModule],
  // Order matters here in one respect only: both are mounted at
  // `vouchers`, and the admin controller is guarded at class level. A
  // public route added to *that* class would silently inherit the guard
  // and 401 every anonymous visitor, which is why the public one is a
  // separate class rather than one more method.
  controllers: [VouchersController, PublicVouchersController],
  providers: [VouchersService],
  exports: [VouchersService],
})
export class VouchersModule {}
