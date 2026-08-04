import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ClientAttemptKind, ClientAttemptOutcome } from "@prisma/client";
import type { Request } from "express";
import { ClientAttemptsService } from "./client-attempts.service";
import { ReportAttemptDto } from "./dto/report-attempt.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { clientIpOf } from "../../common/client-ip";
import type { CustomerAccessTokenPayload } from "../customer-auth/types";

@ApiTags("client-attempts")
@Controller()
export class ClientAttemptsController {
  constructor(
    private readonly attempts: ClientAttemptsService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** The customer behind a report, when there is one and it can be
   * proven.
   *
   * Deliberately not a guard. Most of what this endpoint exists to
   * capture happens before there is any session at all -- a failed
   * registration, a sign-in that never reached the server -- so
   * requiring a token would drop exactly the reports worth having.
   * Equally, an id must never be taken from the body: attributing one
   * customer's failures to another on their say-so would make the whole
   * table untrustworthy.
   *
   * So the token is verified if present and ignored entirely if not.
   * An expired or forged one leaves the report anonymous rather than
   * rejecting it.
   */
  private customerIdFrom(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    try {
      const payload = this.jwt.verify<CustomerAccessTokenPayload>(header.slice(7), {
        secret: this.config.get<string>("customerJwt.accessSecret"),
      });
      return payload.sub;
    } catch {
      return undefined;
    }
  }

  /**
   * A client reporting how an attempt went.
   *
   * Unauthenticated on purpose, and that is the whole design. The reports
   * worth having are from somebody who could not sign in or could not
   * reach the control plane at all -- requiring a token would collect
   * exactly the cases that already work.
   *
   * The cost is that anyone can post here, so every field is bounded by
   * the DTO, the service truncates and caps arrays, rows expire on a
   * short window, and this is throttled harder than the rest of the API.
   * Twenty a minute is far above what a client generates -- one per
   * connect, one per sign-in -- and far below what would fill anything.
   *
   * Hidden from the public API docs: it is an internal channel, not
   * something to invite use of.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @HttpCode(204)
  @Post("client-attempts")
  async report(@Body() dto: ReportAttemptDto, @Req() req: Request): Promise<void> {
    // Both taken from the request rather than the body. A client cannot
    // be trusted to say who or where it is, and for most of these
    // reports there is no session to say who.
    await this.attempts.record(dto, {
      ip: clientIpOf(req),
      customerId: this.customerIdFrom(req),
    });
    // Always 204, whatever happened inside. A client that just failed to
    // connect must not also be told its complaint was rejected.
  }

  /** The panel's list. Any admin may read it -- diagnosing a beta is
   * support work, not privileged configuration. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("client-attempts")
  list(
    @Query("outcome") outcome?: ClientAttemptOutcome,
    @Query("kind") kind?: ClientAttemptKind,
    @Query("platform") platform?: string,
    @Query("failuresOnly") failuresOnly?: string,
    @Query("take") take?: string,
  ) {
    return this.attempts.list({
      outcome,
      kind,
      platform,
      failuresOnly: failuresOnly === "true",
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("client-attempts/summary")
  summary(@Query("hours") hours?: string) {
    return this.attempts.summary(hours ? Number.parseInt(hours, 10) : undefined);
  }
}
