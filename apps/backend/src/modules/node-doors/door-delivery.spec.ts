import { deviceSlotsStub } from "../../../test/device-slots-stub";
import { encryptCredentials } from "../protocol-users/credentials-crypto";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { DOOR_FRESH_MS } from "./door";

/** What GET /customer/protocol-users answers once nodes have doors: each
 * credential's `connection` carries its server's door, and a server
 * without one answers exactly what it answered before doors existed. */

const PIN_A = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PIN_B = "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

const saved = process.env.NODE_DOORS;
beforeEach(() => delete process.env.NODE_DOORS);
afterAll(() => {
  if (saved === undefined) delete process.env.NODE_DOORS;
  else process.env.NODE_DOORS = saved;
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const node = (over: Record<string, unknown> = {}) => ({
  id: "node-1",
  name: "alpha",
  publicIp: "203.0.113.9",
  status: "ONLINE",
  mirrorHost: null,
  doorPort: null,
  doorSni: null,
  doorPin: null,
  doorPreviousPin: null,
  doorPinChangedAt: null,
  doorVerifiedAt: null,
  ...over,
});

const WITH_DOOR = {
  doorPort: 2053,
  doorSni: "static.example.com",
  doorPin: PIN_B,
  doorPreviousPin: PIN_A,
  doorPinChangedAt: minutesAgo(90),
  doorVerifiedAt: minutesAgo(5),
};

const credential = (id: string, routeId: string, on: ReturnType<typeof node>) => ({
  id,
  subscriptionId: "sub-1",
  routeId,
  nodeId: on.id,
  protocolConfigId: "cfg-1",
  protocol: "XRAY_VLESS_TLS",
  externalUserId: `ext-${id}`,
  credentialsJson: encryptCredentials({ uuid: `uuid-${id}` }),
  status: "ACTIVE",
  sessionId: null,
  createdAt: new Date(2026, 0, 1),
  updatedAt: new Date(2026, 0, 1),
  node: on,
  protocolConfig: {
    protocol: "XRAY_VLESS_TLS",
    listenPort: 2053,
    transport: "TCP",
    security: "TLS",
    publicParamsJson: { serverName: "a.example.test" },
  },
});

async function list(rows: ReturnType<typeof credential>[]) {
  const prisma = { protocolUser: { findMany: jest.fn().mockResolvedValue(rows) } };
  const service = new ProtocolUsersService(prisma as never, {} as never, deviceSlotsStub() as never);
  return (await service.listByCustomer("customer-1")) as unknown as {
    id: string;
    connection: Record<string, unknown>;
  }[];
}

/** `connection` as every backend before doors answered it. */
const BEFORE_DOORS = {
  host: "203.0.113.9",
  port: 2053,
  transport: "TCP",
  security: "TLS",
  publicParams: { serverName: "a.example.test" },
};

describe("the credential list carries each server's door", () => {
  it("as { host, port, pins, sni } inside `connection`, beside everything it had", async () => {
    const [user] = await list([credential("pu-1", "route-1", node(WITH_DOOR))]);

    expect(user.connection).toEqual({
      ...BEFORE_DOORS,
      door: { host: "203.0.113.9", port: 2053, pins: [PIN_B, PIN_A], sni: "static.example.com" },
    });
  });

  it("with the same door on every credential of one server, and each server's own", async () => {
    const alpha = node(WITH_DOOR);
    const beta = node({
      id: "node-2",
      name: "beta",
      publicIp: "203.0.113.10",
      doorPort: 2096,
      doorPin: PIN_A,
      doorVerifiedAt: minutesAgo(1),
    });
    const users = await list([
      credential("pu-1", "route-1", alpha),
      credential("pu-2", "route-2", alpha),
      credential("pu-3", "route-3", beta),
    ]);

    expect(users[0].connection.door).toEqual(users[1].connection.door);
    expect(users[2].connection.door).toEqual({ host: "203.0.113.10", port: 2096, pins: [PIN_A], sni: null });
  });

  it("answers exactly as before for a server with no door", async () => {
    const [user] = await list([credential("pu-1", "route-1", node())]);

    expect(user.connection).toEqual(BEFORE_DOORS);
    expect(user.connection).not.toHaveProperty("door");
  });

  it("leaves out a door whose last passing check is too old", async () => {
    const stale = node({ ...WITH_DOOR, doorVerifiedAt: new Date(Date.now() - DOOR_FRESH_MS - 60_000) });
    const [user] = await list([credential("pu-1", "route-1", stale)]);

    expect(user.connection).toEqual(BEFORE_DOORS);
  });

  it("leaves every door out while NODE_DOORS is off", async () => {
    process.env.NODE_DOORS = "off";
    const [user] = await list([credential("pu-1", "route-1", node(WITH_DOOR))]);

    expect(user.connection).toEqual(BEFORE_DOORS);
  });

  it("keeps the node's own row, and so its door columns, out of the answer", async () => {
    const [user] = await list([credential("pu-1", "route-1", node(WITH_DOOR))]);

    expect(user).not.toHaveProperty("node");
    expect(JSON.stringify(user)).not.toContain("doorPin");
    expect(JSON.stringify(user)).not.toContain("doorVerifiedAt");
  });
});
