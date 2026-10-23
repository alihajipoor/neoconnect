import { Module } from "@nestjs/common";
import { AlertingModule } from "../alerting/alerting.module";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { BlockWatchController } from "./block-watch.controller";
import { BlockWatchService } from "./block-watch.service";

@Module({
  imports: [AlertingModule, NetworkIdentityModule],
  controllers: [BlockWatchController],
  providers: [BlockWatchService],
  // For the sweep in modules/jobs, which owns the cadence.
  exports: [BlockWatchService],
})
export class BlockWatchModule {}
