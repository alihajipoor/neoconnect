import { Module } from "@nestjs/common";
import { AdminAuditModule } from "../admin-audit/admin-audit.module";
import { TrustedDevicesService } from "./trusted-devices.service";

/** Browsers an admin trusted at the two-factor step. Its own module so
 * both AuthModule (sign-in, MFA changes) and AdminsModule (password and
 * role changes) can revoke them without importing each other. */
@Module({
  imports: [AdminAuditModule],
  providers: [TrustedDevicesService],
  exports: [TrustedDevicesService],
})
export class TrustedDevicesModule {}
