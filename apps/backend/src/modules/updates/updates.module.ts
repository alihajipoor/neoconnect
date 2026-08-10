import { Module } from "@nestjs/common";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";

@Module({
  controllers: [UpdatesController],
  providers: [UpdatesService],
  // Exported so IntegrationsModule can answer "where do I download the app"
  // from the same source the updater uses.
  exports: [UpdatesService],
})
export class UpdatesModule {}
