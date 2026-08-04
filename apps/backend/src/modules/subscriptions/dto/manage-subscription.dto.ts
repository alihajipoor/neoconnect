import { IsEnum, IsInt, Max, Min } from "class-validator";
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
