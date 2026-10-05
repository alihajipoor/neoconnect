import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReportAttemptDto } from "./report-attempt.dto";

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
