import { Body, Controller, Ip, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional } from "class-validator";
import { LoginGuardService, type LoginScope } from "./login-guard.service";
import type { Challenge } from "./proof-of-work";

export class RequestChallengeDto {
  @IsIn(["admin", "customer", "reseller"])
  scope!: LoginScope;

  /**
   * Optional, and only ever used to look up a failure counter.
   *
   * Sent in the body rather than a query string on purpose: a query
   * string is the one part of a request that reliably ends up in access
   * logs and proxy logs, and an email address does not belong there.
   */
  @IsOptional()
  @IsEmail()
  email?: string;
}

@ApiTags("auth")
@Controller("login-challenge")
export class LoginGuardController {
  constructor(private readonly loginGuard: LoginGuardService) {}

  /**
   * Hand out a proof-of-work challenge to be solved and submitted with
   * the next sign-in or registration attempt.
   *
   * Throttled generously compared with login itself: a client legitimately
   * fetches a fresh challenge per attempt, and a mistyped password
   * should not run anyone out of budget. Minting is cheap for us and
   * the solving is what costs the caller, so this limit is here to stop
   * absurd volume rather than to be a real control.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: "Request a proof-of-work challenge for a login attempt" })
  request(@Body() dto: RequestChallengeDto, @Ip() ip: string): Challenge {
    return this.loginGuard.issue(dto.scope, dto.email, ip);
  }
}
