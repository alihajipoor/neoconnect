import { Controller, Get, UseGuards } from "@nestjs/common";

import { ServiceTokenGuard } from "../../common/guards/service-token.guard";
import { IntegrationsService } from "./integrations.service";

/**
 * The surface the Discord bot talks to. Read-only by construction: there is
 * no write route here, so a leaked service token costs disclosure of facts
 * that are already public in the Discord channel, not control of anything.
 */
@UseGuards(ServiceTokenGuard)
@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get("status")
  status() {
    return this.integrations.status();
  }

  @Get("plans")
  plans() {
    return this.integrations.publicPlans();
  }

  @Get("download")
  download() {
    return this.integrations.download();
  }

  @Get("releases")
  releases() {
    return this.integrations.releases();
  }
}
