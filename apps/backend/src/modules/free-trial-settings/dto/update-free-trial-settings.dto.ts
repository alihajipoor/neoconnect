import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class UpdateFreeTrialSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** The plan a new sign-up's trial is on. Its own route list decides
   * where the trial may connect; there is no separate trial route. */
  @IsOptional()
  @IsUUID()
  trialPlanId?: string;
}
