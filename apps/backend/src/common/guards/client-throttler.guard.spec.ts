import { Controller, Get, HttpCode, Post, type INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { Throttle, ThrottlerModule } from "@nestjs/throttler";
import type { AddressInfo, Server } from "node:net";
import { ClientThrottlerGuard, ThrottleByRefreshToken } from "./client-throttler.guard";

/** Every request here comes from 127.0.0.1 -- which is the point: it
 * stands for a node's mirror, or its tunnel egress, with many customers
 * behind one address. */

const SECRETS: Record<string, string> = {
  "customerJwt.accessSecret": "customer-access-secret",
  "customerJwt.refreshSecret": "customer-refresh-secret",
  "jwt.accessSecret": "admin-access-secret",
};
const DEFAULT_LIMIT = 3;
const GUESS_LIMIT = 2;

@Controller("t")
class ProbeController {
  @Get("open")
  open() {
    return { ok: true };
  }

  @Post("refresh")
  @HttpCode(200)
  @ThrottleByRefreshToken()
  refresh() {
    return { ok: true };
  }

  @Post("guess")
  @HttpCode(200)
  @Throttle({ default: { limit: GUESS_LIMIT, ttl: 60_000 } })
  guess() {
    return { ok: true };
  }
}

describe("ClientThrottlerGuard", () => {
  let app: INestApplication;
  let base: string;
  const jwt = new JwtService({});
  const sign = (payload: object, key: string) => jwt.sign(payload, { secret: SECRETS[key], expiresIn: "15m" });
  const customer = (sub: string, sid: string) => sign({ sub, sid, tokenVersion: 0 }, "customerJwt.accessSecret");

  beforeEach(async () => {
    // Wired as app.module.ts wires it: the global ConfigModule, the
    // throttler module, and the guard as APP_GUARD.
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              customerJwt: {
                accessSecret: SECRETS["customerJwt.accessSecret"],
                refreshSecret: SECRETS["customerJwt.refreshSecret"],
              },
              jwt: { accessSecret: SECRETS["jwt.accessSecret"] },
            }),
          ],
        }),
        ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: DEFAULT_LIMIT }]),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ClientThrottlerGuard }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  const get = (token?: string) =>
    fetch(`${base}/t/open`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status);
  const post = (path: string, body: object, token?: string) =>
    fetch(`${base}/t/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then((r) => r.status);
  const times = async (n: number, call: () => Promise<number>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await call());
    return out;
  };

  it("gives each signed-in session behind one address its own bucket", async () => {
    const alice = customer("alice", "alice-pc");
    const bob = customer("bob", "bob-phone");

    expect(await times(DEFAULT_LIMIT + 1, () => get(alice))).toEqual([200, 200, 200, 429]);
    // With the stock guard Bob shares Alice's address, and so her
    // exhausted bucket: this was 429.
    expect(await get(bob)).toBe(200);
    // And the address itself is untouched for anyone else.
    expect(await get()).toBe(200);
  });

  it("gives an admin session its own bucket", async () => {
    const admin = sign({ sub: "admin-1", email: "a@b.c", role: "SUPERADMIN" }, "jwt.accessSecret");
    expect(await times(DEFAULT_LIMIT, () => get())).toEqual([200, 200, 200]);
    expect(await get(admin)).toBe(200);
  });

  it("counts tokens that do not verify against the address, all together", async () => {
    // A fresh forgery per request must not buy a fresh bucket per request.
    const forged = () => {
      const [header, , mac] = customer("alice", "alice-pc").split(".");
      const claims = Buffer.from(JSON.stringify({ sub: `x-${Math.random()}`, sid: "s" })).toString("base64url");
      return `${header}.${claims}.${mac}`;
    };
    const wrongSecret = () => jwt.sign({ sub: `y-${Math.random()}`, sid: "s" }, { secret: "not-ours" });
    expect(await get(forged())).toBe(200);
    expect(await get(wrongSecret())).toBe(200);
    expect(await get("garbage")).toBe(200);
    expect(await get(wrongSecret())).toBe(429);
    expect(await get()).toBe(429);
  });

  it("does not count a single-purpose token as a session", async () => {
    const verifyLink = sign({ sub: "alice", purpose: "verify-email" }, "customerJwt.accessSecret");
    expect(await times(DEFAULT_LIMIT, () => get())).toEqual([200, 200, 200]);
    expect(await get(verifyLink)).toBe(429);
  });

  it("keeps a route's own guess limit on the address", async () => {
    const alice = customer("alice", "alice-pc");
    const bob = customer("bob", "bob-phone");
    expect(await times(GUESS_LIMIT, () => post("guess", {}, alice))).toEqual([200, 200]);
    // One account can mint sessions; a guess limit per session would be
    // one per sign-in.
    expect(await post("guess", {}, bob)).toBe(429);
  });

  it("counts a refresh against the session in its refresh token, once that verifies", async () => {
    const refreshOf = (sub: string, sid: string) =>
      sign({ sub, sid, tokenVersion: 0 }, "customerJwt.refreshSecret");
    const alice = refreshOf("alice", "alice-pc");

    expect(await times(DEFAULT_LIMIT + 1, () => post("refresh", { refreshToken: alice }))).toEqual([200, 200, 200, 429]);
    expect(await post("refresh", { refreshToken: refreshOf("bob", "bob-phone") })).toBe(200);

    // An access token is not a refresh token, and junk shares one bucket.
    const notRefresh = customer("carol", "carol-pc");
    expect(await times(DEFAULT_LIMIT, () => post("refresh", { refreshToken: notRefresh }))).toEqual([200, 200, 200]);
    expect(await post("refresh", { refreshToken: "junk" })).toBe(429);
  });
});
