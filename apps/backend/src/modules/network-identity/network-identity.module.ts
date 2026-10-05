import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AsnLookupService } from "./asn-lookup.service";
import { NetworkIdentityService } from "./network-identity.service";

/** Which network a caller is on, and the signed note that lets a client
 * carry that answer past the moment its own address stops being
 * visible. Used by /health/ip (issues), the attempt log (verifies) and
 * the route list (both). */
@Module({
  imports: [PrismaModule],
  providers: [AsnLookupService, NetworkIdentityService],
  exports: [AsnLookupService, NetworkIdentityService],
})
export class NetworkIdentityModule {}
