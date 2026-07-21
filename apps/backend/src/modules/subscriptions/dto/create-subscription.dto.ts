import { IsBoolean, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateSubscriptionDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  planId!: string;

  @IsOptional()
  @IsString()
  nodeId?: string;

  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}
