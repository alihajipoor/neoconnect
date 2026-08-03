import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, Min, ValidateIf } from "class-validator";
import { Protocol } from "@prisma/client";

export class CreatePlanDto {
  @IsString()
  name!: string;

  /** Data cap in bytes, as a decimal string to avoid JS number
   * precision loss at large sizes.
   *
   * Null means unlimited. Metered and unmetered plans have to coexist:
   * a relay through an Iranian VPS is capped because that VPS's own
   * allowance is small, while a direct foreign route need not be. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  dataCapBytes?: string | null;

  @IsInt()
  @IsPositive()
  durationDays!: number;

  @IsNumber()
  @Min(0)
  priceUsd!: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxConcurrentConnections?: number;

  /** Per-user download cap in Mbit/s. Omit for uncapped.
   *
   * Applied on the node to every user provisioned on this plan, so a few
   * customers downloading at once can no longer saturate the VPS.
   */
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(10_000)
  maxDownloadMbps?: number;

  /** Per-user upload cap in Mbit/s. Omit for uncapped. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(10_000)
  maxUploadMbps?: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(Protocol, { each: true })
  protocolsAllowed!: Protocol[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Which Route a customer purchasing this plan gets provisioned on
   * once payment clears -- see BillingService.confirmPayment(). Same v1
   * simplification as FreeTrialSettings.trialRouteId (one admin-picked
   * default, no per-purchase server picker yet). */
  @IsOptional()
  @IsUUID()
  defaultRouteId?: string;
}
