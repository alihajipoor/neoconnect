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

  /** Derived from the selected routes, not chosen.
   *
   * A Route already names the node and the protocol customers reach it
   * on, so asking for a protocol list as well was asking the same
   * question twice and letting the two answers disagree -- a plan could
   * allow Trojan while being pointed only at WireGuard routes, and the
   * intersection silently decided what the customer actually got.
   *
   * Still a column, and still read by provisioning and switchRoute, so
   * it is computed from allowedRouteIds on every write rather than
   * removed. Optional here: the panel no longer sends it.
   */
  @IsOptional()
  @IsArray()
  @IsEnum(Protocol, { each: true })
  protocolsAllowed?: Protocol[];

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

  /** Which routes this plan may be served by.
   *
   * Omitted or empty means NO RESTRICTION -- every route the plan's
   * protocols and its relay policy already allow, which is how every
   * plan behaved before this field existed. That default is what keeps
   * a newly built route reaching existing plans without anyone editing
   * them.
   *
   * A non-empty list only ever narrows. relayOnly and protocolsAllowed
   * still apply on top, so listing a direct route on a relay-only plan
   * grants nothing -- what gets provisioned is the intersection.
   */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  allowedRouteIds?: string[];
}
