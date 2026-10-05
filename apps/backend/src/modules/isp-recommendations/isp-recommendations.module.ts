import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NetworkIdentityModule } from "../network-identity/network-identity.module";
import { IspRecommendationsController } from "./isp-recommendations.controller";
import { IspRecommendationsService } from "./isp-recommendations.service";

@Module({
  imports: [PrismaModule, NetworkIdentityModule],
  controllers: [IspRecommendationsController],
  providers: [IspRecommendationsService],
  // For the customer route list, which attaches the tags.
  exports: [IspRecommendationsService],
})
export class IspRecommendationsModule {}
