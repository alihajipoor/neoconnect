import { Module } from "@nestjs/common";

import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { PlansModule } from "../plans/plans.module";
import { UpdatesModule } from "../updates/updates.module";

/** Read-only endpoints for machine callers -- currently the Discord bot.
 * Deliberately reuses PlansService and UpdatesService rather than
 * re-querying, so plan pricing and installer URLs cannot drift between what
 * the panel shows and what the bot says. */
@Module({
  imports: [PlansModule, UpdatesModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
