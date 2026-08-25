import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

/** Upper bounds on the curated lists.
 *
 * Not a guess at what a game needs -- Blizzard's whole launcher/login/store
 * surface is sixteen hostnames -- but a ceiling on what one profile can push
 * into a client. Every hostname here becomes an NRPT rule on the customer's
 * machine, and NRPT rules are machine-wide: a profile with a thousand of them
 * is a profile that takes somebody's DNS down. */
const MAX_HOSTNAMES = 128;
const MAX_CIDRS = 512;

/** A DNS name, lowercase, no scheme, no path, no port, no trailing dot, and
 * at least two labels.
 *
 * Deliberately refuses anything that looks like an IPv4 literal. A hostname
 * list that accepts `37.244.62.99` would look like it was doing something and
 * would do nothing at all: the resolver never sees an address the client
 * already has. Rejecting it here is how the operator finds that out at the
 * form rather than after a support ticket. */
const HOSTNAME = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** IPv4 or IPv6 CIDR. Kept strict because these become routing decisions. */
const CIDR =
  /^(?:(?:\d{1,3}\.){3}\d{1,3}\/(?:3[0-2]|[12]?\d)|[0-9a-fA-F:]+\/(?:12[0-8]|1[01]\d|\d{1,2}))$/;

export class CreateGameProfileDto {
  /** URL-safe identifier the clients key their stored selection on.
   *
   * Immutable in practice: a customer's chosen games are persisted by slug on
   * their machine, so renaming one silently deselects the game for everybody
   * who had picked it. Change `displayName` instead. */
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "slug must be lowercase letters, digits and single hyphens",
  })
  @MaxLength(64)
  slug!: string;

  @IsString()
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(120)
  publisher?: string | null;

  /** Names an icon the client already ships. Never a URL: the picker has to
   * render with no network at all, and an icon fetched from a
   * Neoxify-looking host is a request that gets blocked in Iran, which would
   * leave the picker looking broken for exactly the customers it exists
   * for. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(64)
  iconKey?: string | null;

  /** Launcher, login, account, web and store hosts.
   *
   * Not the game's own realm or world servers. Those addresses arrive inside
   * the game's session as literals and never pass through a resolver, so
   * listing them here has no effect whatsoever. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HOSTNAMES)
  @Matches(HOSTNAME, { each: true, message: "hostnames must be DNS names, not addresses or URLs" })
  hostnames?: string[];

  /** Hostnames left on the customer's own path on purpose.
   *
   * Patch and CDN hosts belong here. They serve multi-gigabyte downloads, and
   * carrying those through a node eats a metered plan's cap -- a bill the
   * customer did not expect, caused by us. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HOSTNAMES)
  @Matches(HOSTNAME, { each: true, message: "excludeHostnames must be DNS names" })
  excludeHostnames?: string[];

  /** Windows process names covering launcher and game together, so one row is
   * one game. Used only by the per-game private exit, which is not built. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HOSTNAMES)
  @IsString({ each: true })
  processNames?: string[];

  /** Whole announced prefixes for the publisher's address space, for the
   * unbuilt private exit. Never individual hosts -- see the schema comment
   * and section 5.4 of docs/design/gaming-mode.md. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CIDRS)
  @Matches(CIDR, { each: true, message: "destinationCidrs must be CIDR blocks" })
  destinationCidrs?: string[];

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(/^AS\d+$/, { message: "destinationAsn looks like AS57976" })
  destinationAsn?: string | null;

  @IsOptional()
  @IsBoolean()
  prefixComplete?: boolean;

  /** Must be one of `hostnames`; the service enforces that, because a canary
   * that is not redirected would confirm nothing and would still let the
   * client claim the mode is working. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(HOSTNAME, { message: "canaryHostname must be a DNS name" })
  canaryHostname?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
