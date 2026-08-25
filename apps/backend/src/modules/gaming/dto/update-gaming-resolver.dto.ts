import { PartialType } from "@nestjs/swagger";
import { CreateGamingResolverDto } from "./create-gaming-resolver.dto";

export class UpdateGamingResolverDto extends PartialType(CreateGamingResolverDto) {}
