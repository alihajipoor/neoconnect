import { AgentGatewayService, lostItsCredentials } from "./agent-gateway.service";

/** A command's status only ever moves forward.
 *
 * The gateway writes a command onto the node's stream and then records it
 * as SENT. A fast node acks before that record is stored, and the old
 * unconditional update then put the ACKED row back to SENT -- with its
 * credentials already stripped by the ack -- so the next reconnect
 * replayed a CREATE_USER without its credential. 3 of 7,115 commands
 * after the 2026-11-14 deploy's reconnect burst. */

type Row = {
  id: string;
  nodeId: string;
  type: string;
  payloadJson: Record<string, unknown>;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
  error: string | null;
};

type Where = {
  id?: string | { in: string[] };
  nodeId?: string;
  status?: { in: string[] };
  ackedAt?: null | { not: null };
  node?: { status: { not: string } };
};

/** An agent_commands table, with the where clauses the gateway uses. */
function store(nodeStatus: Record<string, string> = {}) {
  const rows: Row[] = [];
  let seq = 0;
  /** Runs before a write that sets SENT is applied: what lets a test
   * have the ack land first. */
  let beforeSent: (() => Promise<void>) | null = null;

  const matches = (r: Row, w: Where) =>
    (w.id === undefined || (typeof w.id === "string" ? r.id === w.id : w.id.in.includes(r.id))) &&
    (w.nodeId === undefined || r.nodeId === w.nodeId) &&
    (w.status === undefined || w.status.in.includes(r.status)) &&
    (w.ackedAt === undefined || (w.ackedAt === null ? r.ackedAt === null : r.ackedAt !== null)) &&
    (w.node === undefined || (nodeStatus[r.nodeId] ?? "ONLINE") !== w.node.status.not);

  const apply = async (targets: Row[], data: Partial<Row>) => {
    if (data.status === "SENT" && beforeSent) {
      const run = beforeSent;
      beforeSent = null;
      await run();
    }
    for (const r of targets) Object.assign(r, data);
  };

  const agentCommand = {
    create: jest.fn(({ data }: { data: Pick<Row, "nodeId" | "type" | "payloadJson" | "status"> }) => {
      const row: Row = { ...data, id: `cmd-${++seq}`, createdAt: new Date(seq), sentAt: null, ackedAt: null, error: null };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    findFirst: jest.fn(({ where }: { where: Where }) => {
      const r = rows.find((x) => matches(x, where));
      return Promise.resolve(r ? { ...r } : null);
    }),
    findMany: jest.fn(({ where, take }: { where: Where; take?: number }) => {
      const found = rows.filter((x) => matches(x, where)).map((x) => ({ ...x }));
      return Promise.resolve(take === undefined ? found : found.slice(0, take));
    }),
    // What the old code used: unconditional, and throws on a missing row.
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const targets = rows.filter((x) => x.id === where.id);
      if (targets.length === 0) throw new Error("no row");
      // Snapshot first, as a statement does; the write lands after.
      await apply(targets, data);
      return { ...targets[0] };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      if (data.status === "SENT" && beforeSent) {
        // The conditional update is one statement: the ack either committed
        // before it (and the where no longer matches) or after.
        const run = beforeSent;
        beforeSent = null;
        await run();
      }
      const targets = rows.filter((x) => matches(x, where));
      for (const r of targets) Object.assign(r, data);
      return { count: targets.length };
    }),
  };

  return {
    rows,
    agentCommand,
    holdNextSent: (run: () => Promise<void>) => {
      beforeSent = run;
    },
  };
}

function build(opts: { nodeStatus?: Record<string, string>; connected?: boolean } = {}) {
  const db = store(opts.nodeStatus);
  const written: { id: string; type: string; payload: Record<string, unknown> }[] = [];
  let onWrite: ((cmd: { id: string; type: string }) => void) | null = null;
  const call = {
    write: (msg: { command: { id: string; type: string; payloadJson: Buffer } }) => {
      written.push({ id: msg.command.id, type: msg.command.type, payload: JSON.parse(msg.command.payloadJson.toString("utf8")) });
      onWrite?.(msg.command);
    },
  };
  const prisma = {
    agentCommand: db.agentCommand,
    protocolUser: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    node: { findUnique: jest.fn(() => Promise.resolve({ status: "ONLINE" })) },
  };
  const registry = { get: () => (opts.connected === false ? undefined : call) };
  const service = new AgentGatewayService(prisma as never, {} as never, registry as never, {} as never, {} as never, {} as never, {} as never);
  const logged: string[] = [];
  jest.spyOn(service["logger"], "log").mockImplementation((m: string) => void logged.push(m));
  jest.spyOn(service["logger"], "warn").mockImplementation((m: string) => void logged.push(m));
  jest.spyOn(service["logger"], "error").mockImplementation((m: string) => void logged.push(m));
  const internals = service as unknown as {
    handleCommandAck(n: string, a: { commandId: string; success: boolean; error: string }): Promise<void>;
    replayQueuedCommands(n: string): Promise<void>;
    correctAckedButUnfinished(): Promise<void>;
    buildCredentials(): never;
  };
  return {
    service,
    internals,
    db,
    written,
    logged,
    /** The node answers each command the moment it is written, and that
     * answer is stored before the gateway records the command as sent. */
    ackBeforeSentIsStored: (success = true) => {
      onWrite = (cmd) => {
        db.holdNextSent(() => internals.handleCommandAck("node-1", { commandId: cmd.id, success, error: success ? "" : "boom" }));
      };
    },
  };
}

const create = (ext: string) => ({
  protocol: "XRAY_VLESS_REALITY",
  transport: "TCP",
  externalUserId: ext,
  credentials: { uuid: `uuid-${ext}` },
});

describe("AgentGatewayService never moves a command's status backwards", () => {
  it("keeps a command ACKED when its ack is stored before it is recorded as sent", async () => {
    const t = build();
    t.ackBeforeSentIsStored();

    await t.service.enqueueCommand("node-1", "CREATE_USER", create("ext-1"));

    const [row] = t.db.rows;
    expect(row.status).toBe("ACKED");
    expect(row.ackedAt).not.toBeNull();
    // And the ack's strip of the credential stands.
    expect(row.payloadJson).not.toHaveProperty("credentials");
  });

  it("keeps a command FAILED in the same order", async () => {
    const t = build();
    t.ackBeforeSentIsStored(false);

    await t.service.enqueueCommand("node-1", "CREATE_USER", create("ext-1"));

    expect(t.db.rows[0].status).toBe("FAILED");
    expect(t.db.rows[0].error).toBe("boom");
  });

  it("keeps a replayed command ACKED in the same order", async () => {
    const t = build();
    const queued = await t.service.enqueueCommand("node-1", "DELETE_USER", { protocol: "WIREGUARD", externalUserId: "ext-1" });
    // Queued while the node was away: still QUEUED, never written.
    t.db.rows[0].status = "QUEUED";
    t.written.length = 0;
    t.ackBeforeSentIsStored();

    await t.internals.replayQueuedCommands("node-1");

    expect(t.written.map((w) => w.id)).toEqual([queued!.id]);
    expect(t.db.rows[0].status).toBe("ACKED");
  });

  it("still records SENT when the ack comes after", async () => {
    const t = build();

    await t.service.enqueueCommand("node-1", "CREATE_USER", create("ext-1"));
    expect(t.db.rows[0].status).toBe("SENT");
    expect(t.db.rows[0].sentAt).not.toBeNull();

    await t.internals.handleCommandAck("node-1", { commandId: t.db.rows[0].id, success: true, error: "" });
    expect(t.db.rows[0].status).toBe("ACKED");
  });

  it("does not record a command as sent that was never written", async () => {
    const t = build({ connected: false });

    await t.service.enqueueCommand("node-1", "DELETE_USER", { protocol: "WIREGUARD", externalUserId: "ext-1" });

    expect(t.db.rows[0].status).toBe("QUEUED");
  });
});

describe("AgentGatewayService replays only what a node has not answered", () => {
  function stuck(t: ReturnType<typeof build>) {
    // What the old order left: acked, stripped, and SENT.
    t.db.rows.push({
      id: "stuck",
      nodeId: "node-1",
      type: "CREATE_USER",
      payloadJson: { protocol: "OPENVPN", externalUserId: "ext-revoked" },
      status: "SENT",
      createdAt: new Date(0),
      sentAt: new Date(2),
      ackedAt: new Date(1),
      error: null,
    });
  }

  it("never sends again a command the node acked, whatever its status says", async () => {
    const t = build();
    stuck(t);

    await t.internals.replayQueuedCommands("node-1");

    expect(t.written).toEqual([]);
    expect(t.db.rows[0].status).toBe("SENT");
  });

  it("never sends a user command whose stored payload has lost its credential, and closes it as FAILED", async () => {
    const t = build();
    t.db.rows.push({
      id: "bare",
      nodeId: "node-1",
      type: "CREATE_USER",
      payloadJson: { protocol: "OPENVPN", externalUserId: "ext-1" },
      status: "QUEUED",
      createdAt: new Date(0),
      sentAt: null,
      ackedAt: null,
      error: null,
    });
    const del = await t.service.enqueueCommand("node-1", "DELETE_USER", { protocol: "WIREGUARD", externalUserId: "ext-2" });
    t.db.rows[1].status = "QUEUED";
    t.written.length = 0;

    await t.internals.replayQueuedCommands("node-1");

    expect(t.written.map((w) => w.id)).toEqual([del!.id]);
    expect(t.db.rows[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("no longer carries the credential") });
    expect(t.db.rows[1].status).toBe("SENT");
    expect(t.logged.some((m) => m.includes("Not replaying CREATE_USER bare"))).toBe(true);
  });

  it("still replays an unanswered CREATE_USER that carries its credential", async () => {
    const t = build();
    t.db.rows.push({
      id: "queued",
      nodeId: "node-1",
      type: "CREATE_USER",
      payloadJson: create("ext-1"),
      status: "QUEUED",
      createdAt: new Date(0),
      sentAt: null,
      ackedAt: null,
      error: null,
    });

    await t.internals.replayQueuedCommands("node-1");

    expect(t.written).toHaveLength(1);
    expect(t.written[0].payload).toHaveProperty("credentials");
    expect(t.db.rows[0].status).toBe("SENT");
  });
});

describe("lostItsCredentials", () => {
  it("is true only for user commands without a credential", () => {
    expect(lostItsCredentials("CREATE_USER", { externalUserId: "x" })).toBe(true);
    expect(lostItsCredentials("ENABLE_USER", { externalUserId: "x", credentials: {} })).toBe(true);
    expect(lostItsCredentials("CREATE_USER", { credentials: { uuid: "u" } })).toBe(false);
    expect(lostItsCredentials("DELETE_USER", { externalUserId: "x" })).toBe(false);
    expect(lostItsCredentials("CONFIGURE_ROUTE", { routeId: "r" })).toBe(false);
  });
});

describe("AgentGatewayService corrects, at startup, commands left SENT after their ack", () => {
  const row = (id: string, nodeId: string, status: string, ackedAt: Date | null, error: string | null): Row => ({
    id,
    nodeId,
    type: "CREATE_USER",
    payloadJson: { protocol: "XRAY_TROJAN", externalUserId: id },
    status,
    createdAt: new Date(0),
    sentAt: new Date(2),
    ackedAt,
    error,
  });

  function seeded() {
    const t = build({ nodeStatus: { retired: "DISABLED" } });
    t.db.rows.push(
      row("ok", "node-1", "SENT", new Date(1), null),
      row("nacked", "node-1", "SENT", new Date(1), "trojan credentials missing password"),
      row("waiting", "node-1", "SENT", null, null),
      row("old-queued", "retired", "QUEUED", null, null),
      row("retired-stuck", "retired", "SENT", new Date(1), null),
      row("done", "node-1", "ACKED", new Date(1), null),
    );
    return t;
  }
  const statuses = (t: ReturnType<typeof build>) => Object.fromEntries(t.db.rows.map((r) => [r.id, r.status]));

  it("restores each to the outcome its ack recorded, touching nothing else", async () => {
    const t = seeded();

    await t.internals.correctAckedButUnfinished();

    expect(statuses(t)).toEqual({
      ok: "ACKED",
      nacked: "FAILED",
      waiting: "SENT",
      "old-queued": "QUEUED",
      "retired-stuck": "SENT",
      done: "ACKED",
    });
    expect(t.logged).toContain(
      "Corrected 2 command(s) their node had acked but still recorded as unfinished (1 to ACKED, 1 to FAILED)",
    );
  });

  it("is idempotent and silent when there is nothing to correct", async () => {
    const t = seeded();
    await t.internals.correctAckedButUnfinished();
    t.logged.length = 0;

    await t.internals.correctAckedButUnfinished();

    expect(t.logged).toEqual([]);
  });

  it("runs at module start before the gateway can accept a stream, and never stops it starting", async () => {
    const t = seeded();
    const order: string[] = [];
    const findMany = t.db.agentCommand.findMany;
    t.db.agentCommand.findMany = jest.fn(async (args) => {
      order.push("correct");
      return findMany(args);
    });
    // Stops onModuleInit at its first step after the correction.
    jest.spyOn(t.internals, "buildCredentials").mockImplementation(() => {
      order.push("server");
      throw new Error("no certs in this test");
    });

    await t.service.onModuleInit();
    expect(order).toEqual(["correct", "server"]);
    expect(statuses(t).ok).toBe("ACKED");

    // A database that cannot answer costs the correction, not the gateway.
    const broken = seeded();
    broken.db.agentCommand.findMany = jest.fn((args: { where: Where; take?: number }) =>
      Promise.reject(new Error(`db down (${Object.keys(args.where).length} conditions)`)),
    );
    const serverStarts = jest.spyOn(broken.internals, "buildCredentials").mockImplementation(() => {
      throw new Error("no certs in this test");
    });
    await expect(broken.service.onModuleInit()).resolves.toBeUndefined();
    expect(serverStarts).toHaveBeenCalled();
  });
});
