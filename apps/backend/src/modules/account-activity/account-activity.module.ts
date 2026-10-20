import { Module } from "@nestjs/common";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { DeviceSlotsModule } from "../device-slots/device-slots.module";
import { AccountActivityController } from "./account-activity.controller";
import { AccountDevicesService } from "./account-devices.service";
import { DailyUsageService } from "./daily-usage.service";

/** GET /customer/devices, DELETE /customer/devices/:id, GET /customer/usage
 * and GET /customer/subscriptions/:id/usage (docs/account-activity.md).
 *
 * Its own module so it can import customer-auth (signing a device out is
 * revokeSession) and device slots (which device is in use) without either
 * of them importing anything new. Nothing imports it. */
@Module({
  imports: [CustomerAuthModule, DeviceSlotsModule],
  controllers: [AccountActivityController],
  providers: [AccountDevicesService, DailyUsageService],
})
export class AccountActivityModule {}
