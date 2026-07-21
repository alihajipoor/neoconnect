import { IsUUID } from "class-validator";

export class CreateProtocolUserDto {
  @IsUUID()
  subscriptionId!: string;

  @IsUUID()
  nodeId!: string;

  @IsUUID()
  protocolConfigId!: string;
}
