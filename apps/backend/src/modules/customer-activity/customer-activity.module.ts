import { Module } from "@nestjs/common";
import { CustomerAuthModule } from "../customer-auth/customer-auth.module";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { UpdatesModule } from "../updates/updates.module";
import { CustomerActivityController, MonitorController, ServiceChecksController } from "./customer-activity.controller";
import { CustomerActivityService } from "./customer-activity.service";
import { CustomerInsightService } from "./customer-insight.service";

/** GET /customers/:id/activity, POST /customers/:id/sessions/:sessionId/sign-out
 * and GET /monitor/live: what staff see of a customer's connections; and
 * GET /customers/:id/insight, /attempts, /usage, /history and
 * /diagnostics, the same customer in depth; and GET
 * /service-checks/summary, the apps' service checks across customers.
 *
 * Its own module so it can import customer-auth (signing a device out is
 * revokeSession, as for the customer's own app), network identity
 * (naming the network an attempt came from) and updates (the newest
 * release it already knows, for "app behind") without either importing
 * anything new. Nothing imports it. */
@Module({
  imports: [CustomerAuthModule, NetworkIdentityModule, UpdatesModule],
  controllers: [CustomerActivityController, MonitorController, ServiceChecksController],
  providers: [CustomerActivityService, CustomerInsightService],
})
export class CustomerActivityModule {}
