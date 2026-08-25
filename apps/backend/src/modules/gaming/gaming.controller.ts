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
  UseGuards,
} from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
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

  @Get("profiles")
  listProfiles() {
    return this.gaming.listProfiles();
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
