import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ClientAttemptKind, ClientAttemptOutcome } from "@prisma/client";
import type { Request } from "express";
import { ClientAttemptsService, RETENTION_DAYS } from "./client-attempts.service";
import { ReportAttemptDto } from "./dto/report-attempt.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ThrottleVolumePerSession } from "../../common/guards/client-throttler.guard";
import { clientIpOf } from "../../common/client-ip";
import type { CustomerAccessTokenPayload } from "../customer-auth/types";

/** How long after its expiry a customer's access token still files a
 * report under them. The retention window: a report older than that is
 * not kept anyway (`plausibleOccurredAt`), and a client drops it unsent. */
export const ATTRIBUTION_GRACE_MS = RETENTION_DAYS * 86_400_000;

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
   * A forged one leaves the report anonymous rather than rejecting it.
   *
   * An expired one is accepted, here and nowhere else, if it expired
   * inside the retention window (`ATTRIBUTION_GRACE_MS`). The reports this
   * endpoint exists for are the ones a client could not send when they
   * happened: it queues them and sends them on the next contact, with the
   * token of the session they happened in -- and by then the fifteen-minute
   * access token has almost always run out. Verified with expiry, such a
   * report arrived anonymous; on the test VM the first unreachable report
   * of an outage was made at 23:52:40, delivered three minutes later, and
   * filed under nobody. The signature still has to verify, so this is
   * still proof of who the session belonged to. All it lets a token do
   * past its expiry is file a report under its own customer: it opens
   * nothing, and the throttle still counts it against the address
   * (ClientThrottlerGuard verifies with expiry).
   *
   * A sign-in token only, as CustomerJwtStrategy accepts: the emailed
   * verify-email and password-reset tokens are signed with the same
   * secret, and an account that never verified would otherwise count as
   * one of the distinct customers the per-ISP tags require.
   */
  private customerIdFrom(req: Request, now = Date.now()): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    try {
      const payload = this.jwt.verify<CustomerAccessTokenPayload & { purpose?: unknown; exp?: unknown }>(
        header.slice(7),
        { secret: this.config.get<string>("customerJwt.accessSecret"), ignoreExpiration: true },
      );
      if (payload.purpose !== undefined) return undefined;
      // Only the expiry is relaxed, and only this far. A token without one
      // is taken as the ordinary verification would take it.
      if (typeof payload.exp === "number" && payload.exp * 1000 < now - ATTRIBUTION_GRACE_MS) return undefined;
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
   * Per signed-in session when the report carries a sign-in token, per
   * address otherwise: there is nothing to guess here, and per address
   * every customer behind one node mirror shared the twenty.
   *
   * Hidden from the public API docs: it is an internal channel, not
   * something to invite use of.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ThrottleVolumePerSession()
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
