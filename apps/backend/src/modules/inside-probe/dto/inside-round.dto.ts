import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class ProbeLegDto {
  /** curl's HTTP status; 0 when no answer came back. */
  @IsInt()
  @Min(0)
  @Max(999)
  status!: number;

  @IsInt()
  @Min(0)
  @Max(10_000_000)
  bytes!: number;

  @IsInt()
  @Min(0)
  @Max(600_000)
  ms!: number;
}

export class InsideResultDto {
  @IsUUID()
  nodeId!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  /** Null when no connection opened. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600_000)
  connectMs!: number | null;

  @ValidateNested()
  @Type(() => ProbeLegDto)
  down!: ProbeLegDto;

  @ValidateNested()
  @Type(() => ProbeLegDto)
  up!: ProbeLegDto;
}

export class InsideRoundDto {
  /** Which box: a short name, never an address. */
  @Matches(/^[a-z0-9-]{1,32}$/)
  vantage!: string;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InsideResultDto)
  results!: InsideResultDto[];
}
