import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CustomerActivityService } from "./customer-activity.service";
import { CustomerInsightService, shortenIds } from "./customer-insight.service";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const ME = "aaaaaaaa-1111-4111-8111-111111111111";
const ROUTE = "11111111-1111-4111-8111-111111111111";
const SUB = "bbbbbbbb-2222-4222-8222-222222222222";

let seq = 0;
const row = (over: Record<string, unknown> = {}) => ({
  id: `att-${++seq}`,
  routeId: null,
  kind: "CONNECT",
  outcome: "SUCCESS",
  platform: "windows",
  appVersion: "0.9.50",
  asn: 64500,
  ip: null,
  via: null,
  protocol: null,
  reason: null,
  sessionSeconds: null,
  attemptsJson: null,
  apiEndpoint: null,
  occurredAt: null,
  createdAt: new Date(NOW - 10 * MIN),
  ...over,
});

function build(rows: ReturnType<typeof row>[] = []) {
  const prisma = {
    customer: {
      findUnique: jest.fn().mockResolvedValue({
        id: ME,
        email: "me@example.com",
        createdAt: new Date(NOW - 30 * DAY),
        emailVerifiedAt: new Date(NOW - 29 * DAY),
        status: "ACTIVE",
        locale: "en",
        signupChannel: "NORMAL",
        referredBy: null,
        identities: [],
        _count: { referrals: 2 },
      }),
    },
    clientAttempt: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
      count: jest.fn().mockResolvedValue(rows.length),
    },
    subscription: { findMany: jest.fn().mockResolvedValue([]) },
    protocolUser: { findMany: jest.fn().mockResolvedValue([]) },
    voucher: { findMany: jest.fn().mockResolvedValue([]) },
    node: { findMany: jest.fn().mockResolvedValue([{ id: "node-1", name: "alpha", publicIp: "203.0.113.1" }]) },
    route: {
      findMany: jest.fn().mockResolvedValue([
        { id: ROUTE, entryProtocolConfig: { node: { name: "alpha" } }, exitProtocolConfig: null },
      ]),
    },
    customerIdentity: { findMany: jest.fn().mockResolvedValue([]) },
    customerSession: { findMany: jest.fn().mockResolvedValue([]) },
    voucherRedemption: { findMany: jest.fn().mockResolvedValue([]) },
    paymentTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    supportTicket: { findMany: jest.fn().mockResolvedValue([]) },
    adminAuditEntry: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const asn = { orgOf: jest.fn(() => "Example Net"), countryOfAsn: jest.fn(() => "ZZ") };
  const updates = { cachedVersion: jest.fn((p: string) => (p === "windows" ? "0.9.57" : null)) };
  const activity = new CustomerActivityService(prisma as never, asn as never, {} as never);
  const service = new CustomerInsightService(prisma as never, activity, asn as never, updates as never);
  return { prisma, service, updates };
}

describe("CustomerInsightService.insight", () => {
  it("404s for a customer that does not exist", async () => {
    const { service, prisma } = build();
    prisma.customer.findUnique.mockResolvedValue(null);
    await expect(service.insight(ME, {}, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("counts attempts, not background reports, and reads routes, failures and the app version", async () => {
    const rows = [
      row({
        outcome: "SUCCESS",
        routeId: ROUTE,
        protocol: "Stealth",
        attemptsJson: [
          { protocol: "Fast", result: "up but unreachable", routeId: ROUTE, carried: false },
          { protocol: "Stealth", result: "not dialled -- its server was too slow a moment ago" },
          { protocol: "Stealth", result: "connected", routeId: ROUTE, carried: true, downKbps: 4000, upKbps: 800 },
        ],
      }),
      row({
        outcome: "CONTROL_PLANE_UNREACHABLE",
        reason: "pre-connect config refresh failed (no answer within 6000ms) after 6001ms; connecting on cached credentials",
      }),
      row({ kind: "SESSION", outcome: "SUCCESS", sessionSeconds: 600 }),
      row({ outcome: "SUCCESS", reason: "resume refresh found changed server parameters: x" }),
      row({ outcome: "ENGINE_FAILED", reason: "The Neoxify background service did not answer within 30s. Seen at 192.0.2.4." }),
    ];
    const { service } = build(rows);
    const insight = await service.insight(ME, { days: "7" }, NOW);

    expect(insight.reports).toMatchObject({ connect: 2, api: 1, session: 1, config: 1 });
    expect(insight.connect).toMatchObject({ tried: 2, succeeded: 1 });
    expect(insight.connect.lastSuccess).toMatchObject({ server: "alpha", protocol: "Stealth", network: { asn: 64500, name: "Example Net" } });
    expect(insight.networks).toEqual([
      expect.objectContaining({ asn: 64500, tried: 2, succeeded: 1, apiUnreachable: 1, country: "ZZ", others: null }),
    ]);
    expect(insight.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "alpha", protocol: "Stealth", dialled: 1, connected: 1, carried: 1, notDialled: 0, medianDownKbps: 4000 }),
        expect.objectContaining({ server: null, protocol: "Stealth", notDialled: 1, dialled: 0 }),
        expect.objectContaining({ server: "alpha", protocol: "Fast", dialled: 1, connected: 0 }),
      ]),
    );
    const codes = Object.fromEntries(insight.failures.map((f) => [f.code, f]));
    expect(codes.NOT_CARRYING.count).toBe(1);
    expect(codes.API_UNREACHABLE.count).toBe(1);
    expect(codes.SERVICE_NOT_ANSWERING.example).toContain("Seen at <address>.");
    expect(insight.sessions).toMatchObject({ count: 1, totalSeconds: 600, longestSeconds: 600 });
    expect(insight.apps).toEqual([expect.objectContaining({ platform: "windows", appVersion: "0.9.50", latestVersion: "0.9.57", behind: true })]);
    expect(insight.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["SERVICE_NOT_ANSWERING", "APP_BEHIND", "NO_ACTIVE_PLAN"]));
  });

  it("does not count the ladder's 'going back to it' line as a dial", async () => {
    const rows = [
      row({
        outcome: "SUCCESS",
        routeId: ROUTE,
        protocol: "Fast",
        attemptsJson: [
          { protocol: "Fast", result: "connected", routeId: ROUTE, carried: true },
          { protocol: "Stealth", result: "up but unreachable", routeId: ROUTE, carried: false },
          {
            protocol: "Fast",
            result: "going back to it -- slow, but it works; 1 more dialled in 9 s found nothing better, 2 further not dialled yet",
            routeId: ROUTE,
          },
        ],
      }),
    ];
    const { service } = build(rows);
    const insight = await service.insight(ME, { days: "7" }, NOW);
    const fast = insight.routes.find((r) => r.protocol === "Fast");
    expect(fast).toMatchObject({ dialled: 1, connected: 1, notDialled: 0, lastResult: "connected" });
    expect(insight.routes.find((r) => r.protocol === "Stealth")).toMatchObject({ dialled: 1, notDialled: 0 });
  });

  it("reads credentials without credentialsJson, and says others only with three or more", async () => {
    const { service, prisma } = build([row({ attemptsJson: [{ protocol: "Fast", result: "connected" }] })]);
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: SUB,
        status: "ACTIVE",
        startAt: new Date(NOW - DAY),
        expireAt: new Date(NOW + DAY),
        dataCapBytes: null,
        dataUsedBytes: 5n,
        plan: { name: "Pro" },
      },
    ]);
    prisma.protocolUser.findMany.mockResolvedValue([
      { subscriptionId: SUB, protocol: "SHADOWSOCKS", status: "ACTIVE", provisionedAt: null, heldUntil: new Date(NOW + MIN), sessionId: "s" },
      { subscriptionId: SUB, protocol: "SHADOWSOCKS", status: "DISABLED", provisionedAt: new Date(NOW), heldUntil: null, sessionId: null },
    ]);
    prisma.clientAttempt.findMany.mockImplementation(({ where }: { where: { asn?: number } }) =>
      Promise.resolve(
        where.asn
          ? ["c1", "c2", "c3"].map((customerId, i) => ({ customerId, kind: "CONNECT", outcome: i < 2 ? "SUCCESS" : "OTHER", reason: null, attemptsJson: [{}] }))
          : [row({ attemptsJson: [{ protocol: "Fast", result: "connected" }] })],
      ),
    );
    const insight = await service.insight(ME, {}, NOW);
    const select = prisma.protocolUser.findMany.mock.calls[0][0].select;
    expect(select.credentialsJson).toBeUndefined();
    expect(insight.credentials[0]).toMatchObject({ total: 2, active: 1, notProvisioned: 1, held: 1, perDevice: 1, dataUsedBytes: "5" });
    expect(insight.networks[0].others).toEqual({ customers: 3, connected: 2, hours: 48 });
  });
});

describe("CustomerInsightService.attempts", () => {
  it("pages in the database without derived filters, and adds the derived fields", async () => {
    const { service, prisma } = build([
      row({ outcome: "CONTROL_PLANE_UNREACHABLE", reason: "dashboard load: no answer from Neoxify", apiEndpoint: "req: a.example=timeout@8000", ip: "203.0.113.1" }),
    ]);
    const page = await service.attempts(ME, { take: "10", skip: "0", kind: "CONNECT" }, NOW);
    expect(prisma.clientAttempt.findMany.mock.calls[0][0]).toMatchObject({ take: 10, skip: 0, where: { customerId: ME, kind: "CONNECT" } });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      category: "api",
      failureCode: "API_UNREACHABLE",
      // The same address rule as /activity: a report through our server.
      ip: null,
      throughServer: "alpha",
      apiTrace: { entries: [{ leg: "req", target: "a.example", outcome: "timeout", ms: 8000 }], probe: null },
    });
  });

  it("filters derived fields and text in memory, capped", async () => {
    const { service, prisma } = build([
      row({ outcome: "SUCCESS" }),
      row({ outcome: "OTHER", attemptsJson: [{ protocol: "Fast", result: "up but unreachable" }] }),
    ]);
    const page = await service.attempts(ME, { q: "UNREACHABLE" }, NOW);
    expect(prisma.clientAttempt.findMany.mock.calls[0][0].take).toBe(5000);
    expect(page.total).toBe(1);
    expect(page.items[0].failureCode).toBe("NOT_CARRYING");
  });

  it("matches a failureCode the way the failures card counts it, rungs included", async () => {
    const { service } = build([
      // Landed after a failed rung: the report has no code of its own.
      row({ outcome: "SUCCESS", attemptsJson: [{ protocol: "Fast", result: "timed out" }, { protocol: "Stealth", result: "connected" }] }),
      // Failed on two rungs whose causes differ.
      row({
        outcome: "OTHER",
        reason: "tried 2 of 2",
        attemptsJson: [{ protocol: "Stealth", result: "up but unreachable" }, { protocol: "Fast", result: "timed out" }],
      }),
      // A phone rung skipped without dialling is not a failure.
      row({ outcome: "SUCCESS", platform: "android", attemptsJson: [{ protocol: "IKEv2", result: "not available with selected apps" }, { protocol: "Fast", result: "connected" }] }),
    ]);
    const insight = await service.insight(ME, {}, NOW);
    expect(insight.failures.reduce((n, f) => n + f.count, 0)).toBe(3);
    for (const f of insight.failures) {
      const page = await service.attempts(ME, { failureCode: f.code }, NOW);
      expect({ code: f.code, total: page.total }).toEqual({ code: f.code, total: f.count });
    }
  });

  it("refuses an unknown filter value rather than querying with it", async () => {
    const { service } = build();
    await expect(service.attempts(ME, { kind: "NOPE" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.attempts(ME, { from: "yesterday" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.attempts(ME, { category: "nope" }, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("CustomerInsightService.history", () => {
  it("includes staff actions only for a SUPERADMIN, with ids shortened", async () => {
    const { service, prisma } = build();
    prisma.adminAuditEntry.findMany.mockResolvedValue([
      { createdAt: new Date(NOW), method: "PATCH", path: `/api/customers/${ME}`, status: 200, email: "boss@example.com", role: "SUPERADMIN" },
    ]);
    const support = await service.history(ME, {}, { role: "SUPPORT" } as never, NOW);
    expect(prisma.adminAuditEntry.findMany).not.toHaveBeenCalled();
    expect(support.items.map((e) => e.type)).toEqual(["EMAIL_VERIFIED", "ACCOUNT_CREATED"]);

    const admin = await service.history(ME, {}, { role: "SUPERADMIN" } as never, NOW);
    expect(admin.items[0]).toMatchObject({ type: "STAFF_ACTION", title: "PATCH /api/customers/aaaaaaaa…", actor: "boss@example.com" });
    expect(admin.total).toBe(3);
  });

  it("dates an ended subscription only by a past expiry, and pages newest first", async () => {
    const { service, prisma } = build();
    prisma.subscription.findMany.mockResolvedValue([
      { id: SUB, status: "EXPIRED", startAt: new Date(NOW - 40 * DAY), expireAt: new Date(NOW - 10 * DAY), plan: { name: "Pro" } },
      { id: "s2", status: "CANCELLED", startAt: new Date(NOW - 5 * DAY), expireAt: new Date(NOW + 25 * DAY), plan: { name: "Max" } },
    ]);
    const page = await service.history(ME, { take: "2" }, { role: "SUPPORT" } as never, NOW);
    expect(page.total).toBe(5);
    expect(page.items.map((e) => e.type)).toEqual(["SUBSCRIPTION_STARTED", "SUBSCRIPTION_ENDED"]);
    expect(page.items[1].at).toBe(new Date(NOW - 10 * DAY).toISOString());
  });
});

describe("shortenIds", () => {
  it("cuts each uuid to eight characters", () => {
    expect(shortenIds(`/api/subscriptions/${SUB}/renew`)).toBe("/api/subscriptions/bbbbbbbb…/renew");
  });
});
