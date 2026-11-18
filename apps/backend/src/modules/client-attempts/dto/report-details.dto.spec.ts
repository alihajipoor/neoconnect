import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReportAttemptDto, RUNG_MS_MAX } from "./report-attempt.dto";
import { PLATFORM_DIAGNOSTICS_MAX_LENGTH, SendDiagnosticsDto } from "./send-diagnostics.dto";

/** Validated as the global pipe does: whitelist, and reject what is not
 * declared -- inside `details` too. */
async function errorsOf<T extends object>(cls: new () => T, body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(cls, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: typeof errors, prefix = ""): string[] =>
    list.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}).map((c) => `${prefix}${e.property}:${c}`),
      ...flatten(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return flatten(errors);
}
const reportErrors = (body: Record<string, unknown>) => errorsOf(ReportAttemptDto, body);

const base = { kind: "CONNECT", outcome: "SUCCESS", platform: "android", appVersion: "0.2.40" };

/** Every field of the contract, at a realistic value (docs/client-diagnostics.md). */
const FULL_DETAILS = {
  device: { model: "Pixel 7", os: "android", osVersion: "14", language: "fa", lowPower: false, dataSaver: true, memFreeMb: 812 },
  net: {
    type: "cellular",
    metered: true,
    ipv4: true,
    ipv6: false,
    otherVpn: false,
    dns: ["192.0.2.53", "2001:db8::53"],
    privateDns: "host",
    privateDnsHost: "dns.example.net",
  },
  tunnel: {
    mode: "custom",
    dns: ["198.51.100.1", "https://resolver.example.com/dns-query"],
    splitTunnel: true,
    ipv6Blocked: true,
    dnsUnprotected: false,
  },
  errorKind: "handshake_timeout",
  dataCheck: { down: { status: "ok", bytes: 131072, ms: 840 }, up: { status: "timeout", bytes: 0, ms: 8000 } },
  egress: { state: "unreachable", ms: 5000 },
  reconnect: { attempt: 2, quickDeaths: 1, spentMs: 42000, droppedSecondsAgo: 30 },
  sessionEnd: { cause: "lost", seconds: 3600 },
  via: "tunnel",
  targetsVersion: 1,
  services: [
    {
      key: "google",
      host: "www.google.com",
      ok: true,
      stage: "ok",
      dnsMs: 40,
      connectMs: 90,
      tlsMs: 180,
      firstByteMs: 260,
      status: 204,
      address: "192.0.2.80",
    },
    { key: "x", host: "x.com", ok: false, stage: "tls", dnsMs: 30, connectMs: 70, error: "reset during handshake" },
  ],
};

describe("ReportAttemptDto details", () => {
  it("accepts every field of the contract", async () => {
    expect(await reportErrors({ ...base, details: FULL_DETAILS })).toEqual([]);
  });

  it("accepts a SERVICE_CHECK report", async () => {
    expect(await reportErrors({ ...base, kind: "SERVICE_CHECK", outcome: "OTHER", details: FULL_DETAILS })).toEqual([]);
  });

  /** Old apps send exactly today's fields; they must be accepted unchanged. */
  it("still accepts an old payload with no details and no rung times", async () => {
    expect(
      await reportErrors({
        ...base,
        routeId: "6f1c2c43-7c1e-4b55-9d5d-2d6f3c1b9a10",
        protocol: "Stealth",
        reason: "x",
        attempts: [{ protocol: "Stealth", result: "connected", carried: true, downKbps: 100, upKbps: 50 }],
        occurredAt: new Date().toISOString(),
      }),
    ).toEqual([]);
  });

  it("accepts a rung's time and bounds it", async () => {
    expect(await reportErrors({ ...base, attempts: [{ protocol: "Fast", result: "x", ms: 1200 }] })).toEqual([]);
    expect(await reportErrors({ ...base, attempts: [{ protocol: "Fast", result: "x", ms: RUNG_MS_MAX + 1 }] })).toContain(
      "attempts.0.ms:max",
    );
    expect(await reportErrors({ ...base, attempts: [{ protocol: "Fast", result: "x", ms: -1 }] })).toContain("attempts.0.ms:min");
  });

  it("rejects an unknown key anywhere inside details", async () => {
    expect(await reportErrors({ ...base, details: { visited: ["example.com"] } })).toContain("details.visited:whitelistValidation");
    expect(await reportErrors({ ...base, details: { net: { ssid: "home" } } })).toContain("details.net.ssid:whitelistValidation");
    expect(
      await reportErrors({ ...base, details: { services: [{ key: "x", host: "x.com", ok: true, stage: "ok", url: "/a" }] } }),
    ).toContain("details.services.0.url:whitelistValidation");
  });

  it("rejects over-long values", async () => {
    const long = await reportErrors({
      ...base,
      details: {
        device: { model: "m".repeat(65), osVersion: "v".repeat(49), language: "l".repeat(17) },
        net: { privateDnsHost: "h".repeat(129) },
        errorKind: "e".repeat(41),
        egress: { state: "s".repeat(33) },
        services: [{ key: "k".repeat(33), host: "h".repeat(129), ok: false, stage: "dns", error: "e".repeat(121) }],
      },
    });
    expect(long).toEqual(
      expect.arrayContaining([
        "details.device.model:maxLength",
        "details.device.osVersion:maxLength",
        "details.device.language:maxLength",
        "details.net.privateDnsHost:maxLength",
        "details.errorKind:maxLength",
        "details.egress.state:maxLength",
        "details.services.0.key:maxLength",
        "details.services.0.host:maxLength",
        "details.services.0.error:maxLength",
      ]),
    );
  });

  it("rejects a name where an address belongs, and too many of them", async () => {
    const errors = await reportErrors({
      ...base,
      details: {
        net: { dns: ["dns.example.net"] },
        services: [{ key: "google", host: "www.google.com", ok: true, stage: "ok", address: "www.google.com" }],
      },
    });
    expect(errors).toEqual(expect.arrayContaining(["details.net.dns:isIp", "details.services.0.address:isIp"]));
    expect(await reportErrors({ ...base, details: { net: { dns: ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5"] } } })).toContain(
      "details.net.dns:arrayMaxSize",
    );
  });

  it("takes an IP or a resolver URL in tunnel.dns, and nothing else", async () => {
    expect(await reportErrors({ ...base, details: { tunnel: { dns: ["2001:db8::1", "tls://resolver.example.com"] } } })).toEqual([]);
    expect(await reportErrors({ ...base, details: { tunnel: { dns: ["resolver.example.com"] } } })).toContain(
      "details.tunnel.dns:isIpOrResolverUrl",
    );
    expect(await reportErrors({ ...base, details: { tunnel: { dns: [`https://${"a".repeat(80)}.example`] } } })).toContain(
      "details.tunnel.dns:maxLength",
    );
  });

  it("bounds enums, numbers and the services list", async () => {
    const errors = await reportErrors({
      ...base,
      details: {
        net: { type: "satellite", privateDns: "on" },
        tunnel: { mode: "stealth" },
        device: { memFreeMb: 1_048_577 },
        sessionEnd: { cause: "crash", seconds: 604_801 },
        via: "relay",
        targetsVersion: -1,
        reconnect: { attempt: -1 },
        dataCheck: { down: { status: "ok", bytes: -1, ms: 1.5 } },
        services: [{ key: "google", host: "www.google.com", ok: "yes", stage: "done", tlsMs: 120_001, status: 1000 }],
      },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "details.net.type:isIn",
        "details.net.privateDns:isIn",
        "details.tunnel.mode:isIn",
        "details.device.memFreeMb:max",
        "details.sessionEnd.cause:isIn",
        "details.sessionEnd.seconds:max",
        "details.via:isIn",
        "details.targetsVersion:min",
        "details.reconnect.attempt:min",
        "details.dataCheck.down.bytes:min",
        "details.dataCheck.down.ms:isInt",
        "details.services.0.ok:isBoolean",
        "details.services.0.stage:isIn",
        "details.services.0.tlsMs:max",
        "details.services.0.status:max",
      ]),
    );
    const many = Array.from({ length: 17 }, () => ({ key: "google", host: "www.google.com", ok: true, stage: "ok" }));
    expect(await reportErrors({ ...base, details: { services: many } })).toContain("details.services:arrayMaxSize");
  });
});

describe("SendDiagnosticsDto", () => {
  const send = (body: Record<string, unknown>) => errorsOf(SendDiagnosticsDto, body);

  it("accepts a note, details and the desktop text", async () => {
    expect(
      await send({ platform: "windows", appVersion: "0.9.57", note: "slow tonight", details: FULL_DETAILS, platformDiagnostics: "Neoxify 0.9.57\n..." }),
    ).toEqual([]);
  });

  it("requires platform and appVersion, and caps the rest", async () => {
    const errors = await send({
      note: "n".repeat(501),
      platformDiagnostics: "d".repeat(PLATFORM_DIAGNOSTICS_MAX_LENGTH + 1),
      details: { extra: true },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "platform:isString",
        "appVersion:isString",
        "note:maxLength",
        "platformDiagnostics:maxLength",
        "details.extra:whitelistValidation",
      ]),
    );
  });
});
