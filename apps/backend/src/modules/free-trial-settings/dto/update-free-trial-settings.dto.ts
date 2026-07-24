import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class UpdateFreeTrialSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsUUID()
  trialPlanId?: string;

  @IsOptional()
  @IsUUID()
  trialRouteId?: string;
}
