import { PlanFeatureKey } from "@prisma/client";
import { ArrayUnique, IsArray, IsEnum } from "class-validator";

export class SetPlanFeaturesDto {
  /** The complete set of features this plan grants, not a delta.
   *
   * Whole-set semantics on purpose: `SubscriptionPlan.allowedRoutes` uses
   * `set` on update for the same reason -- with a delta, deselecting
   * something in the panel does nothing, which is the failure mode where the
   * operator believes they revoked a capability and did not. An empty array
   * revokes everything, and that has to be expressible. */
  @IsArray()
  @ArrayUnique()
  @IsEnum(PlanFeatureKey, { each: true })
  features!: PlanFeatureKey[];
}
