import { IsEnum, IsIP, IsString, MinLength } from "class-validator";
import { NodeRole } from "@prisma/client";

export class CreateNodeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(NodeRole)
  role!: NodeRole;

  @IsString()
  @MinLength(1)
  region!: string;

  @IsIP()
  publicIp!: string;
}
