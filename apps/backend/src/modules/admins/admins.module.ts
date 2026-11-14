import { Module } from "@nestjs/common";
import { TrustedDevicesModule } from "../trusted-devices/trusted-devices.module";
import { AdminsController } from "./admins.controller";
import { AdminsService } from "./admins.service";

@Module({
  imports: [TrustedDevicesModule],
  controllers: [AdminsController],
  providers: [AdminsService],
  exports: [AdminsService],
})
export class AdminsModule {}
