/* eslint-disable @typescript-eslint/require-await -- the Prisma stand-in
   matches the client's async signatures. */
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { AddressInfo, Server } from "node:net";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminAuditService, AUDIT_RETENTION_MS, type AdminAuditRecord } from "./admin-audit.service";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

@Controller("things")
class ThingsController {
  @Post()
  create() {
    return { ok: true };
  }

  @Post(":id/archive")
  @HttpCode(204)
  archive() {
    return undefined;
  }

  @Post("forbidden")
  forbidden() {
    throw new ForbiddenException("no");
  }

  @Get()
  list() {
    return [];
  }
}

/** Stands in for JwtAuthGuard: whoever the test says is calling. */
let caller: unknown = null;
class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    ctx.switchToHttp().getRequest<{ user?: unknown }>().user = caller ?? undefined;
    return true;
  }
}

const OWNER = { sub: "admin-1", email: "owner@example.com", role: "SUPERADMIN" };

describe("the admin action log over HTTP", () => {
  let app: INestApplication;
  let base: string;
  let recorded: AdminAuditRecord[];

  beforeEach(async () => {
    recorded = [];
    caller = null;
    const module = await Test.createTestingModule({
      controllers: [ThingsController],
      providers: [
        { provide: AdminAuditService, useValue: { record: async (entry: AdminAuditRecord) => void recorded.push(entry) } },
        { provide: APP_GUARD, useClass: FakeAuth },
        { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  const call = async (method: string, path: string) => {
    const res = await fetch(`${base}${path}`, { method });
    await res.text();
    // The entry is written as the response finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return res.status;
  };

  it("records an admin's change with the status it got, and the path without its query", async () => {
    caller = OWNER;
    expect(await call("POST", "/things?secret=x")).toBe(201);
    expect(recorded).toEqual([
      expect.objectContaining({ adminId: "admin-1", email: "owner@example.com", role: "SUPERADMIN", method: "POST", path: "/things", status: 201 }),
    ]);
  });

  // Set after the handler returns: read when the response goes out.
  it("records the status @HttpCode and exception filters set", async () => {
    caller = OWNER;
    expect(await call("POST", "/things/42/archive")).toBe(204);
    expect(await call("POST", "/things/forbidden")).toBe(403);
    expect(recorded.map((r) => [r.path, r.status])).toEqual([
      ["/things/42/archive", 204],
      ["/things/forbidden", 403],
    ]);
  });

  it("leaves reads out", async () => {
    caller = OWNER;
    expect(await call("GET", "/things")).toBe(200);
    expect(recorded).toEqual([]);
  });

  // A customer's token carries no role; nobody at all, no user.
  it("records nobody but admins", async () => {
    caller = { sub: "customer-1", email: "c@example.com", sid: "s1" };
    await call("POST", "/things");
    caller = { sub: "x", email: "x@example.com", role: "CUSTOMER" };
    await call("POST", "/things");
    caller = null;
    await call("POST", "/things");
    expect(recorded).toEqual([]);
  });
});

describe("AdminAuditService", () => {
  function build() {
    const created: unknown[] = [];
    const prisma = {
      adminAuditEntry: {
        create: jest.fn(async ({ data }: { data: unknown }) => void created.push(data)),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async (args: unknown) => args),
      },
    };
    return { service: new AdminAuditService(prisma as never), prisma, created };
  }
  const entry: AdminAuditRecord = { adminId: "a", email: "o@example.com", role: "SUPERADMIN", method: "POST", path: "/x", status: 201 };

  // The change it describes has already been made.
  it("never throws when the write fails", async () => {
    const { service, prisma } = build();
    prisma.adminAuditEntry.create.mockRejectedValueOnce(new Error("db down"));
    await expect(service.record(entry)).resolves.toBeUndefined();
  });

  it("prunes what is past retention, at most once a day", async () => {
    const { service, prisma } = build();
    const now = Date.UTC(2026, 9, 18);
    await service.record(entry, now);
    await service.record(entry, now + 3_600_000);
    expect(prisma.adminAuditEntry.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminAuditEntry.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(now - AUDIT_RETENTION_MS) } },
    });
    await service.record(entry, now + 25 * 3_600_000);
    expect(prisma.adminAuditEntry.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("lists newest first, a page of 1 to 500, and pages by date", async () => {
    const { service } = build();
    expect(await service.list(10_000)).toMatchObject({ take: 500, orderBy: { createdAt: "desc" }, where: undefined });
    expect(await service.list(0)).toMatchObject({ take: 100 });
    const before = new Date("2026-10-01T00:00:00Z");
    expect(await service.list(5, before)).toMatchObject({ take: 5, where: { createdAt: { lt: before } } });
    expect(await service.list(5, new Date("junk"))).toMatchObject({ where: undefined });
  });
});
