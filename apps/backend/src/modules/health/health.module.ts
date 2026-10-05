import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";

@Module({
  imports: [NetworkIdentityModule],
  controllers: [HealthController],
})
export class HealthModule {}
