import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { BlockAction } from "../block-watch.service";

export class BlockActionDto {
  @IsIn(["replaced", "retired", "keep", "snooze"])
  action!: BlockAction;

  /** For a snooze: how long. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  hours?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
