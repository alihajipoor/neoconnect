import { Body, Controller, Headers, Ip, Optional, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional } from "class-validator";
import { LoginGuardService, type LoginScope } from "./login-guard.service";
import type { Challenge } from "./proof-of-work";
import { RelayAuthService } from "../relay-auth/relay-auth.service";
import { POW_FLOOR_BITS } from "../relay-auth/relay-policy";
import { relayContextOf } from "../../common/relay/relay-arrival";
import { callerKey, installIdOf } from "../../common/relay/caller-key";

export class RequestChallengeDto {
  /** "relay-signup" is the relay sign-up (docs/relay-last-resort.md,
   * R3.5), whose difficulty RelayAuthService sets. */
  @IsIn(["admin", "customer", "reseller", "relay-signup"])
  scope!: LoginScope | "relay-signup";

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
  constructor(
    private readonly loginGuard: LoginGuardService,
    // Optional for the specs that mount this controller alone; without
    // it a relay sign-up challenge is minted at the floor.
    @Optional() private readonly relay?: RelayAuthService,
  ) {}

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
  request(
    @Body() dto: RequestChallengeDto,
    @Ip() ip: string,
    @Req() req: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Challenge {
    if (dto.scope === "relay-signup") {
      const bits = this.relay?.signupPowBits(relayContextOf(req), installIdOf(headers)) ?? POW_FLOOR_BITS;
      return this.loginGuard.issueAt(bits);
    }
    return this.loginGuard.issue(dto.scope, dto.email, callerKey(req, ip));
  }
}
