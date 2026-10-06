/* eslint-disable @typescript-eslint/require-await -- the Prisma stand-in
   matches the client's async signatures. */
import { Logger, ValidationPipe, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import type { AddressInfo, Server } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { DeviceSlotsController, SLOT_REQUESTS_PER_MINUTE, slotRequestTracker } from "./device-slots.controller";
import { DeviceSlotsService } from "./device-slots.service";
import { DeviceStateStore } from "./device-state.store";
import { DevicePresence } from "./device-presence";

/** The HTTP contract of docs/device-slots.md, over a real Nest server on a
 * real port, with the validation pipe production uses: paths, status
 * codes, the JSON a client parses, and the headers it sends. The service
 * underneath is the real one over an in-memory store; Postgres is a
 * stand-in, and no app has called this yet. */

const SUB = "11111111-1111-4111-8111-111111111111";

describe("device slots over HTTP", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const sessions: Record<string, { revokedAt: Date | null; label: string | null; platform: string | null }> = {
      "session-pc": { revokedAt: null, label: null, platform: null },
      "session-phone": { revokedAt: null, label: null, platform: null },
    };
    const prisma = {
      customerSession: {
        findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
          sessions[where.id] ? { id: where.id, ...sessions[where.id] } : null,
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, string> }) => {
          Object.assign(sessions[where.id], data);
          return { count: 1 };
        }),
      },
      subscription: {
        findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === SUB ? { id: SUB, status: "ACTIVE", plan: { maxConcurrentConnections: 1 } } : null,
        ),
        findMany: jest.fn(async () => [{ id: SUB }]),
      },
      protocolUser: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };

    const store = DeviceStateStore.inMemory();
    const module = await Test.createTestingModule({
      controllers: [DeviceSlotsController],
      providers: [
        DeviceSlotsService,
        DevicePresence,
        { provide: DeviceStateStore, useValue: store },
        { provide: PrismaService, useValue: prisma },
      ],
    })
      // Who is calling, without signing a JWT: the session comes from a
      // test header. The real guard is what production authenticates with.
      .overrideGuard(CustomerJwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
          req.user = { sub: "customer-1", email: "a@b.c", sid: req.headers["x-test-session"] };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    // As main.ts configures it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string, session: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-session": session, ...headers },
      body: JSON.stringify(body),
    });

  it("walks the whole contract: claim, refusal, takeover, displaced, release", async () => {
    const pc = await post("/customer/vpn/claim", "session-pc", { subscriptionId: SUB }, {
      "X-Neoxify-Device-Platform": "windows",
      "X-Neoxify-Device-Label": "Windows PC",
    });
    expect(pc.status).toBe(200);
    const granted = (await pc.json()) as { granted: boolean; handle: string; renewEverySec: number; staleAfterSec: number };
    expect(granted).toMatchObject({ granted: true, enforced: true, limit: 1, renewEverySec: 60, staleAfterSec: 90 });

    // The phone, while the PC is in use: 409, and the body names the PC.
    const phone = await post("/customer/vpn/claim", "session-phone", { subscriptionId: SUB }, {
      "X-Neoxify-Device-Platform": "android",
      // Percent-encoded UTF-8 is accepted for a non-ASCII name.
      "X-Neoxify-Device-Label": encodeURIComponent("گوشی علی"),
    });
    expect(phone.status).toBe(409);
    const refused = (await phone.json()) as { code: string; limit: number; holders: { handle: string; label: string }[] };
    expect(refused).toMatchObject({ statusCode: 409, code: "DEVICE_LIMIT", limit: 1 });
    expect(refused.holders).toEqual([
      expect.objectContaining({ handle: granted.handle, label: "Windows PC", platform: "windows" }),
    ]);

    // "Use on this device instead".
    const takeover = await post("/customer/vpn/claim", "session-phone", { subscriptionId: SUB, takeover: [granted.handle] });
    expect(takeover.status).toBe(200);
    const phoneHandle = ((await takeover.json()) as { handle: string }).handle;

    // The PC's next renewal says so -- 200, never 401.
    const renew = await post("/customer/vpn/renew", "session-pc", { subscriptionId: SUB });
    expect(renew.status).toBe(200);
    expect(await renew.json()).toMatchObject({ status: "displaced", by: { label: "گوشی علی", platform: "android" } });

    // Naming the grant it gives back.
    const release = await post("/customer/vpn/release", "session-phone", { subscriptionId: SUB, handle: phoneHandle });
    expect(release.status).toBe(204);
    const again = await post("/customer/vpn/claim", "session-pc", { subscriptionId: SUB });
    expect(again.status).toBe(200);
  });

  it.each([
    ["no subscription", {}],
    ["a subscription id that is not a UUID", { subscriptionId: "sub-1" }],
    ["a field the contract does not have", { subscriptionId: SUB, force: true }],
    ["a takeover that is not a list", { subscriptionId: SUB, takeover: "all" }],
  ])("answers 400 to a claim with %s", async (_label, body) => {
    const res = await post("/customer/vpn/claim", "session-pc", body);
    expect(res.status).toBe(400);
  });

  it("answers 404 for a subscription that is not the caller's", async () => {
    const res = await post("/customer/vpn/claim", "session-pc", { subscriptionId: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(404);
  });
});

/** The app-wide limit is 100 requests a minute per address. Customers
 * reaching the API through a node's mirror, or through the tunnel, share
 * that node's address -- so per address, the 101st customer to press
 * Connect within a minute would have been refused by the control plane
 * rather than by their plan. These endpoints count per device instead. */
describe("device slots over HTTP: the request limit", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const prisma = {
      customerSession: {
        findFirst: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, revokedAt: null, label: null, platform: null })),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      subscription: {
        // Unlimited: every claim is granted, so only the limit can refuse.
        findFirst: jest.fn(async () => ({ id: SUB, status: "ACTIVE", plan: { maxConcurrentConnections: null } })),
        findMany: jest.fn(async () => [{ id: SUB }]),
      },
      protocolUser: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const module = await Test.createTestingModule({
      // As app.module.ts configures it, guard and all.
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }])],
      controllers: [DeviceSlotsController],
      providers: [
        DeviceSlotsService,
        DevicePresence,
        { provide: DeviceStateStore, useValue: DeviceStateStore.inMemory() },
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
      .overrideGuard(CustomerJwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const token = (req.headers.authorization ?? "").replace("Bearer ", "");
          req.user = { sub: `customer-${token}`, email: "a@b.c", sid: `session-${token}` };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const claim = (token: string) =>
    fetch(`${base}/customer/vpn/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ subscriptionId: SUB }),
    });

  it("does not refuse the 101st customer arriving from one address within a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 150; i++) statuses.push((await claim(`customer-${i}`)).status);

    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  it(`refuses one device past ${SLOT_REQUESTS_PER_MINUTE} requests a minute, and only that device`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= SLOT_REQUESTS_PER_MINUTE; i++) statuses.push((await claim("busy-device")).status);

    expect(statuses.slice(0, SLOT_REQUESTS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[SLOT_REQUESTS_PER_MINUTE]).toBe(429);
    // Its neighbour on the same address is untouched.
    expect((await claim("quiet-device")).status).toBe(200);
  });
});

describe("slotRequestTracker", () => {
  it("keys on the access token, hashed, and never on the address when there is one", () => {
    const a = slotRequestTracker({ ip: "10.0.0.1", headers: { authorization: "Bearer one" } });
    const b = slotRequestTracker({ ip: "10.0.0.1", headers: { authorization: "Bearer two" } });
    const c = slotRequestTracker({ ip: "10.0.0.2", headers: { authorization: "Bearer one" } });

    expect(a).not.toBe(b);
    expect(a).toBe(c);
    expect(a).not.toContain("one");
  });

  it("falls back to the address for a request with no token, which the guard then refuses", () => {
    expect(slotRequestTracker({ ip: "10.0.0.1", headers: {} })).toBe("ip:10.0.0.1");
  });
});
