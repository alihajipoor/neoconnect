import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { AuthenticatedCustomer } from "./types";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { LoginDto } from "../auth/dto/login.dto";
import { RefreshDto } from "../auth/dto/refresh.dto";

// This is the API a future native client (Windows/macOS/Android/iOS)
// signs up and logs in through -- there is deliberately no web UI for
// any of this (see the "Customer Self-Signup + Free Trial Mode" plan
// section): the native clients are Phase 2 and don't exist yet, so this
// milestone is API-only, same precedent as Nodes/Routes before their
// panel UI existed (or, for Routes, still does).
@ApiTags("customer-auth")
@Controller("customer-auth")
export class CustomerAuthController {
  constructor(private readonly customerAuthService: CustomerAuthService) {}

  // Same brute-force reasoning as admin login, plus this is also the
  // free-trial-grant endpoint -- an unlimited signup rate would be a
  // direct path to scripted free-VPN abuse. Rate limiting is the only
  // mitigation in this pass (no email verification/CAPTCHA infra exists
  // yet -- see the plan's explicitly-flagged v1 limitations).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: CreateCustomerDto) {
    return this.customerAuthService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.customerAuthService.login(dto.email, dto.password);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.customerAuthService.refresh(dto.refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(CustomerJwtAuthGuard)
  async logout(@CurrentCustomer() customer: AuthenticatedCustomer) {
    await this.customerAuthService.revokeAllSessions(customer.sub);
  }
}
