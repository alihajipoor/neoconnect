import { PartialType } from "@nestjs/swagger";
import { CreateGameProfileDto } from "./create-game-profile.dto";

export class UpdateGameProfileDto extends PartialType(CreateGameProfileDto) {}
