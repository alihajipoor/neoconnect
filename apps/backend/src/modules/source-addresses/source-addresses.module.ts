import { Module } from "@nestjs/common";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { SourceAddressesService } from "./source-addresses.service";

/** The customer's own address for a report sent through the VPN, as the
 * server they connected to saw it (SourceAddressesService).
 *
 * Imports nothing but network identity and the global Prisma, so both
 * sides of the match -- the agent gateway, which hears what the nodes
 * see, and the attempt log, which writes the row -- can import it
 * without a cycle. */
@Module({
  imports: [NetworkIdentityModule],
  providers: [SourceAddressesService],
  exports: [SourceAddressesService],
})
export class SourceAddressesModule {}
