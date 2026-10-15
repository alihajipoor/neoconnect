import { Module } from "@nestjs/common";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { AlertingModule } from "../alerting/alerting.module";
import { EmailModule } from "../email/email.module";
import { RelayAuthService } from "./relay-auth.service";
import { RelayAccountsService } from "./relay-accounts.service";
import { RelayAuthController, RelayStatusController } from "./relay-auth.controller";

/** Sign-up and sign-in through the Iranian relay of last resort
 * (docs/relay-last-resort.md). Depends on nothing customer-facing, so
 * customer-auth, protocol-users and the sweeps can all import it. */
@Module({
  imports: [NetworkIdentityModule, AlertingModule, EmailModule],
  controllers: [RelayStatusController, RelayAuthController],
  providers: [RelayAuthService, RelayAccountsService],
  exports: [RelayAuthService],
})
export class RelayAuthModule {}
