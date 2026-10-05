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

  /** "windows" | "macos" | "android" | "ios". Not an enum: a new platform should show up
   * in the panel as itself rather than be rejected by a server that has
   * not been redeployed. */
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

  @IsOptional()
  @IsString()
  @MaxLength(200)
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
