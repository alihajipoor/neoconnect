import { Module } from "@nestjs/common";
import { ProtocolConfigsController } from "./protocol-configs.controller";
import { ProtocolConfigsService } from "./protocol-configs.service";

@Module({
  controllers: [ProtocolConfigsController],
  providers: [ProtocolConfigsService],
  exports: [ProtocolConfigsService],
})
export class ProtocolConfigsModule {}
