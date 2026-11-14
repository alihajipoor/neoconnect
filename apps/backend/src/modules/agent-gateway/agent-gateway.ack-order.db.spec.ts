import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { AgentGatewayService } from "./agent-gateway.service";

/** The ack-order fix against a migrated Postgres rather than the in-memory
 * stand-in of agent-gateway.ack-order.spec.ts: markSent's conditional
 * update, replay's ackedAt filter, and the startup correction's relation
 * filter and `id in` update, as Prisma actually sends them.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * `prisma migrate deploy`. Documentation addresses and made-up names. */
const enabled = process.env.NEOXIFY_DB_SPECS === "1" && !!process.env.DATABASE_URL;
const describeDb = enabled ? describe : describe.skip;

describeDb("Agent command status order, against Postgres", () => {
  const prisma = new PrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ids = { live: "", retired: "" };
  /** Settled before a SENT write reaches the database: lets a test have
   * the ack commit first, the order that went wrong in production. */
  let beforeSent: (() => Promise<void>) | null = null;
  const agentCommand = new Proxy(prisma.agentCommand, {
    get(target, key, receiver) {
      if (key !== "updateMany") return Reflect.get(target, key, receiver);
      return async (args: { data: { status?: string } }) => {
        if (args.data.status === "SENT" && beforeSent) {
          const run = beforeSent;
          beforeSent = null;
          await run();
        }
        return target.updateMany(args as never);
      };
    },
  });
  const db = new Proxy(prisma, {
    get: (target, key, receiver) => (key === "agentCommand" ? agentCommand : Reflect.get(target, key, receiver)),
  });

  function build() {
    const written: string[] = [];
    let onWrite: ((id: string) => void) | null = null;
    const call = {
      write: (msg: { command: { id: string } }) => {
        written.push(msg.command.id);
        onWrite?.(msg.command.id);
      },
    };
    const registry = { get: (nodeId: string) => (nodeId === ids.live ? call : undefined) };
    const service = new AgentGatewayService(db as never, {} as never, registry as never, {} as never, {} as never, {} as never, {} as never);
    for (const level of ["log", "warn", "error"] as const) jest.spyOn(service["logger"], level).mockImplementation(() => undefined);
    const internals = service as unknown as {
      handleCommandAck(n: string, a: { commandId: string; success: boolean; error: string }): Promise<void>;
      replayQueuedCommands(n: string): Promise<void>;
      correctAckedButUnfinished(): Promise<void>;
    };
    return {
      service,
      internals,
      written,
      ackBeforeSentIsStored: () => {
        onWrite = (id) => {
          beforeSent = () => internals.handleCommandAck(ids.live, { commandId: id, success: true, error: "" });
        };
      },
    };
  }

  const create = (ext: string) => ({
    protocol: "XRAY_VLESS_REALITY",
    transport: "TCP",
    externalUserId: `${tag}-${ext}`,
    credentials: { uuid: `uuid-${ext}` },
  });
  const status = async (id: string) =>
    (await prisma.agentCommand.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  beforeAll(async () => {
    ids.live = (await prisma.node.create({ data: { name: `ack-${tag}`, region: "test", publicIp: "192.0.2.71", status: "ONLINE" } })).id;
    ids.retired = (
      await prisma.node.create({ data: { name: `ack-${tag}-r`, region: "test", publicIp: "192.0.2.72", status: "DISABLED" } })
    ).id;
  });

  afterAll(async () => {
    await prisma.agentCommand.deleteMany({ where: { nodeId: { in: [ids.live, ids.retired] } } });
    await prisma.node.deleteMany({ where: { id: { in: [ids.live, ids.retired] } } });
    await prisma.$disconnect();
  });

  it("keeps a command ACKED, credential stripped, when its ack commits before SENT is recorded", async () => {
    const t = build();
    t.ackBeforeSentIsStored();

    const cmd = await t.service.enqueueCommand(ids.live, "CREATE_USER", create("first"));

    const row = await prisma.agentCommand.findUniqueOrThrow({
      where: { id: cmd!.id },
      select: { status: true, ackedAt: true, sentAt: true },
    });
    expect(row.status).toBe("ACKED");
    expect(row.ackedAt).not.toBeNull();
    expect(row.sentAt).toBeNull();
    const [{ has }] = await prisma.$queryRaw<{ has: boolean }[]>`
      SELECT ("payloadJson" ? 'credentials') AS has FROM agent_commands WHERE id = ${cmd!.id}`;
    expect(has).toBe(false);
  });

  it("does not replay an acked row left SENT, and the startup correction settles it once", async () => {
    const seed = (nodeId: string, status: "QUEUED" | "SENT", ackedAt: Date | null, error: string | null) =>
      prisma.agentCommand.create({
        data: {
          nodeId,
          type: "CREATE_USER",
          payloadJson: { protocol: "XRAY_TROJAN", externalUserId: `${tag}-${randomUUID().slice(0, 6)}` },
          status,
          sentAt: new Date(),
          ackedAt,
          error,
        },
        select: { id: true },
      });
    const ok = await seed(ids.live, "SENT", new Date(), null);
    const nacked = await seed(ids.live, "SENT", new Date(), "trojan credentials missing password");
    const retiredStuck = await seed(ids.retired, "SENT", new Date(), null);
    const t = build();

    await t.internals.replayQueuedCommands(ids.live);
    expect(t.written).not.toContain(ok.id);
    expect(t.written).not.toContain(nacked.id);

    await t.internals.correctAckedButUnfinished();
    expect(await status(ok.id)).toBe("ACKED");
    expect(await status(nacked.id)).toBe("FAILED");
    expect(await status(retiredStuck.id)).toBe("SENT");

    // A second start finds nothing of ours to change.
    await t.internals.correctAckedButUnfinished();
    expect(await status(ok.id)).toBe("ACKED");
    expect(await status(nacked.id)).toBe("FAILED");
  });
});
