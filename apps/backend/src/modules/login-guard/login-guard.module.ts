import { Global, Module } from "@nestjs/common";
import { LoginGuardController } from "./login-guard.controller";
import { LoginGuardService } from "./login-guard.service";

/**
 * Global because both auth modules need it and a third (the RESELLER
 * role, M25) will too. The service holds the shared failure counters,
 * so there must be exactly one instance -- importing it separately per
 * module would give each its own bookkeeping and quietly let an
 * attacker get a fresh budget on every surface.
 */
@Global()
@Module({
  controllers: [LoginGuardController],
  providers: [LoginGuardService],
  exports: [LoginGuardService],
})
export class LoginGuardModule {}
