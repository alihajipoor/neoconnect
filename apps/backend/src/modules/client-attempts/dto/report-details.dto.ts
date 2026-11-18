import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  buildMessage,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  isIP,
  IsIP,
  IsOptional,
  IsString,
  isURL,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
  type ValidationOptions,
} from "class-validator";

/** The optional `details` object a report (POST /client-attempts) and a
 * diagnostics bundle (POST /customer/diagnostics) may carry. The exact
 * wire contract is docs/client-diagnostics.md; every field is optional,
 * declared, bounded, and an undeclared key anywhere inside is a 400 under
 * the global ValidationPipe (whitelist + forbidNonWhitelisted).
 *
 * THE BOUNDARY: nothing here may name a site the customer visits. The
 * names and addresses it holds are the device's own settings (its DNS
 * servers, Android's Private DNS host), the app's own tunnel settings, and
 * results for the server's fixed test list -- which the server enforces
 * at intake (`keepServiceResults`), not this DTO. */

/** Each entry of `tunnel.dns`: an IP literal, or a resolver URL the app
 * itself configures (a DoH address such as https://resolver.example/dns-query). */
export function IsIpOrResolverUrl(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: "isIpOrResolverUrl",
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" &&
          (isIP(value) ||
            isURL(value, {
              protocols: ["https", "tls", "quic", "h3", "tcp", "udp"],
              require_protocol: true,
              require_tld: false,
            })),
        defaultMessage: buildMessage((each) => `${each}$property must be an IP address or a resolver URL`, options),
      },
    },
    options,
  );
}

export const NET_TYPES = ["wifi", "cellular", "ethernet", "other", "none", "unknown"] as const;
export const PRIVATE_DNS_MODES = ["off", "auto", "host", "unknown"] as const;
export const TUNNEL_MODES = ["full", "custom", "gaming"] as const;
export const SESSION_END_CAUSES = ["disconnected", "lost", "replaced", "app_closed", "unknown"] as const;
export const VIA = ["tunnel", "direct"] as const;
export const SERVICE_STAGES = ["dns", "connect", "tls", "http", "ok"] as const;

/** A service-check timing's ceiling: two minutes, past any app timeout. */
export const SERVICE_MS_MAX = 120_000;
export const MAX_SERVICES = 16;
export const MAX_DNS = 4;

export class DeviceDetailsDto {
  @IsOptional() @IsString() @MaxLength(64) model?: string;
  @IsOptional() @IsString() @MaxLength(32) os?: string;
  @IsOptional() @IsString() @MaxLength(48) osVersion?: string;
  @IsOptional() @IsString() @MaxLength(16) language?: string;
  @IsOptional() @IsBoolean() lowPower?: boolean;
  @IsOptional() @IsBoolean() dataSaver?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1_048_576) memFreeMb?: number;
}

export class NetDetailsDto {
  @IsOptional() @IsIn(NET_TYPES) type?: (typeof NET_TYPES)[number];
  @IsOptional() @IsBoolean() metered?: boolean;
  @IsOptional() @IsBoolean() ipv4?: boolean;
  @IsOptional() @IsBoolean() ipv6?: boolean;
  @IsOptional() @IsBoolean() otherVpn?: boolean;
  /** The device's own DNS servers: addresses only. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_DNS) @IsIP(undefined, { each: true }) dns?: string[];
  @IsOptional() @IsIn(PRIVATE_DNS_MODES) privateDns?: (typeof PRIVATE_DNS_MODES)[number];
  /** Android's Private DNS hostname: a device setting. */
  @IsOptional() @IsString() @MaxLength(128) privateDnsHost?: string;
}

export class TunnelDetailsDto {
  @IsOptional() @IsIn(TUNNEL_MODES) mode?: (typeof TUNNEL_MODES)[number];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DNS)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @IsIpOrResolverUrl({ each: true })
  dns?: string[];
  @IsOptional() @IsBoolean() splitTunnel?: boolean;
  @IsOptional() @IsBoolean() ipv6Blocked?: boolean;
  @IsOptional() @IsBoolean() dnsUnprotected?: boolean;
}

export class DataCheckLegDto {
  @IsString() @MaxLength(24) status!: string;
  @IsInt() @Min(0) bytes!: number;
  @IsInt() @Min(0) ms!: number;
}

export class DataCheckDto {
  @IsOptional() @ValidateNested() @Type(() => DataCheckLegDto) down?: DataCheckLegDto;
  @IsOptional() @ValidateNested() @Type(() => DataCheckLegDto) up?: DataCheckLegDto;
}

export class EgressDto {
  @IsString() @MaxLength(32) state!: string;
  @IsOptional() @IsInt() @Min(0) ms?: number;
}

export class ReconnectDto {
  @IsOptional() @IsInt() @Min(0) attempt?: number;
  @IsOptional() @IsInt() @Min(0) quickDeaths?: number;
  @IsOptional() @IsInt() @Min(0) spentMs?: number;
  @IsOptional() @IsInt() @Min(0) droppedSecondsAgo?: number;
}

export class SessionEndDto {
  @IsIn(SESSION_END_CAUSES) cause!: (typeof SESSION_END_CAUSES)[number];
  @IsInt() @Min(0) @Max(7 * 86_400) seconds!: number;
}

/** One target of the service check. Kept only if `host` is on the
 * server's list (current or previous); see `keepServiceResults`. */
export class ServiceResultDto {
  @IsString() @MaxLength(32) key!: string;
  @IsString() @MaxLength(128) host!: string;
  @IsBoolean() ok!: boolean;
  @IsIn(SERVICE_STAGES) stage!: (typeof SERVICE_STAGES)[number];
  @IsOptional() @IsInt() @Min(0) @Max(SERVICE_MS_MAX) dnsMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(SERVICE_MS_MAX) connectMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(SERVICE_MS_MAX) tlsMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(SERVICE_MS_MAX) firstByteMs?: number;
  @IsOptional() @IsInt() @Min(0) @Max(999) status?: number;
  /** The address the target resolved to. Never stored: the intake keeps
   * only its kind (`addressKind` in report-details.ts). */
  @IsOptional() @IsIP() address?: string;
  @IsOptional() @IsString() @MaxLength(120) error?: string;
}

export class ReportDetailsDto {
  @IsOptional() @ValidateNested() @Type(() => DeviceDetailsDto) device?: DeviceDetailsDto;
  @IsOptional() @ValidateNested() @Type(() => NetDetailsDto) net?: NetDetailsDto;
  @IsOptional() @ValidateNested() @Type(() => TunnelDetailsDto) tunnel?: TunnelDetailsDto;
  @IsOptional() @IsString() @MaxLength(40) errorKind?: string;
  @IsOptional() @ValidateNested() @Type(() => DataCheckDto) dataCheck?: DataCheckDto;
  @IsOptional() @ValidateNested() @Type(() => EgressDto) egress?: EgressDto;
  @IsOptional() @ValidateNested() @Type(() => ReconnectDto) reconnect?: ReconnectDto;
  @IsOptional() @ValidateNested() @Type(() => SessionEndDto) sessionEnd?: SessionEndDto;
  @IsOptional() @IsIn(VIA) via?: (typeof VIA)[number];
  @IsOptional() @IsInt() @Min(0) targetsVersion?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SERVICES)
  @ValidateNested({ each: true })
  @Type(() => ServiceResultDto)
  services?: ServiceResultDto[];
}
