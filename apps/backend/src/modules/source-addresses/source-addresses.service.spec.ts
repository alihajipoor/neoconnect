import { MATCH_WINDOW_MS, MAX_PENDING, SEEN_SLACK_MS, SourceAddressesService } from "./source-addresses.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { NetworkIdentityService } from "../network-identity/network-identity.service";
import type { SessionCountMessage } from "../agent-gateway/agent-messages";

// 203.0.113.0/24 are our servers; 198.51.100.0/24 is a customer network
// on AS64500, 192.0.2.0/24 another on AS64501.
const SERVER = "203.0.113.5";
const AT = Date.UTC(2026, 9, 28, 12, 0, 0);

const RELAY_EXIT = "203.0.113.6";

/** A plain route (entry de-1 at SERVER), a relay route (entry ir-1, exit
 * tr-1 at RELAY_EXIT) and two WireGuard routes on de-1, with one
 * customer's credentials: a shared one and a device's on the plain route,
 * one on the relay route, two devices' on one WireGuard route and a
 * shared one on the other -- and someone else's. */
const build = () => {
  const routes: Record<string, { entry: string; entryIp: string; exitIp?: string }> = {
    "route-de": { entry: "de-1", entryIp: SERVER },
    "route-relay": { entry: "ir-1", entryIp: "203.0.113.7", exitIp: RELAY_EXIT },
    "route-wg": { entry: "de-1", entryIp: SERVER },
    "route-wg-old": { entry: "de-1", entryIp: SERVER },
  };
  const XRAY = "XRAY_VLESS_REALITY";
  const credentials = [
    { id: "pu-1", routeId: "route-de", customerId: "cust-1", externalUserId: "shared-1", nodeId: "de-1", protocol: XRAY, sessionId: null },
    { id: "pu-2", routeId: "route-de", customerId: "cust-1", externalUserId: "device-1", nodeId: "de-1", protocol: XRAY, sessionId: "phone" },
    { id: "pu-3", routeId: "route-relay", customerId: "cust-1", externalUserId: "relay-1", nodeId: "ir-1", protocol: XRAY, sessionId: null },
    { id: "pu-4", routeId: "route-de", customerId: "cust-2", externalUserId: "other-1", nodeId: "de-1", protocol: XRAY, sessionId: null },
    { id: "pu-5", routeId: "route-wg", customerId: "cust-1", externalUserId: "wg-phone", nodeId: "de-1", protocol: "WIREGUARD", sessionId: "phone" },
    { id: "pu-6", routeId: "route-wg", customerId: "cust-1", externalUserId: "wg-pc", nodeId: "de-1", protocol: "WIREGUARD", sessionId: "pc" },
    { id: "pu-7", routeId: "route-wg-old", customerId: "cust-1", externalUserId: "wg-shared", nodeId: "de-1", protocol: "WIREGUARD", sessionId: null },
  ];
  const findUnique = jest.fn(({ where }: { where: { id: string } }) => {
    const r = routes[where.id];
    return Promise.resolve(
      r
        ? {
            entryProtocolConfig: { nodeId: r.entry, node: { publicIp: r.entryIp } },
            exitProtocolConfig: r.exitIp ? { node: { publicIp: r.exitIp } } : null,
          }
        : null,
    );
  });
  const findMany = jest.fn(({ where }: { where: { routeId: string; subscription: { customerId: string } }; select: object }) =>
    Promise.resolve(
      credentials
        .filter((c) => c.routeId === where.routeId && c.customerId === where.subscription.customerId)
        .map(({ id, externalUserId, nodeId, protocol, sessionId }) => ({ id, externalUserId, nodeId, protocol, sessionId })),
    ),
  );
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const identity = {
    isOwnAddress: jest.fn((ip: string) => Promise.resolve(ip.startsWith("203.0.113."))),
    identify: jest.fn((ip: string) =>
      Promise.resolve(ip.startsWith("198.51.100.") ? { asn: 64500 } : ip.startsWith("192.0.2.") ? { asn: 64501 } : null),
    ),
  };
  const service = new SourceAddressesService(
    {
      route: { findUnique },
      protocolUser: { findMany },
      clientAttempt: { updateMany },
    } as unknown as PrismaService,
    identity as unknown as NetworkIdentityService,
  );
  jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

  /** A report stored at AT with the server's address, as the attempt log
   * hands it over. */
  const report = (over: Partial<Parameters<SourceAddressesService["expect"]>[0]> = {}) =>
    service.expect(
      {
        id: "row-1",
        createdAt: new Date(AT),
        occurredAt: new Date(AT - 2_000),
        ip: SERVER,
        asn: null,
        customerId: "cust-1",
        routeId: "route-de",
        ...over,
      },
      AT,
    );
  return { service, report, updateMany, findMany, identity };
};

const session = (externalUserId: string, ...sources: [string, number][]): SessionCountMessage => ({
  externalUserId,
  protocol: externalUserId.startsWith("wg-") ? "WIREGUARD" : "XRAY_VLESS_REALITY",
  distinctSources: sources.length,
  sources: sources.map(([address, secondsAgo]) => ({ address, secondsAgo })),
});

describe("SourceAddressesService", () => {
  it("writes the one address the customer's credential was seen from onto the row", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 2])], AT + 20_000);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0]).toEqual({
      // Only while the row still has the server's address: one the app's
      // own clientIp settled, or one the retention sweep erased, is not
      // replaced.
      where: { id: "row-1", ip: SERVER },
      data: { ip: "198.51.100.7", asn: 64500 },
    });
  });

  /** Every inbound of an Xray node reports the same user, so one device
   * arrives several times over. That is still one address. */
  it("counts an address seen on several counters, or credentials, once", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe(
      "de-1",
      [session("shared-1", ["198.51.100.7", 1]), session("shared-1", ["198.51.100.7", 3]), session("device-1", ["198.51.100.7", 0])],
      AT + 20_000,
    );
    expect(updateMany.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  it("settles a report once", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 2])], AT + 20_000);
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 2])], AT + 50_000);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  /** Two devices on the customer's credentials: which one sent the report
   * is not knowable, and a wrong address is worse than none. */
  it("writes nothing when two addresses were seen -- then or later", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe(
      "de-1",
      [session("shared-1", ["198.51.100.7", 1]), session("device-1", ["192.0.2.9", 4])],
      AT + 20_000,
    );
    // The second device has gone quiet. It may be the one that sent the
    // report, so the one left is still not the answer.
    await service.observe("de-1", [session("device-1", ["192.0.2.9", 1])], AT + 80_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** Its addresses may belong to the connection before this one. */
  it("ignores a batch that arrived before the report", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT - 1_000);
    expect(updateMany).not.toHaveBeenCalled();
    // And still waits for the next one.
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 30_000);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  /** The phone on wifi a minute ago is not the phone on mobile data that
   * just connected. */
  it("ignores an address last seen well before the report", async () => {
    const { service, report, updateMany } = build();
    await report();
    const stale = 30 + SEEN_SLACK_MS / 1000 + 1;
    await service.observe(
      "de-1",
      [session("device-1", ["192.0.2.9", stale], ["198.51.100.7", 3])],
      AT + 30_000,
    );
    expect(updateMany.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  it("drops our own servers' addresses before deciding", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["203.0.113.9", 0], ["198.51.100.7", 1])], AT + 20_000);
    expect(updateMany.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  it("writes nothing when only our own servers were seen", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["203.0.113.9", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** On a relay route the report leaves from the exit, which only ever
   * sees the relay; the customer dialled the relay. */
  it("matches a relay route on its entry node, not the exit it reported from", async () => {
    const { service, report, updateMany } = build();
    await report({ routeId: "route-relay", ip: RELAY_EXIT });
    await service.observe("tr-1", [session("relay-1", ["198.51.100.7", 0])], AT + 10_000);
    expect(updateMany).not.toHaveBeenCalled();
    await service.observe("ir-1", [session("relay-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  it("looks only at this customer's credentials on this route", async () => {
    const { service, report, updateMany, findMany } = build();
    await report();
    // Another customer on the same node, and this customer on another
    // route that happens to share a node id: neither is evidence.
    await service.observe("de-1", [session("other-1", ["192.0.2.9", 0]), session("relay-1", ["192.0.2.10", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
    // Named columns only: these rows carry the credentials themselves.
    expect(findMany.mock.calls[0][0].select).toEqual({
      id: true,
      externalUserId: true,
      nodeId: true,
      protocol: true,
      sessionId: true,
    });
  });

  /** Queued by the app and flushed through a later tunnel: the node sees
   * where the customer is now, not where they were. */
  it("does not wait on a report that arrived late", async () => {
    const { service, report, updateMany } = build();
    await report({ occurredAt: new Date(AT - 5 * 60_000) });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** Sent over some other connection: the device need not be on the route
   * it names at all. */
  it("does not wait on a report that came through a server not on its route", async () => {
    const { service, report, updateMany } = build();
    await report({ ip: "203.0.113.99" });
    await report({ id: "row-2", routeId: "route-relay", ip: SERVER });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    await service.observe("ir-1", [session("relay-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** A WireGuard address's age is its last handshake, renewed about every
   * two minutes: the phone that reported can look older than the PC that
   * did not. Both are connected, so both count. */
  it("on WireGuard, counts every connected device whatever its handshake age", async () => {
    const { service, report, updateMany } = build();
    await report({ routeId: "route-wg" });
    await service.observe(
      "de-1",
      [session("wg-phone", ["198.51.100.7", 90]), session("wg-pc", ["192.0.2.9", 5])],
      AT + 20_000,
    );
    // Settled as not known, so a later batch with the PC alone does not
    // put the PC's address on the phone's report.
    await service.observe("de-1", [session("wg-pc", ["192.0.2.9", 1])], AT + 50_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("on WireGuard, takes one device's address however old its handshake", async () => {
    const { service, report, updateMany } = build();
    await report({ routeId: "route-wg" });
    await service.observe("de-1", [session("wg-phone", ["198.51.100.7", 150])], AT + 20_000);
    expect(updateMany.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  /** One key, one endpoint: a second device on it pushes the first out, so
   * the one address shown may not be the one that reported. */
  it("never matches through a shared credential that shows one device at a time", async () => {
    const { service, report, updateMany } = build();
    await report({ routeId: "route-wg-old" });
    await service.observe("de-1", [session("wg-shared", ["192.0.2.9", 0])], AT + 20_000);
    await service.observe("de-1", [session("wg-shared", ["192.0.2.9", 0])], AT + 50_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** Every agent before SessionCount.sources: a count and nothing else. */
  it("does nothing with a batch from an agent that sends no addresses", async () => {
    const { service, report, updateMany } = build();
    await report();
    const old = { externalUserId: "device-1", protocol: "XRAY_VLESS_REALITY", distinctSources: 1 };
    await service.observe("de-1", [old], AT + 20_000);
    await service.observe("de-1", [{ ...old, sources: [] }], AT + 50_000);
    await service.observe("de-1", undefined, AT + 80_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("gives up when the window closes, leaving the row as it was", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + MATCH_WINDOW_MS + 1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("skips anything in the list that is not an address", async () => {
    const { service, report, updateMany } = build();
    await report();
    await service.observe(
      "de-1",
      [session("device-1", ["198.51.100.7:51820", 0], ["customer.example", 0], ["", 0])],
      AT + 20_000,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** The attestation was read before the tunnel came up; it stays. */
  it("fills in the network only where the row had none", async () => {
    const { service, report, updateMany } = build();
    await report({ asn: 64501 });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany.mock.calls[0][0].data).toEqual({ ip: "198.51.100.7" });
  });

  it("does not wait on a row whose address is not one of ours", async () => {
    const { service, report, updateMany } = build();
    await report({ ip: "198.51.100.8" });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not wait on a route that is gone, or one with no credential of theirs", async () => {
    const { service, report, updateMany } = build();
    await report({ routeId: "route-gone" });
    await report({ id: "row-2", customerId: "cust-3" });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /** Memory only, and bounded: the oldest go first. */
  it("holds at most MAX_PENDING reports", async () => {
    const { service, report, updateMany } = build();
    for (let i = 0; i <= MAX_PENDING; i++) await report({ id: `row-${i}` });
    await service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000);
    const written = updateMany.mock.calls.map((c) => c[0].where.id);
    expect(written).toHaveLength(MAX_PENDING);
    expect(written).not.toContain("row-0");
    expect(written).toContain(`row-${MAX_PENDING}`);
  });

  /** It runs inside the agent's stream handler, where a throw closes the
   * node's control stream. */
  it("never throws out of observe", async () => {
    const { service, report, updateMany, identity } = build();
    await report();
    updateMany.mockRejectedValueOnce(new Error("database is on fire"));
    await expect(service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 20_000)).resolves.toBeUndefined();

    await report({ id: "row-2" });
    identity.isOwnAddress.mockRejectedValueOnce(new Error("unexpected"));
    await expect(service.observe("de-1", [session("device-1", ["198.51.100.7", 0])], AT + 30_000)).resolves.toBeUndefined();

    const malformed = [{ externalUserId: "device-1", protocol: "X", distinctSources: 1, sources: [null, { address: 7 }] }];
    await expect(service.observe("de-1", malformed as never, AT + 40_000)).resolves.toBeUndefined();
  });

  /** And it runs inside the attempt log's "never throws to the caller". */
  it("never throws out of expect", async () => {
    const { report, findMany } = build();
    findMany.mockRejectedValueOnce(new Error("database is on fire"));
    await expect(report()).resolves.toBeUndefined();
  });
});
