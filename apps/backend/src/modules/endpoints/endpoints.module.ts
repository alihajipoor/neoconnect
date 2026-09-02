import { Module } from "@nestjs/common";
import { AdminEndpointsController, PublicEndpointsController } from "./endpoints.controller";
import { EndpointsService } from "./endpoints.service";

@Module({
  controllers: [PublicEndpointsController, AdminEndpointsController],
  providers: [EndpointsService],
  exports: [EndpointsService],
})
export class EndpointsModule {}
