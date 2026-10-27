import { Module } from "@nestjs/common";
import { InsideProbeController } from "./inside-probe.controller";
import { InsideProbeService } from "./inside-probe.service";

@Module({
  controllers: [InsideProbeController],
  providers: [InsideProbeService],
})
export class InsideProbeModule {}
