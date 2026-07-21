import { IsUUID } from "class-validator";

export class CreateProtocolUserDto {
  @IsUUID()
  subscriptionId!: string;

  /** Which "server" the customer picked -- resolves to a node/protocol
   * via Route.entryProtocolConfig. Direct or relayed is transparent
   * here; either way the customer is only ever provisioned on the
   * entry engine (see routes.service.ts for the relay-side wiring). */
  @IsUUID()
  routeId!: string;
}
