import { Body, Controller, Get, Header, Post, Put, Res, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { EndpointsService, type EndpointEntry } from "./endpoints.service";

/** The published bundle, served to anyone.
 *
 * Unauthenticated on purpose and this is the whole point of the route: a
 * customer who cannot reach the control plane cannot log in, so anything
 * behind a token is unreachable exactly when it is needed. Nothing here
 * is secret -- the file is signed, public by design, and meant to be
 * mirrored onto hosts that are not ours.
 */
@ApiExcludeController()
@Controller("endpoints")
export class PublicEndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get("bundle")
  // No-store: a censor-facing address list that a proxy holds onto is a
  // client stuck on retired endpoints after a rotation.
  @Header("Cache-Control", "no-store")
  @Header("Content-Type", "application/json")
  async bundle(@Res() res: Response) {
    res.send(await this.endpoints.published());
  }
}

@ApiExcludeController()
@UseGuards(JwtAuthGuard)
@Controller("admin/endpoints")
export class AdminEndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  /** The unsigned draft, to be signed offline. */
  @Get("draft")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  draft() {
    return this.endpoints.draft();
  }

  /** Accepts the signed envelope produced by scripts/endpoints/bundle.mjs. */
  @Put("bundle")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  publish(@Body() body: { signed?: string }) {
    return this.endpoints.publish(String(body?.signed ?? ""));
  }

  @Post("panel-bases")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  async setBases(@Body() body: { entries?: EndpointEntry[] }) {
    await this.endpoints.setPanelBases(body?.entries ?? []);
    return { ok: true };
  }
}
