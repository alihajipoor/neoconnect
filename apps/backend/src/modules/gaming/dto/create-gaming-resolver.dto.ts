import { IsBoolean, IsInt, IsIP, IsOptional, IsString, Matches, Max, Min } from "class-validator";

export class CreateGamingResolverDto {
  @IsString()
  nodeId!: string;

  /** The host the DoH endpoint answers on.
   *
   * Deliberately a separate field from anything on Node, because it must not
   * be a Neoxify-looking name. OONI shows roughly 94% of VPN vendor sites
   * blocked in Iran, so a resolver on a name that looks like ours is a
   * resolver that gets blocked -- and unlike a website, a blocked resolver
   * fails silently in a way the customer reads as "the app is broken". */
  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: "dohHost must be a DNS name",
  })
  dohHost!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  dohPort?: number;

  /** The address the SNI proxy answers on, and therefore the exact value the
   * client's canary has to observe before it may claim the mode is working.
   *
   * An address, not a name: the client compares a resolved answer against it,
   * and comparing a name against a name would prove nothing. */
  @IsIP()
  proxyIp!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  proxyPort?: number;

  /** Off by default. Turning it on says the operator intends this node to
   * serve gaming mode; it does not say the node is doing so. Only the node's
   * own confirmation does that, and until it arrives no client is told the
   * resolver exists. */
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
