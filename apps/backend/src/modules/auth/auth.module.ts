import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AdminSignInAlertsService } from "./admin-sign-in-alerts.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { AdminsModule } from "../admins/admins.module";
import { AlertingModule } from "../alerting/alerting.module";
import { EmailModule } from "../email/email.module";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { TrustedDevicesModule } from "../trusted-devices/trusted-devices.module";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    AdminsModule,
    AlertingModule,
    EmailModule,
    NetworkIdentityModule,
    TrustedDevicesModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AdminSignInAlertsService],
  exports: [AuthService],
})
export class AuthModule {}
