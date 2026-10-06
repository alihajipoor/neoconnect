import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { API_ENDPOINT_MAX_LENGTH, ReportAttemptDto } from "./report-attempt.dto";

/** Validated as the app's global pipe does: whitelist, and reject what
 * is not declared. An undeclared field is a 400, which a client counts as
 * delivered and drops -- so a field the clients send that is missing
 * here loses the whole report silently. */
async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ReportAttemptDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: typeof errors, prefix = ""): string[] =>
    list.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}).map((c) => `${prefix}${e.property}:${c}`),
      ...flatten(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return flatten(errors);
}

const ROUTE = "6f1c2c43-7c1e-4b55-9d5d-2d6f3c1b9a10";
const base = { kind: "CONNECT", outcome: "SUCCESS", platform: "ios", appVersion: "0.2.22" };

describe("ReportAttemptDto", () => {
  it("accepts a ladder whose rungs name their route and whether it carried", async () => {
    expect(
      await errorsFor({
        ...base,
        network: "n1.64500.1790000000.AAAAAAAAAAAAAAAAAAAAAA",
        attempts: [
          { protocol: "Fast", result: "up but unreachable", routeId: ROUTE, carried: false },
          { protocol: "Stealth", result: "connected", routeId: ROUTE, carried: true },
          { protocol: "IKEv2", result: "not available with selected apps" },
        ],
      }),
    ).toEqual([]);
  });

  it("accepts a SESSION report with its length", async () => {
    expect(await errorsFor({ ...base, kind: "SESSION", routeId: ROUTE, sessionSeconds: 600 })).toEqual([]);
  });

  /** Unauthenticated input: every new field is bounded like the old ones. */
  it("rejects a route that is not an id, and a session length that is not plausible", async () => {
    const errors = await errorsFor({
      ...base,
      kind: "SESSION",
      sessionSeconds: 30 * 86_400,
      attempts: [{ protocol: "Fast", result: "x", routeId: "not-a-uuid", carried: "yes" }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "sessionSeconds:max",
        "attempts.0.routeId:isUuid",
        "attempts.0.carried:isBoolean",
      ]),
    );
  });

  it("bounds the attestation's length", async () => {
    expect(await errorsFor({ ...base, network: "x".repeat(81) })).toContain("network:maxLength");
  });
});

/** The field that was capped at 200 -- shorter than what the shipped
 * clients would put in it. Names are RFC 2606 stand-ins of realistic
 * length; the real list is not committed (docs/node-address-hygiene.md). */
describe("ReportAttemptDto apiEndpoint", () => {
  const unreachable = { ...base, kind: "CONNECT", outcome: "CONTROL_PLANE_UNREACHABLE", appVersion: "0.9.42" };
  /** 26 characters, the length of a node mirror's host:port today. */
  const mirror = (i: number) => `mirror-${String(i).padStart(2, "0")}.example-edge.net:2053`;

  /** What 0.9.39 to 0.9.43 and mobile 0.2.22 send: every hostname they
   * would try, comma-joined. Eleven with today's bundle come to 233
   * characters by the code, which the old limit would refuse with a 400.
   * Production logged no such 400 (see API_ENDPOINT_MAX_LENGTH): no
   * report carrying the list arrived in the 14 days it covers, but one
   * must be accepted when it does. */
  it("accepts the hostname list shipped clients already send", async () => {
    const hosts = Array.from({ length: 11 }, (_, i) => `mirror-${i}.example-edge.net`).join(",");
    expect(hosts.length).toBeGreaterThan(200);
    expect(await errorsFor({ ...unreachable, apiEndpoint: hosts })).toEqual([]);
  });

  /** The per-address trace newer clients send, for a list that has grown
   * to sixteen addresses and was walked in three phases. */
  it("accepts a trace of sixteen addresses across three phases", async () => {
    const phase = (name: string, outcome: string) =>
      `${name}: ` + Array.from({ length: 16 }, (_, i) => `${mirror(i)}=${outcome}@8000`).join(" ");
    const trace = [phase("req", "timeout"), phase("refresh", "net")].join("; ");
    // Built to size, not cut to fit: a realistic worst case has to be
    // inside the limit on its own.
    expect(trace.length).toBeGreaterThan(1000);
    expect(trace.length).toBeLessThanOrEqual(API_ENDPOINT_MAX_LENGTH);
    expect(await errorsFor({ ...unreachable, apiEndpoint: trace })).toEqual([]);
  });

  /** Old clients send nothing here, and must keep being accepted. */
  it("is still optional", async () => {
    expect(await errorsFor(unreachable)).toEqual([]);
  });

  /** Still unauthenticated input, so still bounded. */
  it("refuses anything past the limit", async () => {
    expect(await errorsFor({ ...unreachable, apiEndpoint: "x".repeat(API_ENDPOINT_MAX_LENGTH + 1) })).toEqual([
      "apiEndpoint:maxLength",
    ]);
  });
});
