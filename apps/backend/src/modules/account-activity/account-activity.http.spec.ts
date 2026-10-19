/* eslint-disable @typescript-eslint/require-await -- the Prisma stand-in
   matches the client's async signatures. */
import { Logger, ValidationPipe, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { AddressInfo, Server } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { DeviceSlotsService } from "../device-slots/device-slots.service";
import { CustomerAuthService } from "../customer-auth/customer-auth.service";
import { AccountActivityController } from "./account-activity.controller";
import { AccountDevicesService } from "./account-devices.service";
import { DailyUsageService } from "./daily-usage.service";
import { deviceIdFor } from "./device-id";

/** The contract of docs/account-activity.md over a real Nest server on a
 * real port, with the validation pipe production uses: paths, status
 * codes, query validation and the JSON a client parses. The services are
 * the real ones; Postgres and the slot store are stand-ins. */

const SUB = "11111111-1111-4111-8111-111111111111";
const SECRET = "http-spec-secret";

describe("account activity over HTTP", () => {
  let app: INestApplication;
  let base: string;
  const auth = { revokeSession: jest.fn(async () => undefined) };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const now = Date.now();
    const sessions = [
      { id: "session-pc", customerId: "customer-1", label: null, platform: "windows", createdAt: new Date(now - 86_400_000), lastUsedAt: new Date(now - 60_000) },
      { id: "session-phone", customerId: "customer-1", label: "Pixel 7", platform: "android", createdAt: new Date(now - 86_400_000), lastUsedAt: new Date(now - 60_000) },
    ];
    const prisma = {
      customerSession: {
        findMany: jest.fn(async ({ where }: { where: { customerId: string } }) =>
          sessions.filter((s) => s.customerId === where.customerId),
        ),
      },
      subscription: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) =>
          where.id === SUB && where.customerId === "customer-1" ? { id: SUB, createdAt: new Date("2025-01-01T00:00:00Z") } : null,
        ),
      },
      customer: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "customer-1" ? { createdAt: new Date("2025-01-01T00:00:00Z") } : null,
        ),
      },
      $queryRaw: jest.fn(async () => [
        { bucket: BigInt(Math.floor(now / 1000 / 900) * 900), up: "1024", down: "4096" },
      ]),
    };
    const slots = {
      inUse: jest.fn(async () => ({ known: true, sessions: new Map([["session-pc", { since: now - 600_000, lastSeen: now }]]) })),
    };

    const module = await Test.createTestingModule({
      controllers: [AccountActivityController],
      providers: [
        AccountDevicesService,
        DailyUsageService,
        { provide: PrismaService, useValue: prisma },
        { provide: DeviceSlotsService, useValue: slots },
        { provide: CustomerAuthService, useValue: auth },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => ({ "customerJwt.accessSecret": SECRET, "customerJwt.refreshTtl": "7d" })[key] },
        },
      ],
    })
      // Who is calling, without signing a JWT: the session comes from a
      // test header. The real guard is what production authenticates with.
      .overrideGuard(CustomerJwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
          req.user = { sub: req.headers["x-test-customer"] ?? "customer-1", email: "a@b.c", sid: req.headers["x-test-session"] };
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

  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { "x-test-session": "session-phone", ...headers } });

  describe("GET /customer/devices", () => {
    it("lists the devices with this one marked and the one in use saying so", async () => {
      const res = await call("GET", "/customer/devices");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { inUseKnown: boolean; devices: Record<string, unknown>[] };
      expect(body.inUseKnown).toBe(true);
      expect(body.devices).toEqual([
        expect.objectContaining({ id: deviceIdFor(SECRET, "customer-1", "session-phone"), thisDevice: true, label: "Pixel 7", platform: "android", inUse: null }),
        expect.objectContaining({ id: deviceIdFor(SECRET, "customer-1", "session-pc"), thisDevice: false, platform: "windows", inUse: expect.objectContaining({ since: expect.any(String) }) }),
      ]);
      for (const device of body.devices) {
        expect(Object.keys(device).sort()).toEqual(["id", "inUse", "label", "lastSeenAt", "platform", "signedInAt", "thisDevice"]);
      }
    });
  });

  describe("DELETE /customer/devices/:id", () => {
    beforeEach(() => auth.revokeSession.mockClear());

    it("signs the other device out: 204", async () => {
      const res = await call("DELETE", `/customer/devices/${deviceIdFor(SECRET, "customer-1", "session-pc")}`);
      expect(res.status).toBe(204);
      expect(auth.revokeSession).toHaveBeenCalledWith("customer-1", "session-pc");
    });

    it("answers 400 THIS_DEVICE for the caller's own device", async () => {
      const res = await call("DELETE", `/customer/devices/${deviceIdFor(SECRET, "customer-1", "session-phone")}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "THIS_DEVICE" });
      expect(auth.revokeSession).not.toHaveBeenCalled();
    });

    it("answers 404 for a device of another account", async () => {
      const res = await call("DELETE", `/customer/devices/${deviceIdFor(SECRET, "customer-1", "session-pc")}`, {
        "x-test-customer": "customer-2",
      });
      expect(res.status).toBe(404);
      expect(auth.revokeSession).not.toHaveBeenCalled();
    });
  });

  describe("GET /customer/usage", () => {
    it("answers the account's days in the caller's zone", async () => {
      const res = await call("GET", "/customer/usage?days=31&tz=Asia/Tehran");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { subscriptionId: string | null; days: { bytesUp: string; bytesDown: string }[] };
      expect(body.subscriptionId).toBeNull();
      expect(body.days).toHaveLength(31);
      expect(body.days.at(-1)).toMatchObject({ bytesUp: "1024", bytesDown: "4096" });
    });

    it.each(["days=0", "days=32", "tz=Mars/Olympus_Mons", "since=2026-01-01"])("answers 400 to %s", async (query) => {
      const res = await call("GET", `/customer/usage?${query}`);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /customer/subscriptions/:id/usage", () => {
    it("answers the days in the caller's zone", async () => {
      const res = await call("GET", `/customer/subscriptions/${SUB}/usage?days=7&tz=Asia/Tehran`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { timeZone: string; days: { date: string; bytesUp: string; bytesDown: string }[] };
      expect(body.timeZone).toBe("Asia/Tehran");
      expect(body.days).toHaveLength(7);
      expect(body.days.at(-1)).toMatchObject({ bytesUp: "1024", bytesDown: "4096" });
    });

    it.each([
      ["days=0", "days=0"],
      ["days=32", "days=32"],
      ["days that is not a number", "days=week"],
      ["a field the contract does not have", "days=7&nocache=1"],
    ])("answers 400 to %s", async (_label, query) => {
      const res = await call("GET", `/customer/subscriptions/${SUB}/usage?${query}`);
      expect(res.status).toBe(400);
    });

    it("answers 400 UNKNOWN_TIME_ZONE to a zone that is not one", async () => {
      const res = await call("GET", `/customer/subscriptions/${SUB}/usage?tz=Mars/Olympus_Mons`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "UNKNOWN_TIME_ZONE" });
    });

    it("answers 404 for another customer's subscription", async () => {
      const res = await call("GET", `/customer/subscriptions/${SUB}/usage`, { "x-test-customer": "customer-2" });
      expect(res.status).toBe(404);
    });
  });
});
