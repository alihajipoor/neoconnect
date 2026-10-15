import { ApiPropertyOptional } from "@nestjs/swagger";
import { RelayAuthMode } from "@prisma/client";
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";

export class UpdateRelayAuthDto {
  @ApiPropertyOptional({ enum: RelayAuthMode })
  @IsOptional()
  @IsEnum(RelayAuthMode)
  mode?: RelayAuthMode;

  /** Hosting/IDC networks, by number. The whole list, not a change to it. */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(4_294_967_295, { each: true })
  hostingAsns?: number[];
}
