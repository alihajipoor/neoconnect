import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ClientAttemptsController } from "./client-attempts.controller";
import { ClientAttemptsService } from "./client-attempts.service";

@Module({
  // Registered bare, with the secret passed per-verify in the
  // controller. The report endpoint is anonymous and only *optionally*
  // reads a customer token, so there is nothing here to sign with and no
  // default secret worth binding -- unlike CustomerAuthModule, which
  // issues tokens and configures one.
  imports: [JwtModule.register({})],
  controllers: [ClientAttemptsController],
  providers: [ClientAttemptsService],
  exports: [ClientAttemptsService],
})
export class ClientAttemptsModule {}
