import { Module } from "@nestjs/common";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { AdminAuditModule } from "../admin-audit/admin-audit.module";
import { SiteVisitsController } from "./site-visits.controller";
import { SiteVisitsService } from "./site-visits.service";

/** Seven days of where each customer's connections went: written from
 * the agents' DestinationBatch messages (AgentGatewayService), read by the
 * owner at GET /customers/:id/sites, pruned by the sweeps queue.
 *
 * Imports network identity (which network owns an address) and the admin
 * audit (every read is logged). No cycle: neither imports anything that
 * leads back here, and the gateway and the jobs module import this one. */
@Module({
  imports: [NetworkIdentityModule, AdminAuditModule],
  controllers: [SiteVisitsController],
  providers: [SiteVisitsService],
  exports: [SiteVisitsService],
})
export class SiteVisitsModule {}
