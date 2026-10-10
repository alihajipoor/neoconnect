import type { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Request } from "express";
import type { AddressInfo, Server } from "node:net";
import { ClientThrottlerGuard } from "../../common/guards/client-throttler.guard";
import { ATTRIBUTION_GRACE_MS, ClientAttemptsController } from "./client-attempts.controller";
import { ClientAttemptsService } from "./client-attempts.service";
import type { ReportAttemptDto } from "./dto/report-attempt.dto";

const SECRET = "customer-access-secret";

/** Its rate limit, over HTTP, as app.module.ts wires the guard. Every
 * request comes from 127.0.0.1: a node's mirror, or its tunnel egress,
 * with many customers behind it. */
describe("POST /client-attempts rate limit", () => {
  const REPORTS_PER_MINUTE = 20;
  const jwt = new JwtService({});
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ customerJwt: { accessSecret: SECRET, refreshSecret: "r" }, jwt: { accessSecret: "a" } })],
        }),
        ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
      ],
      controllers: [ClientAttemptsController],
      providers: [
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
        { provide: ClientAttemptsService, useValue: { record: jest.fn() } },
        JwtService,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  const report = (token?: string) =>
    fetch(`${base}/client-attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: "{}",
    }).then((r) => r.status);

  it("gives each signed-in session behind one address its own twenty a minute", async () => {
    const alice = jwt.sign({ sub: "alice", sid: "alice-pc", tokenVersion: 0 }, { secret: SECRET });
    const bob = jwt.sign({ sub: "bob", sid: "bob-phone", tokenVersion: 0 }, { secret: SECRET });

    const statuses: number[] = [];
    for (let i = 0; i <= REPORTS_PER_MINUTE; i++) statuses.push(await report(alice));
    expect(statuses.filter((s) => s === 204)).toHaveLength(REPORTS_PER_MINUTE);
    expect(statuses.at(-1)).toBe(429);
    // Shared with Alice's address, this was 429.
    expect(await report(bob)).toBe(204);
    // An anonymous report -- someone who could not sign in -- still
    // counts against the address, which Alice's reports did not touch.
    expect(await report()).toBe(204);
  });

  /** The report is filed under an expired token's customer (below), but
   * the bucket is not theirs: an expired token is no session to the
   * throttle, and counts against the address like no token at all. */
  it("counts a report carrying an expired token against the address", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt.sign({ sub: "carol", sid: "carol-pc", iat: now - 1080, exp: now - 180 }, { secret: SECRET });
    const statuses: number[] = [];
    for (let i = 0; i < REPORTS_PER_MINUTE; i++) statuses.push(await report(i % 2 === 0 ? expired : undefined));
    expect(statuses.every((s) => s === 204)).toBe(true);
    expect(await report(expired)).toBe(429);
    expect(await report()).toBe(429);
  });
});

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

  /** A queued report goes out on the next contact with the token of the
   * session it happened in, which has usually expired by then. Verified
   * with expiry, every one of them was filed under nobody. */
  describe("a report delivered after its session's token expired", () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const expiredAgo = (seconds: number, claims: Record<string, unknown> = {}, secret = SECRET) =>
      jwt.sign(
        { sub: "cust-1", sid: "s1", ...claims, iat: nowSeconds() - seconds - 900, exp: nowSeconds() - seconds },
        { secret },
      );

    it("is still filed under the customer", async () => {
      // Three minutes, as on the test VM, and most of the retention window.
      expect(await filedUnder(expiredAgo(180))).toBe("cust-1");
      expect(await filedUnder(expiredAgo(ATTRIBUTION_GRACE_MS / 1000 - 3600))).toBe("cust-1");
    });

    it("is anonymous once the token expired longer ago than reports are kept", async () => {
      expect(await filedUnder(expiredAgo(ATTRIBUTION_GRACE_MS / 1000 + 3600))).toBeUndefined();
    });

    /** Only the expiry is relaxed. */
    it("is anonymous when the expired token is forged or single-purpose", async () => {
      expect(await filedUnder(expiredAgo(180, {}, "not-ours"))).toBeUndefined();
      expect(await filedUnder(expiredAgo(180, { purpose: "password-reset" }))).toBeUndefined();
    });
  });
});
