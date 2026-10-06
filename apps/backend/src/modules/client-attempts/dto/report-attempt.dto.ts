import { ClientAttemptKind, ClientAttemptOutcome } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/** The longest `apiEndpoint` accepted.
 *
 * It was 200. Clients from desktop 0.9.39 and mobile 0.2.22 on fill it
 * with the hostname of every control-plane address they would try, and
 * only on a CONTROL_PLANE_UNREACHABLE report; worked out from the code,
 * eleven names with the current endpoint bundle come to 233 characters.
 * Over the limit the global ValidationPipe answers 400, and the client
 * counts a 400 as delivered (attempts.ts `send`), so such a report would
 * be neither stored nor queued.
 *
 * It was once written here that every unreachable report from those
 * builds had been lost that way. The server's own log says otherwise:
 * in the 14 days to 2026-10-06 production answered 1079 POST
 * /api/client-attempts with 204 and not one with a 400 -- and no stored
 * row has `apiEndpoint` set. So no report carrying the list arrived at
 * all in that window; the 400 was never put to the test.
 *
 * 2000 holds the per-address trace newer clients send -- address,
 * outcome and milliseconds for each one tried, in each phase -- with
 * room for the mirror list to grow. A newer client sending that to a
 * server still on 200 would hit the 400; it resends once cut to fit (see
 * `send`). Still bounded, because this endpoint is unauthenticated; the
 * column is TEXT, so no migration. */
export const API_ENDPOINT_MAX_LENGTH = 2000;

/** One rung of the failover ladder, as the app recorded it.
 *
 * The client already builds exactly this to show under "show details";
 * it is the difference between "could not connect" and "Fast was
 * refused, Stealth came up but carried nothing, Stealth HTTPS worked".
 */
export class AttemptRungDto {
  @IsString()
  @MaxLength(64)
  protocol!: string;

  @IsString()
  @MaxLength(200)
  result!: string;

  /** Which route this rung dialled. Present only on a rung that actually
   * reached the network -- a skipped rung, or one refused for reasons
   * that are not the network's (quota, an engine that would not start),
   * carries none, so it counts for nothing in the per-ISP tags. */
  @IsOptional()
  @IsUUID()
  routeId?: string;

  /** Whether that dial carried traffic, by the egress check. Only
   * meaningful alongside `routeId`. */
  @IsOptional()
  @IsBoolean()
  carried?: boolean;
}

/** A client reporting what happened to it.
 *
 * Every field is bounded, because this endpoint takes anonymous
 * submissions -- the reports worth having come from somebody who could
 * not sign in, so requiring a token would exclude exactly the cases this
 * exists for. Unbounded text from an unauthenticated caller is a way to
 * fill a disk.
 */
export class ReportAttemptDto {
  @IsEnum(ClientAttemptKind)
  kind!: ClientAttemptKind;

  @IsEnum(ClientAttemptOutcome)
  outcome!: ClientAttemptOutcome;

  /** "windows" | "macos" | "android" | "ios", or "unknown" from a client
   * that could not tell. Not an enum: a new platform should show up
   * in the panel as itself rather than be rejected by a server that has
   * not been redeployed. Not stored verbatim either -- see
   * `recordedPlatform` for the mobile builds that called iOS "windows". */
  @IsString()
  @MaxLength(32)
  platform!: string;

  @IsString()
  @MaxLength(32)
  appVersion!: string;

  @IsOptional()
  @IsUUID()
  routeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  protocol?: string;

  /** Which control-plane addresses were tried and how each one failed,
   * on a CONTROL_PLANE_UNREACHABLE report. See `API_ENDPOINT_MAX_LENGTH`
   * for why the bound is what it is. */
  @IsOptional()
  @IsString()
  @MaxLength(API_ENDPOINT_MAX_LENGTH)
  apiEndpoint?: string;

  /** The app's own error text. Free-form on purpose -- the enum is for
   * filtering, this is for understanding -- but truncated on write. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttemptRungDto)
  attempts?: AttemptRungDto[];

  /** When it happened, ISO 8601, if that is not now.
   *
   * A client that could not reach the control plane cannot report so
   * until it can, which may be much later -- and that is the bucket this
   * whole endpoint exists for. Without this the panel would date an
   * outage to the moment somebody got back online.
   *
   * Validated as a date string and nothing more. It is unauthenticated
   * input, so the server keeps its own arrival time as the field
   * everything sorts and prunes by; this is only ever displayed.
   */
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  /** The network attestation the client was handed by /health/ip before
   * its tunnel came up (see network-attestation.ts). Opaque to the
   * client; verified here, and only the ASN it vouches for is stored. A
   * token that does not verify is dropped and the report kept. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  network?: string;

  /** For a SESSION report: seconds the tunnel had been carrying traffic.
   * Capped at a week -- the client sends this once, ten minutes in, so
   * anything near the cap is a broken clock rather than a long session. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7 * 86_400)
  sessionSeconds?: number;
}
