import { IsBoolean, IsInt, IsObject, IsOptional, Matches, Max, Min, ValidateIf } from "class-validator";

/** Deliberately cannot change `nodeId` or `protocol`.
 *
 * Both are baked into every ProtocolUser already provisioned against
 * this config -- the node is where their agent commands get sent, and
 * the protocol determines the shape of their credentials. Editing either
 * would silently invalidate live customer connections while looking like
 * a routine correction, so those require deleting and recreating (which
 * forces the existing users to be dealt with explicitly). */
export class UpdateProtocolConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  listenPort?: number;

  @IsOptional()
  @IsObject()
  publicParamsJson?: Record<string, unknown>;

  /** Which Xray inbound on the node serves this config.
   *
   * `null` clears it back to the node's default tag for this protocol
   * and transport -- the one the agent was started with, which is what
   * every ordinary node uses. Absent leaves it alone.
   *
   * This was previously settable only at create time, which made it
   * unfixable in practice: `remove()` refuses while any customer or
   * route references the config, so correcting a tag meant either
   * tearing down live provisioning or writing the row by hand in SQL.
   * The latter is what actually happened, and it is why this field is
   * here -- a panel change that pointed 29 customers at an inbound their
   * clients were not dialling is not a hypothetical, it is the shape of
   * the outage this endpoint is meant to prevent.
   *
   * The field is load-bearing rather than cosmetic. A relayed route's
   * Xray routing rule matches on the entry inbound tag and nothing else,
   * so two configs sharing a tag means the second one's traffic silently
   * egresses through the first one's exit -- created, provisioned,
   * listed in the customer's picker, and leaving from the wrong country
   * with nothing anywhere reporting it. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^[a-z0-9-]{1,64}$/, {
    message: "inboundTag must match the tag in the node's Xray config (lowercase letters, digits and dashes)",
  })
  inboundTag?: string | null;

  /** Acknowledges that changing the tag strands everyone already
   * provisioned on this config until they are re-provisioned.
   *
   * An interlock rather than a warning, because a warning is what the
   * panel already had. The credentials of an existing ProtocolUser were
   * created on the *old* inbound; moving the config's tag does not move
   * them, so from the moment this is saved every one of those customers
   * is dialling an inbound that has never heard of them, and the failure
   * they see is "invalid request user id" with nothing pointing at the
   * cause.
   *
   * The backend refuses the change without this and names the count, so
   * the operator finds out before the outage rather than during it. */
  @IsOptional()
  @IsBoolean()
  confirmReprovision?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
