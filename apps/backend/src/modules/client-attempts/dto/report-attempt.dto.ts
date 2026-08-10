import { ClientAttemptKind, ClientAttemptOutcome } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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

  /** "windows" | "android". Not an enum: a new platform should show up
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
}
