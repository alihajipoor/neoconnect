import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min } from "class-validator";
import { Protocol } from "@prisma/client";

export class CreatePlanDto {
  @IsString()
  name!: string;

  /** Data cap in bytes, as a decimal string to avoid JS number precision loss at large sizes. */
  @IsString()
  dataCapBytes!: string;

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

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(Protocol, { each: true })
  protocolsAllowed!: Protocol[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
