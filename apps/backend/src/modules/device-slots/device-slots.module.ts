import { Module } from "@nestjs/common";
import { DeviceStateStore } from "./device-state.store";
import { DevicePresence } from "./device-presence";

/** The plan's device limit: which devices are carrying traffic
 * (DevicePresence) and, for the apps, slots claimed before connecting.
 *
 * Imports nothing but the global Prisma and config, so the modules that
 * act on it -- usage (the backstop), protocol-users (eviction), auth
 * (sign-out) and customers (deletion) -- can all import it without a
 * cycle. */
@Module({
  providers: [DeviceStateStore, DevicePresence],
  exports: [DevicePresence],
})
export class DeviceSlotsModule {}
