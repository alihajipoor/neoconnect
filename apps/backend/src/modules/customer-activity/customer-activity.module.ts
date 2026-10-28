import { Module } from "@nestjs/common";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { CustomerActivityController, MonitorController } from "./customer-activity.controller";
import { CustomerActivityService } from "./customer-activity.service";

/** GET /customers/:id/activity, POST /customers/:id/sessions/:sessionId/sign-out
 * and GET /monitor/live: what staff see of a customer's connections.
 *
 * Its own module so it can import customer-auth (signing a device out is
 * revokeSession, as for the customer's own app) and network identity
 * (naming the network an attempt came from) without either importing
 * anything new. Nothing imports it. */
@Module({
  imports: [CustomerAuthModule, NetworkIdentityModule],
  controllers: [CustomerActivityController, MonitorController],
  providers: [CustomerActivityService],
})
export class CustomerActivityModule {}
