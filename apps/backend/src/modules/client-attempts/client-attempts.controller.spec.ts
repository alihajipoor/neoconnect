import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { ClientAttemptsController } from "./client-attempts.controller";
import type { ClientAttemptsService } from "./client-attempts.service";
import type { ReportAttemptDto } from "./dto/report-attempt.dto";

const SECRET = "customer-access-secret";

/** Who a report is filed under. The per-ISP tags count distinct
 * customers, so this is what stands between them and made-up ones. */
describe("ClientAttemptsController.report customer", () => {
  const jwt = new JwtService({});
  const record = jest.fn();
  const controller = new ClientAttemptsController(
    { record } as unknown as ClientAttemptsService,
    jwt,
    new ConfigService({ customerJwt: { accessSecret: SECRET } }),
  );
  const filedUnder = async (token: string | undefined) => {
    record.mockClear();
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
    await controller.report({} as ReportAttemptDto, req);
    return (record.mock.calls[0][1] as { customerId?: string }).customerId;
  };

  it("files a signed-in customer's report under them", async () => {
    expect(await filedUnder(jwt.sign({ sub: "cust-1", sid: "s1", tokenVersion: 0 }, { secret: SECRET }))).toBe("cust-1");
  });

  it("files it anonymously with no token, or one that does not verify", async () => {
    expect(await filedUnder(undefined)).toBeUndefined();
    expect(await filedUnder(jwt.sign({ sub: "cust-1" }, { secret: "not-ours" }))).toBeUndefined();
  });

  /** Before, both counted: an account that never verified its email was
   * a distinct customer, on the strength of its own verification link. */
  it("does not take an emailed single-purpose token as a customer", async () => {
    expect(await filedUnder(jwt.sign({ sub: "cust-1", purpose: "verify-email" }, { secret: SECRET }))).toBeUndefined();
    expect(await filedUnder(jwt.sign({ sub: "cust-1", purpose: "password-reset" }, { secret: SECRET }))).toBeUndefined();
  });
});
