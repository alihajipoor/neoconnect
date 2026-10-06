/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client and the service methods
   they replace, most of which have nothing to wait for in memory. */
import { UnauthorizedException } from "@nestjs/common";
import { ProtocolUsersService } from "./protocol-users.service";
import { encryptCredentials } from "./credentials-crypto";
import { KeyedLock } from "./keyed-lock";

/** Per-device VPN credentials (docs/per-device-credentials.md).
 *
 * The property everything here protects: signing out on one device cuts
 * that device off and leaves the customer's other devices working. So
 * the tests pin down which rows a device is handed, which rows a
 * sign-out removes, and that a failure anywhere falls back to what the
 * customer had before rather than to nothing. */

interface Row {
  id: string;
  subscriptionId: string;
  routeId: string;
  sessionId: string | null;
  nodeId: string;
  protocol: string;
  status: string;
  createdAt: Date;
  /** When a node acked it. Rows a test seeds are confirmed unless it
   * says otherwise; rows `create` makes are not, until `confirmAll`. */
  provisionedAt: Date | null;
}

const CUSTOMER = "customer-1";
const ME = "session-me";
const OTHER = "session-other";

/** A small in-memory stand-in for the queries the device paths make. */
function world(opts: {
  rows?: Partial<Row>[];
  subscriptions?: { id: string; customerId?: string; status?: string }[];
  sessions?: { id: string; customerId?: string; revokedAt?: Date | null; lastUsedAt?: Date }[];
  routes?: string[];
}) {
  let seq = 0;
  const rows: Row[] = (opts.rows ?? []).map((r) => ({
    id: r.id ?? `row-${++seq}`,
    subscriptionId: r.subscriptionId ?? "sub-1",
    routeId: r.routeId ?? "route-a",
    sessionId: r.sessionId ?? null,
    nodeId: r.nodeId ?? "node-1",
    protocol: r.protocol ?? "XRAY_VLESS_REALITY",
    status: r.status ?? "ACTIVE",
    createdAt: new Date(2026, 9, 1, 0, 0, seq),
    provisionedAt: r.provisionedAt === undefined ? new Date(2026, 9, 1) : r.provisionedAt,
  }));
  const subscriptions = (opts.subscriptions ?? [{ id: "sub-1" }]).map((s) => ({
    customerId: CUSTOMER,
    status: "ACTIVE",
    ...s,
  }));
  const sessions = (opts.sessions ?? [{ id: ME }]).map((s) => ({
    customerId: CUSTOMER,
    revokedAt: null as Date | null,
    lastUsedAt: new Date(),
    ...s,
  }));
  const routes = (opts.routes ?? ["route-a", "route-b"]).map((id) => ({ id }));

  const customerOf = (subscriptionId: string) => subscriptions.find((s) => s.id === subscriptionId)?.customerId;

  // Only the where-shapes these paths use; anything else fails loudly.
  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === "sessionId") {
        if (row.sessionId !== value) return false;
      } else if (key === "subscription") {
        if (customerOf(row.subscriptionId) !== (value as { customerId: string }).customerId) return false;
      } else if (key === "OR") {
        if (!(value as Record<string, unknown>[]).some((w) => matches(row, w))) return false;
      } else if (key === "subscriptionId" || key === "routeId" || key === "protocolConfigId") {
        if ((row as unknown as Record<string, unknown>)[key] !== value) return false;
      } else {
        throw new Error(`unsupported where key ${key}`);
      }
    }
    return true;
  }

  const prisma = {
    customerSession: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) => {
        const s = sessions.find((x) => x.id === where.id && x.customerId === where.customerId);
        return s ? { revokedAt: s.revokedAt } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { customerId: string; id: { not: string } } }) =>
        sessions
          .filter((s) => s.customerId === where.customerId && s.id !== where.id.not)
          .filter((s) => rows.some((r) => r.sessionId === s.id))
          .sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime())
          .map((s) => ({ id: s.id })),
      ),
    },
    subscription: {
      findMany: jest.fn(async ({ where }: { where: { customerId: string; status: string } }) =>
        subscriptions
          .filter((s) => s.customerId === where.customerId && s.status === where.status)
          .map((s) => ({ id: s.id, plan: { name: "Pro", protocolsAllowed: [], allowedRoutes: routes } })),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const s = subscriptions.find((x) => x.id === where.id);
        return s ? { status: s.status } : null;
      }),
    },
    route: {
      // provisionable now, then allowed by policy -- the same list here.
      findMany: jest.fn(async () => routes),
    },
    protocolUser: {
      findMany: jest.fn(async ({ where, include }: { where?: Record<string, unknown>; include?: unknown }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) =>
            include
              ? {
                  ...r,
                  externalUserId: `ext-${r.id}`,
                  protocolConfigId: "pc-1",
                  credentialsJson: encryptCredentials({ uuid: `uuid-${r.id}` }),
                  updatedAt: r.createdAt,
                  node: { publicIp: "203.0.113.5" },
                  protocolConfig: { protocol: r.protocol, listenPort: 443, publicParamsJson: {} },
                }
              : { ...r },
          ),
      ),
    },
    usageRecord: { findFirst: jest.fn(async () => null) },
  };

  const service = new ProtocolUsersService(prisma as never, {} as never);
  // create/remove/setEnabled have their own tests; here what matters is
  // which rows they are asked to make, remove or switch off.
  const create = jest
    .spyOn(service, "create")
    .mockImplementation(async ({ subscriptionId, routeId }, sessionId) => {
      const row: Row = {
        id: `row-${++seq}`,
        subscriptionId,
        routeId,
        sessionId: sessionId ?? null,
        nodeId: "node-1",
        protocol: "XRAY_VLESS_REALITY",
        status: "ACTIVE",
        createdAt: new Date(2026, 9, 2, 0, 0, seq),
        // Enqueued, not yet acked by the node.
        provisionedAt: null,
      };
      rows.push(row);
      return row as never;
    });
  /** Every node acks every pending CREATE_USER. */
  const confirmAll = () => {
    for (const row of rows) row.provisionedAt ??= new Date();
  };
  const remove = jest.spyOn(service, "remove").mockImplementation(async (id) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows.splice(i, 1);
  });
  const setEnabled = jest.spyOn(service, "setEnabled").mockImplementation(async (id, enabled) => {
    const row = rows.find((r) => r.id === id)!;
    row.status = enabled ? "ACTIVE" : "DISABLED";
    return row as never;
  });

  return { service, prisma, rows, sessions, subscriptions, create, remove, setEnabled, confirmAll };
}

describe("ProtocolUsersService.listForDevice", () => {
  const OLD_LIMIT = process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT;
  afterEach(() => {
    if (OLD_LIMIT === undefined) delete process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT;
    else process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = OLD_LIMIT;
  });

  it("gives a token from before sessions the shared credentials, and only those", async () => {
    const { service, prisma, create } = world({
      rows: [
        { id: "shared-a", routeId: "route-a" },
        { id: "other-a", routeId: "route-a", sessionId: OTHER },
      ],
      sessions: [{ id: OTHER }],
    });

    const result = await service.listForDevice(CUSTOMER, undefined);

    expect(result.map((u) => u.id)).toEqual(["shared-a"]);
    expect(prisma.protocolUser.findMany.mock.calls[0][0].where).toEqual({
      subscription: { customerId: CUSTOMER },
      sessionId: null,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("gives a device its own credential on every route, in place of the shared ones once the node has them", async () => {
    const { service, create, confirmAll } = world({
      rows: [
        { id: "shared-a", routeId: "route-a" },
        { id: "shared-b", routeId: "route-b" },
      ],
    });

    await service.listForDevice(CUSTOMER, ME);
    confirmAll();
    const result = await service.listForDevice(CUSTOMER, ME);

    expect(create.mock.calls.map((c) => [c[0].routeId, c[1]])).toEqual([
      ["route-a", ME],
      ["route-b", ME],
    ]);
    expect(result).toHaveLength(2);
    expect(result.every((u) => u.sessionId === ME)).toBe(true);
    expect(result.map((u) => u.id)).not.toContain("shared-a");
  });

  /** Creating a row and enqueueing its CREATE_USER is not the node having
   * it. A node whose control stream is down holds the command for days
   * while still serving the users it has; handing the device its new
   * credential then swapped a working tunnel for a dead one. */
  it("keeps handing out the shared credential until a node has confirmed the device's own", async () => {
    const { service, rows } = world({
      rows: [
        { id: "shared-a", routeId: "route-a" },
        { id: "shared-b", routeId: "route-b" },
      ],
    });

    const first = await service.listForDevice(CUSTOMER, ME);
    expect(first.map((u) => u.id).sort()).toEqual(["shared-a", "shared-b"]);

    // The node acks route-a's credential only.
    rows.find((r) => r.sessionId === ME && r.routeId === "route-a")!.provisionedAt = new Date();
    const second = await service.listForDevice(CUSTOMER, ME);

    const byRoute = Object.fromEntries(second.map((u) => [u.routeId, u]));
    expect(byRoute["route-a"].sessionId).toBe(ME);
    expect(byRoute["route-b"].id).toBe("shared-b");
    expect(second).toHaveLength(2);
  });

  // Nothing that works to keep, so nothing to wait for.
  it("hands out an unconfirmed device credential where there is no shared one", async () => {
    const { service } = world({ rows: [], routes: ["route-a"] });

    const result = await service.listForDevice(CUSTOMER, ME);

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe(ME);
  });

  it("never hands one device another device's credentials", async () => {
    const { service } = world({
      rows: [
        { id: "other-a", routeId: "route-a", sessionId: OTHER },
        { id: "other-b", routeId: "route-b", sessionId: OTHER },
      ],
      sessions: [{ id: ME }, { id: OTHER }],
    });

    const result = await service.listForDevice(CUSTOMER, ME);

    expect(result.map((u) => u.id)).not.toEqual(expect.arrayContaining(["other-a"]));
    expect(result.every((u) => u.sessionId === ME)).toBe(true);
  });

  // Asserted on the query: the filtering has to happen in the database.
  it("mints credentials only for ACTIVE subscriptions of an ACTIVE account", async () => {
    const { service, prisma } = world({});

    await service.listForDevice(CUSTOMER, ME);

    expect(prisma.subscription.findMany.mock.calls[0][0].where).toEqual({
      customerId: CUSTOMER,
      status: "ACTIVE",
      customer: { status: "ACTIVE" },
    });
  });

  it("is idempotent: a second fetch creates nothing and returns the same set", async () => {
    const { service, create } = world({});

    const first = await service.listForDevice(CUSTOMER, ME);
    const second = await service.listForDevice(CUSTOMER, ME);

    expect(create).toHaveBeenCalledTimes(2);
    expect(second.map((u) => u.id).sort()).toEqual(first.map((u) => u.id).sort());
  });

  it("creates one set when the same device fetches twice at once", async () => {
    const { service, create } = world({});

    await Promise.all([service.listForDevice(CUSTOMER, ME), service.listForDevice(CUSTOMER, ME)]);

    expect(create).toHaveBeenCalledTimes(2);
  });

  // The 15-minute access token outlives a sign-out; it must not be able
  // to mint a fresh set for the device that just signed out.
  it.each([
    ["signed out", [{ id: ME, revokedAt: new Date() }]],
    ["gone", [] as { id: string }[]],
    ["someone else's", [{ id: ME, customerId: "customer-2" }]],
  ])("refuses a session that is %s, creating nothing", async (_label, sessions) => {
    const { service, create } = world({ sessions });

    await expect(service.listForDevice(CUSTOMER, ME)).rejects.toThrow(UnauthorizedException);
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to the shared credential on a route where its own could not be made", async () => {
    const { service, create, confirmAll } = world({
      rows: [
        { id: "shared-a", routeId: "route-a" },
        { id: "shared-b", routeId: "route-b" },
      ],
    });
    create.mockImplementationOnce(async () => {
      throw new Error("No free addresses left in WireGuard subnet");
    });

    await service.listForDevice(CUSTOMER, ME);
    // route-a is tried again on the next fetch; let that one fail too.
    create.mockImplementationOnce(async () => {
      throw new Error("No free addresses left in WireGuard subnet");
    });
    confirmAll();
    const result = await service.listForDevice(CUSTOMER, ME);

    const byRoute = Object.fromEntries(result.map((u) => [u.routeId, u]));
    expect(byRoute["route-a"].id).toBe("shared-a");
    expect(byRoute["route-b"].sessionId).toBe(ME);
    expect(result).toHaveLength(2);
  });

  // A rollback to a backend that knows nothing of devices prunes signed-out
  // sessions, and the foreign key's SET NULL turns their rows into extra
  // shared ones. A device must still get exactly one credential per route.
  it("fills a gap with the oldest shared row when a rollback left more than one", async () => {
    const { service, create } = world({
      rows: [
        { id: "shared-original", routeId: "route-a" },
        { id: "shared-left-by-rollback", routeId: "route-a" },
      ],
      routes: ["route-a"],
    });
    create.mockImplementationOnce(async () => {
      throw new Error("config incomplete");
    });

    const result = await service.listForDevice(CUSTOMER, ME);

    expect(result.map((u) => u.id)).toEqual(["shared-original"]);
  });

  // A suspended subscription's credentials are switched off on the nodes;
  // creating an enabled one for whoever asks would undo the suspension.
  it("creates nothing for a subscription that is not ACTIVE, and shows its shared rows as they are", async () => {
    const { service, create } = world({
      subscriptions: [{ id: "sub-1", status: "SUSPENDED" }],
      rows: [{ id: "shared-a", routeId: "route-a", status: "DISABLED" }],
    });

    const result = await service.listForDevice(CUSTOMER, ME);

    expect(create).not.toHaveBeenCalled();
    expect(result.map((u) => [u.id, u.status])).toEqual([["shared-a", "DISABLED"]]);
  });

  it("switches new rows off if the subscription was suspended while they were made", async () => {
    const w = world({});
    w.create.mockImplementation(async ({ subscriptionId, routeId }, sessionId) => {
      w.subscriptions[0].status = "SUSPENDED";
      const row = { id: `new-${routeId}`, subscriptionId, routeId, sessionId: sessionId ?? null, nodeId: "n", protocol: "XRAY_VLESS_REALITY", status: "ACTIVE", createdAt: new Date(), provisionedAt: null };
      w.rows.push(row);
      return row as never;
    });

    await w.service.listForDevice(CUSTOMER, ME);

    expect(w.setEnabled.mock.calls.map((c) => c[1])).toEqual([false, false]);
    expect(w.rows.every((r) => r.status === "DISABLED")).toBe(true);
  });

  it("takes credentials back from the least recently used device past the limit", async () => {
    process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = "2";
    const now = Date.now();
    const { service, rows, remove } = world({
      sessions: [
        { id: ME },
        { id: "stale", lastUsedAt: new Date(now - 10 * 86_400_000) },
        { id: "fresh", lastUsedAt: new Date(now - 60_000) },
      ],
      rows: [
        { id: "stale-a", sessionId: "stale" },
        { id: "fresh-a", sessionId: "fresh" },
      ],
    });

    await service.listForDevice(CUSTOMER, ME);

    expect(remove.mock.calls.map((c) => c[0])).toEqual(["stale-a"]);
    expect(rows.some((r) => r.sessionId === "fresh")).toBe(true);
    expect(rows.filter((r) => r.sessionId === ME)).toHaveLength(2);
  });

  it("does not evict anyone for a device that already holds its set", async () => {
    process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = "1";
    const { service, remove } = world({
      sessions: [{ id: ME }, { id: OTHER }],
      rows: [
        { routeId: "route-a", sessionId: ME },
        { routeId: "route-a", sessionId: OTHER },
      ],
    });

    await service.listForDevice(CUSTOMER, ME);

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("ProtocolUsersService.revokeSessionCredentials", () => {
  // The owner's requirement: signing out on one device must not affect
  // any other.
  it("removes this device's credentials and leaves other devices and the shared set alone", async () => {
    const { service, rows, prisma } = world({
      sessions: [{ id: ME }, { id: OTHER }],
      rows: [
        { id: "shared-a" },
        { id: "me-a", sessionId: ME },
        { id: "me-b", routeId: "route-b", sessionId: ME },
        { id: "other-a", sessionId: OTHER },
      ],
    });

    const result = await service.revokeSessionCredentials(CUSTOMER, ME);

    expect(result).toEqual({ revoked: 2, failed: 0 });
    expect(rows.map((r) => r.id).sort()).toEqual(["other-a", "shared-a"]);
    // Scoped to the customer, so one customer can never revoke another's.
    expect(prisma.protocolUser.findMany.mock.calls[0][0].where).toEqual({
      sessionId: ME,
      subscription: { customerId: CUSTOMER },
    });
  });

  it("keeps going past a credential the node could not be told about, and reports it", async () => {
    const { service, remove, rows } = world({
      rows: [
        { id: "me-a", sessionId: ME },
        { id: "me-b", routeId: "route-b", sessionId: ME },
      ],
    });
    remove.mockImplementationOnce(async () => {
      throw new Error("enqueue failed");
    });

    const result = await service.revokeSessionCredentials(CUSTOMER, ME);

    expect(result).toEqual({ revoked: 1, failed: 1 });
    expect(rows.map((r) => r.id)).toEqual(["me-a"]);
  });
});

describe("ProtocolUsersService.sweepDeadSessionCredentials", () => {
  function sweepWorld(candidates: { id: string; revokedAt: Date | null }[], recentUse: string[] = []) {
    const w = world({
      rows: candidates.map((c) => ({ id: `${c.id}-a`, sessionId: c.id })),
      sessions: candidates.map((c) => ({ id: c.id })),
    });
    const prisma = w.prisma as unknown as Record<string, Record<string, jest.Mock>>;
    let served = false;
    prisma.customerSession.findMany = jest.fn(async () => {
      // One page, then empty -- what the cursor sees.
      if (served) return [];
      served = true;
      return candidates.map((c) => ({ ...c, customerId: CUSTOMER }));
    });
    prisma.customerSession.deleteMany = jest.fn(async () => ({ count: 1 }));
    prisma.usageRecord.findFirst = jest.fn(async ({ where }: { where: { protocolUser: { is: { sessionId: string } } } }) =>
      recentUse.includes(where.protocolUser.is.sessionId) ? { id: "usage" } : null,
    );
    return { ...w, prisma };
  }

  it("takes back a signed-out session's credentials and then deletes the session", async () => {
    const { service, rows, prisma } = sweepWorld([{ id: "gone", revokedAt: new Date() }]);

    await expect(service.sweepDeadSessionCredentials()).resolves.toEqual({ sessions: 1, revoked: 1, failed: 0 });
    expect(rows).toHaveLength(0);
    expect(prisma.customerSession.deleteMany).toHaveBeenCalledWith({
      where: { id: "gone", protocolUsers: { none: {} } },
    });
  });

  // A refresh token dies after a week, but a device goes on connecting
  // with what it holds -- an always-on tunnel, or a filtered control
  // plane. Traffic is use.
  it("leaves an idle session alone while its credentials still carry traffic", async () => {
    const { service, rows, prisma } = sweepWorld([{ id: "idle-but-used", revokedAt: null }], ["idle-but-used"]);

    await expect(service.sweepDeadSessionCredentials()).resolves.toEqual({ sessions: 0, revoked: 0, failed: 0 });
    expect(rows).toHaveLength(1);
    expect(prisma.customerSession.deleteMany).not.toHaveBeenCalled();
  });

  it("reclaims an idle session nothing has used", async () => {
    const { service, rows } = sweepWorld([{ id: "idle", revokedAt: null }]);

    await service.sweepDeadSessionCredentials();

    expect(rows).toHaveLength(0);
  });

  it("keeps the session row when a credential could not be revoked, for the next pass", async () => {
    const { service, remove, prisma } = sweepWorld([{ id: "gone", revokedAt: new Date() }]);
    remove.mockImplementationOnce(async () => {
      throw new Error("enqueue failed");
    });

    await expect(service.sweepDeadSessionCredentials()).resolves.toEqual({ sessions: 1, revoked: 0, failed: 1 });
    expect(prisma.customerSession.deleteMany).not.toHaveBeenCalled();
  });
});

describe("ProtocolUsersService.provisionAll with device credentials", () => {
  function build(existing: { id: string; routeId: string; sessionId: string | null }[], allowed: string[]) {
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: { name: "Pro", protocolsAllowed: ["XRAY_VLESS_REALITY"], allowedRoutes: allowed.map((id) => ({ id })) },
        }),
      },
      route: { findMany: jest.fn().mockResolvedValue(allowed.map((id) => ({ id }))) },
      protocolUser: { findMany: jest.fn().mockResolvedValue(existing) },
    };
    const service = new ProtocolUsersService(prisma as never, {} as never);
    const create = jest.spyOn(service, "create").mockImplementation(async ({ routeId }) => ({ routeId }) as never);
    const remove = jest.spyOn(service, "remove").mockResolvedValue(undefined);
    return { service, create, remove };
  }

  it("revokes a route the plan dropped from every device, not only from the shared set", async () => {
    const { service, remove } = build(
      [
        { id: "shared-x", routeId: "route-x", sessionId: null },
        { id: "me-x", routeId: "route-x", sessionId: ME },
        { id: "me-a", routeId: "route-a", sessionId: ME },
      ],
      ["route-a"],
    );

    const { revoked } = await service.provisionAll("sub-1");

    expect(revoked.sort()).toEqual(["me-x", "shared-x"]);
    expect(remove).not.toHaveBeenCalledWith("me-a");
  });

  // A device's own credential on a route is not the shared one: counting
  // it as such would leave the shared set short of that route.
  it("still creates the shared credential when only a device holds the route", async () => {
    const { service, create } = build([{ id: "me-a", routeId: "route-a", sessionId: ME }], ["route-a"]);

    const { created } = await service.provisionAll("sub-1");

    expect(created).toHaveLength(1);
    expect(create).toHaveBeenCalledWith({ subscriptionId: "sub-1", routeId: "route-a" });
  });
});

describe("ProtocolUsersService.create for a device", () => {
  function build() {
    const stored: { credentialsJson: string; sessionId?: string }[] = [];
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: "sub-1",
          plan: { name: "Pro", allowedRoutes: [{ id: "route-wg" }], maxDownloadMbps: null, maxUploadMbps: null },
        }),
      },
      route: {
        findUnique: jest.fn().mockResolvedValue({
          id: "route-wg",
          isEnabled: true,
          entryProtocolConfig: {
            id: "pc-wg",
            nodeId: "node-1",
            protocol: "WIREGUARD",
            transport: "TCP",
            inboundTag: null,
            listenPort: 51820,
            publicParamsJson: { serverPublicKey: "server-pub", endpoint: "198.51.100.7:51820", subnetCidr: "10.66.0.0/24" },
            node: { publicIp: "198.51.100.7" },
          },
        }),
      },
      protocolUser: {
        findMany: jest.fn(async () => stored.map((s) => ({ credentialsJson: s.credentialsJson }))),
        create: jest.fn(async ({ data }: { data: { credentialsJson: string; sessionId?: string } }) => {
          // A database round trip, so a concurrent allocation would have
          // the chance to read the same free address before this lands.
          await new Promise((resolve) => setTimeout(resolve, 2));
          stored.push(data);
          return { id: `pu-${stored.length}`, ...data };
        }),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    const service = new ProtocolUsersService(prisma as never, agentGateway as never);
    return { service, prisma, agentGateway, stored };
  }

  it("records the device on the row and provisions it on the node like any other user", async () => {
    const { service, prisma, agentGateway } = build();

    await service.create({ subscriptionId: "sub-1", routeId: "route-wg" }, ME);

    expect(prisma.protocolUser.create.mock.calls[0][0].data.sessionId).toBe(ME);
    expect(agentGateway.enqueueCommand).toHaveBeenCalledWith(
      "node-1",
      "CREATE_USER",
      expect.objectContaining({ protocol: "WIREGUARD", externalUserId: expect.any(String) }),
    );
  });

  it("leaves the shared credential's row without a session", async () => {
    const { service, prisma } = build();

    await service.create({ subscriptionId: "sub-1", routeId: "route-wg" });

    expect(prisma.protocolUser.create.mock.calls[0][0].data).not.toHaveProperty("sessionId");
  });

  // Two peers on one address break the older one. Lazy provisioning makes
  // concurrent creation on one WireGuard config an everyday event.
  it("never gives two concurrently created WireGuard peers the same address", async () => {
    const { service, agentGateway } = build();

    await Promise.all([
      service.create({ subscriptionId: "sub-1", routeId: "route-wg" }, ME),
      service.create({ subscriptionId: "sub-1", routeId: "route-wg" }, OTHER),
      service.create({ subscriptionId: "sub-1", routeId: "route-wg" }),
    ]);

    const addresses = agentGateway.enqueueCommand.mock.calls.map(
      (c) => (c[2] as { credentials: { address: string } }).credentials.address,
    );
    expect(new Set(addresses).size).toBe(3);
  });
});

describe("KeyedLock", () => {
  it("runs work for one key one at a time, in order", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const step = (name: string, ms: number) =>
      lock.run("k", async () => {
        log.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`${name}:end`);
      });

    await Promise.all([step("a", 5), step("b", 1)]);

    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(lock.size).toBe(0);
  });

  it("does not wedge a key when work fails", async () => {
    const lock = new KeyedLock();

    await expect(lock.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock.run("k", async () => "after")).resolves.toBe("after");
  });

  it("lets different keys run at the same time", async () => {
    const lock = new KeyedLock();
    let inFlight = 0;
    let overlapped = false;
    const work = () =>
      (async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      })();

    await Promise.all([lock.run("a", work), lock.run("b", work)]);

    expect(overlapped).toBe(true);
  });
});
