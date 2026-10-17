import { IsEnum, IsInt, IsUUID, Matches, Max, Min, ValidateIf } from "class-validator";
import { SubscriptionStatus } from "@prisma/client";

export class SetSubscriptionStatusDto {
  @IsEnum(SubscriptionStatus)
  status!: SubscriptionStatus;
}

export class ExtendSubscriptionDto {
  /** Bounded rather than open-ended: a mistyped 3650 is a decade of
   * free service, and there is no legitimate single extension that
   * large. Two years is well past any plan sold. */
  @IsInt()
  @Min(1)
  @Max(730)
  days!: number;
}

export class SetDataCapDto {
  /** This subscription's own cap in bytes, as a decimal string for the
   * same reason the plan's is: BigInt does not survive JSON as a number.
   *
   * Null means unlimited. Present-and-null is the point, so it is not
   * optional: a body that forgot the field must not read as "unlimited".
   * Up to 16 digits is about 8 PB, far past anything sold, and keeps a
   * typo of extra zeros from being taken at face value. */
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^[1-9]\d{0,15}$/, { message: "dataCapBytes must be a positive whole number of bytes, or null" })
  dataCapBytes!: string | null;
}

export class ChangePlanDto {
  @IsUUID()
  planId!: string;
}

export class AssignPlanDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  planId!: string;
}
