/* eslint-disable @typescript-eslint/require-await -- the AuthService
   stand-in matches the real one's async signature. */
import { UnauthorizedException, ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import type { AddressInfo, Server } from "node:net";
import { ClientThrottlerGuard } from "../../common/guards/client-throttler.guard";
import { AdminsService } from "../admins/admins.service";
import { LoginGuardController } from "../login-guard/login-guard.controller";
import { LoginGuardService } from "../login-guard/login-guard.service";
import type { Challenge } from "../login-guard/proof-of-work";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/** Admin sign-in as the panel reaches it: from one server, straight to
 * this API, with no nginx in between. Every request in this file comes
 * from 127.0.0.1 -- the panel container -- and the only thing telling
 * operators apart is the X-Forwarded-For the panel adds
 * (apps/panel/src/lib/client-address.ts). Wired as main.ts and app.module
 * wire it: `trust proxy 1`, the production ValidationPipe, the global
 * ClientThrottlerGuard and one LoginGuardService. The password check is
 * a stand-in; nothing here touches Postgres. */

const ADMIN = "ops@example.com";
const RIGHT = "right-password";
const OPERATOR = "203.0.113.7";
const STRANGER = "198.51.100.1";

describe("admin sign-in through the panel's hop", () => {
  let app: INestApplication;
  let base: string;
  let throttle = true;

  beforeEach(async () => {
    throttle = true;
    const auth = {
      login: jest.fn(async (email: string, password: string) => {
        if (email === ADMIN && password === RIGHT) return { accessToken: "a", refreshToken: "r" };
        throw new UnauthorizedException("Invalid email or password");
      }),
    };
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: "default", ttl: 60_000, limit: 100 }],
          // Lets a test look at LoginGuard alone, past login's 5/min.
          skipIf: () => !throttle,
        }),
      ],
      controllers: [AuthController, LoginGuardController],
      providers: [
        LoginGuardService,
        { provide: AuthService, useValue: auth },
        { provide: AdminsService, useValue: {} },
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    (app as NestExpressApplication).set("trust proxy", 1);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  const post = async (path: string, body: object, from?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const login = (email: string, password: string, from?: string, challenge?: object) =>
    post("/auth/login", { email, password, ...(challenge ? { challenge } : {}) }, from);
  const strangerFails = async (n: number, from?: string, email = (i: number) => `nobody${i}@example.com`) => {
    for (let i = 0; i < n; i++) expect((await login(email(i), "wrong-password", from)).status).toBe(401);
  };

  it("before: five strangers' failures through the panel refused every operator", async () => {
    // What the panel sent until now: no header, so one address for all.
    await strangerFails(5);
    expect((await login(ADMIN, RIGHT)).status).toBe(429);

    throttle = false;
    // And past the minute's limit, LoginGuard's per-source counter.
    const refused = await login(ADMIN, RIGHT);
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toMatch(/Too many recent sign-in attempts/);
  });

  it("counts each browser the panel names on its own", async () => {
    await strangerFails(5, STRANGER);
    expect((await login("x@example.com", "wrong-password", STRANGER)).status).toBe(429);
    expect((await login(ADMIN, RIGHT, OPERATOR)).status).toBe(200);

    throttle = false;
    // The stranger's address is now held to proof of work; the operator's
    // is not.
    expect((await login("x@example.com", "wrong-password", STRANGER)).status).toBe(400);
    expect((await login(ADMIN, RIGHT, OPERATOR)).status).toBe(200);
  });

  it("lets the operator in with a solved challenge while the account itself is under attack", async () => {
    throttle = false;
    // Five failures against the admin's own email, from five addresses.
    for (let i = 0; i < 5; i++) {
      expect((await login(ADMIN, "wrong-password", `198.51.100.${10 + i}`)).status).toBe(401);
    }
    // Without a solution even the right password is refused: the account
    // counter follows the target, whatever address asks.
    expect((await login(ADMIN, RIGHT, OPERATOR)).status).toBe(400);

    // What the panel does now: a challenge priced for this account and
    // this browser, solved, sent with the password.
    const issued = await post("/login-challenge", { scope: "admin", email: ADMIN }, OPERATOR);
    expect(issued.status).toBe(201);
    const challenge = issued.body as unknown as Challenge;
    expect(challenge.difficulty).toBe(15);
    expect((await login(ADMIN, RIGHT, OPERATOR, solve(challenge))).status).toBe(200);
  });

  it("refuses a challenge minted before the account's failures raised the price", async () => {
    throttle = false;
    const early = (await post("/login-challenge", { scope: "admin", email: ADMIN }, OPERATOR)).body as unknown as Challenge;
    expect(early.difficulty).toBe(12);
    for (let i = 0; i < 6; i++) await login(ADMIN, "wrong-password", `198.51.100.${10 + i}`);
    const stale = await login(ADMIN, RIGHT, OPERATOR, solve(early));
    expect(stale.status).toBe(400);
    expect(String(stale.body.message)).toMatch(/out of date/);
  });

  it("through nginx, a caller's own X-Forwarded-For buys no fresh bucket", async () => {
    // nginx appends the peer it saw; trust proxy 1 takes that last entry,
    // so rotating what the caller wrote to its left changes nothing.
    for (let i = 0; i < 5; i++) {
      expect((await login(`n${i}@example.com`, "wrong-password", `10.0.0.${i}, ${STRANGER}`)).status).toBe(401);
    }
    expect((await login("n9@example.com", "wrong-password", `10.0.0.99, ${STRANGER}`)).status).toBe(429);
  });
});

function solve(challenge: Challenge) {
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${challenge.challenge}:${nonce}`).digest();
    let bits = 0;
    for (const byte of digest) {
      if (byte === 0) {
        bits += 8;
        continue;
      }
      bits += Math.clz32(byte) - 24;
      break;
    }
    if (bits >= challenge.difficulty) return { ...challenge, nonce: String(nonce) };
  }
}
