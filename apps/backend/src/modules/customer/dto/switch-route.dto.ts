import { IsUUID } from "class-validator";

export class SwitchRouteDto {
  @IsUUID()
  routeId!: string;
}
