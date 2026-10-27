import { Body, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SkipThrottle } from "@nestjs/throttler";
import { timingSafeEqual } from "node:crypto";
import { InsideRoundDto } from "./dto/inside-round.dto";
import { InsideProbeService } from "./inside-probe.service";

/** Where the panel host's collector posts each box's round
 * (scripts/inside-probe/collect.sh). Not for customers or staff: it takes
 * a token from the panel host's own settings, compared in constant time,
 * and is refused outright while none is set. */
@Controller("inside-probe")
export class InsideProbeController {
  constructor(
    private readonly probe: InsideProbeService,
    private readonly config: ConfigService,
  ) {}

  @SkipThrottle()
  @Post("results")
  @HttpCode(HttpStatus.OK)
  async results(@Headers("x-probe-token") token: string | undefined, @Body() round: InsideRoundDto) {
    if (!tokenMatches(this.config.get<string>("insideProbe.token"), token)) throw new ForbiddenException();
    const stored = await this.probe.record(round.vantage, round.results);
    return { stored };
  }
}

export function tokenMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || expected.length < 32 || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
