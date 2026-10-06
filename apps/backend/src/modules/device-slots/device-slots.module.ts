import { Module } from "@nestjs/common";
import { DeviceStateStore } from "./device-state.store";
import { DevicePresence } from "./device-presence";
import { DeviceSlotsService } from "./device-slots.service";
import { DeviceSlotsController } from "./device-slots.controller";

/** The plan's device limit: which devices are carrying traffic
 * (DevicePresence) and the slots the apps claim before connecting
 * (DeviceSlotsService, docs/device-slots.md).
 *
 * Imports nothing but the global Prisma and config, so the modules that
 * act on it -- usage (the backstop, suspension), protocol-users
 * (eviction), auth (sign-out) and customers (deletion) -- can all import
 * it without a cycle. */
@Module({
  controllers: [DeviceSlotsController],
  providers: [DeviceStateStore, DevicePresence, DeviceSlotsService],
  exports: [DevicePresence, DeviceSlotsService],
})
export class DeviceSlotsModule {}
