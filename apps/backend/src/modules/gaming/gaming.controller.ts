import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminRole } from "@prisma/client";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { listWindow, sendPage } from "../../common/pagination";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { GamingService } from "./gaming.service";
import { CreateGameProfileDto } from "./dto/create-game-profile.dto";
import { UpdateGameProfileDto } from "./dto/update-game-profile.dto";
import { CreateGamingResolverDto } from "./dto/create-gaming-resolver.dto";
import { UpdateGamingResolverDto } from "./dto/update-gaming-resolver.dto";
import { SetPlanFeaturesDto } from "./dto/set-plan-features.dto";

/** The operator's side of Gaming Mode: which games exist, which nodes serve
 * the resolver, and which plans include it.
 *
 * Reads are open to any staff role so support can answer "is this on for my
 * customer" without needing SUPERADMIN. Writes are SUPERADMIN only, matching
 * plans and nodes -- a game profile decides what gets redirected on a
 * customer's machine, and a resolver row decides which address their lookups
 * are handed to.
 *
 * There is no customer-facing route on this controller. The customer surface
 * is a single method on CustomerController, guarded by the customer JWT,
 * because a public route added to a class carrying an admin guard inherits
 * that guard silently -- the reason VouchersModule keeps two controllers. */
@ApiTags("gaming")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("gaming")
export class GamingController {
  constructor(private readonly gaming: GamingService) {}

  // ---- Game profiles ------------------------------------------------------

  /** The operator's game list, paged.
   *
   * `isActive` defaults to `"true"`. A deactivated profile is one taken
   * out of circulation, and the panel should not present it alongside the
   * live ones by default -- but `"all"` and `"false"` exist, because a
   * profile nothing lists is a profile nobody can turn back on.
   *
   * `take`/`skip` and the `X-Total-Count` header follow the convention in
   * common/pagination.ts. The body is still a bare array, so nothing that
   * reads this route today has to change to keep working.
   */
  @Get("profiles")
  async listProfiles(
    @Res({ passthrough: true }) res: Response,
    @Query("isActive") isActive?: string,
    @Query("q") q?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    // 100 rather than the catalogue's 1,480: it fills a table without a
    // second request and is 22x less JSON than the whole thing.
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(
      res,
      await this.gaming.listProfiles({
        isActive: isActive === "all" ? undefined : isActive !== "false",
        search: q?.trim() || undefined,
        window,
      }),
    );
  }

  @Get("profiles/:id")
  getProfile(@Param("id") id: string) {
    return this.gaming.getProfile(id);
  }

  @Post("profiles")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  createProfile(@Body() dto: CreateGameProfileDto) {
    return this.gaming.createProfile(dto);
  }

  @Patch("profiles/:id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  updateProfile(@Param("id") id: string, @Body() dto: UpdateGameProfileDto) {
    return this.gaming.updateProfile(id, dto);
  }

  @Delete("profiles/:id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeProfile(@Param("id") id: string) {
    await this.gaming.removeProfile(id);
  }

  // ---- Resolvers ----------------------------------------------------------

  @Get("resolvers")
  listResolvers() {
    return this.gaming.listResolvers();
  }

  @Post("resolvers")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  createResolver(@Body() dto: CreateGamingResolverDto) {
    return this.gaming.createResolver(dto);
  }

  @Patch("resolvers/:id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  updateResolver(@Param("id") id: string, @Body() dto: UpdateGamingResolverDto) {
    return this.gaming.updateResolver(id, dto);
  }

  @Delete("resolvers/:id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeResolver(@Param("id") id: string) {
    await this.gaming.removeResolver(id);
  }

  // ---- Plan features ------------------------------------------------------

  @Get("plan-features")
  listPlanFeatures() {
    return this.gaming.listPlanFeatures();
  }

  @Put("plan-features/:planId")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  setPlanFeatures(@Param("planId") planId: string, @Body() dto: SetPlanFeaturesDto) {
    return this.gaming.setPlanFeatures(planId, dto.features);
  }
}
