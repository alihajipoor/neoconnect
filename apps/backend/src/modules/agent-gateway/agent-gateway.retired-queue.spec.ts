/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { Logger } from "@nestjs/common";
import { AgentGatewayService } from "./agent-gateway.service";

/** A retired (DISABLED) node's agent is stopped, so nothing it is queued
 * is delivered until it comes back -- and when it does, its Hello sends
 * every live credential and route again. What it must still be told is
 * every switch-off: nothing reconciles a node against the database.
 *
 * Postgres and the stream are stand-ins; no node has run this. */

interface Row {
  id: string;
  nodeId: string;
  type: string;
  payloadJson: Record<string, unknown>;
  status: string;
  createdAt: Date;
}

function build(status: string, opts: { connected?: boolean } = {}) {
  const rows: Row[] = [];
  const written: string[] = [];
  let seq = 0;
  const prisma = {
    node: { findUnique: jest.fn(async () => ({ status })) },
    agentCommand: {
      create: jest.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        // jsonb does not keep key order; neither does this stand-in.
        const reordered = Object.fromEntries(Object.entries(data.payloadJson).reverse());
        const row = { ...data, payloadJson: reordered, id: `cmd-${++seq}`, createdAt: new Date(seq) };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(
        async (args: {
          where: { nodeId: string; status: { in: string[] }; AND: { payloadJson: { path: string[]; equals: string } }[] };
        }) => {
          const match = rows.filter(
            (r) =>
              r.nodeId === args.where.nodeId &&
              args.where.status.in.includes(r.status) &&
              args.where.AND.every((c) => r.payloadJson[c.payloadJson.path[0]] === c.payloadJson.equals),
          );
          return match.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
        },
      ),
    },
  };
  const registry = {
    delete: () => undefined,
    get: () => (opts.connected ? { write: (m: { command: { type: string } }) => written.push(m.command.type) } : undefined),
  };
  const service = new AgentGatewayService(
    prisma as never,
    {} as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, rows, written, prisma };
}

const user = (name: string) => ({ protocol: "XRAY_VLESS_REALITY", transport: "TCP", externalUserId: `ext-${name}` });

beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("AgentGatewayService.enqueueCommand on a retired node", () => {
  it("stores no command that the re-assert after its Hello would send anyway", async () => {
    const { service, rows } = build("DISABLED");
    await service.enqueueCommand("node-1", "CREATE_USER", { ...user("a"), credentials: { uuid: "a" } });
    await service.enqueueCommand("node-1", "ENABLE_USER", user("a"));
    await service.enqueueCommand("node-1", "CONFIGURE_ROUTE", { routeId: "r-1" });
    expect(rows).toEqual([]);
  });

  it("still stores every first switch-off, and a route removal", async () => {
    const { service, rows } = build("DISABLED");
    await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    await service.enqueueCommand("node-1", "DELETE_USER", user("a"));
    await service.enqueueCommand("node-1", "DELETE_USER", user("b"));
    await service.enqueueCommand("node-1", "REMOVE_ROUTE", { routeId: "r-1" });
    await service.enqueueCommand("node-1", "UPDATE_USER", user("a"));
    expect(rows.map((r) => `${r.type} ${String(r.payloadJson.externalUserId ?? r.payloadJson.routeId)}`)).toEqual([
      "DISABLE_USER ext-a",
      "DELETE_USER ext-a",
      "DELETE_USER ext-b",
      "REMOVE_ROUTE r-1",
      "UPDATE_USER ext-a",
    ]);
  });

  it("stores a repeated identical switch-off once", async () => {
    const { service, rows } = build("DISABLED");
    for (let i = 0; i < 5; i++) await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    expect(rows).toHaveLength(1);
  });

  it("stores the off again when an older stored on for that credential is newer than its last off", async () => {
    const { service, rows } = build("DISABLED");
    await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    // A CREATE_USER stored before this change, still waiting in the queue.
    rows.push({
      id: "old",
      nodeId: "node-1",
      type: "CREATE_USER",
      payloadJson: user("a"),
      status: "QUEUED",
      createdAt: new Date(1000),
    });
    await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    expect(rows.map((r) => r.type)).toEqual(["DISABLE_USER", "CREATE_USER", "DISABLE_USER"]);
  });

  it("changes nothing for a node that is not retired", async () => {
    const { service, rows } = build("OFFLINE");
    await service.enqueueCommand("node-1", "CREATE_USER", user("a"));
    await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    await service.enqueueCommand("node-1", "DISABLE_USER", user("a"));
    await service.enqueueCommand("node-1", "CONFIGURE_ROUTE", { routeId: "r-1" });
    expect(rows.map((r) => r.type)).toEqual(["CREATE_USER", "DISABLE_USER", "DISABLE_USER", "CONFIGURE_ROUTE"]);
  });

  it("changes nothing, and reads no status, for a node with a live stream", async () => {
    const { service, rows, written, prisma } = build("DISABLED", { connected: true });
    await service.enqueueCommand("node-1", "CREATE_USER", user("a"));
    expect(rows).toHaveLength(1);
    expect(written).toEqual(["CREATE_USER"]);
    expect(prisma.node.findUnique).not.toHaveBeenCalled();
  });
});
