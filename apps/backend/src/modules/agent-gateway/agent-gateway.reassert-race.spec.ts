/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { Logger } from "@nestjs/common";
import { AgentGatewayService } from "./agent-gateway.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";

/** A re-assert reads a batch of live credentials, then sends CREATE_USER
 * for each. A sign-out landing in between sends DELETE_USER and deletes
 * the row -- and the loop then sent CREATE_USER for the same credential.
 * The node runs the delete and then the create, and the signed-out
 * device's credential stays live there with no row behind it, for good:
 * nothing reconciles a node against the database.
 *
 * What is asserted is the order of commands on the node's stream, which
 * is the order the node executes them in. The stream and Postgres are
 * stand-ins; no node has run this. */

interface Wire {
  type: string;
  externalUserId: string;
}

function build(users: string[]) {
  const wire: Wire[] = [];
  const rows = users.map((name, i) => ({
    id: `pu-${String(i).padStart(3, "0")}`,
    nodeId: "node-1",
    protocol: "XRAY_VLESS_REALITY",
    externalUserId: `ext-${name}`,
    status: "ACTIVE",
    provisionedAt: new Date(0),
    credentialsJson: encryptCredentials({ uuid: name }),
    protocolConfig: { transport: "TCP", inboundTag: null },
  }));
  /** Runs once, while the next stored command is being written -- i.e. in
   * the middle of a reconnect re-assert's await. */
  let duringNextStore: (() => Promise<void>) | null = null;
  /** Runs once, while the next read is in flight. */
  let duringNextRead: (() => Promise<void>) | null = null;

  let seq = 0;
  const prisma = {
    protocolUser: {
      findMany: jest.fn(async (args: { where?: { id?: { gt?: string; in?: string[] } }; take?: number }) => {
        // The snapshot the read sees is taken when it starts; whatever
        // happens while it is in flight is not in it.
        const gt = args.where?.id?.gt;
        const only = args.where?.id?.in;
        const remaining = rows.filter((r) => (gt === undefined || r.id > gt) && (only === undefined || only.includes(r.id)));
        if (duringNextRead) {
          const run = duringNextRead;
          duringNextRead = null;
          await run();
        }
        return args.take === undefined ? remaining : remaining.slice(0, args.take);
      }),
    },
    agentCommand: {
      create: jest.fn(async () => {
        if (duringNextStore) {
          const run = duringNextStore;
          duringNextStore = null;
          await run();
        }
        return { id: `cmd-${++seq}` };
      }),
      update: jest.fn(async () => ({})),
    },
  };
  const registry = {
    delete: () => undefined,
    get: () => ({
      write: (msg: { command: { type: string; payloadJson: Buffer } }) => {
        const payload = JSON.parse(msg.command.payloadJson.toString("utf8")) as { externalUserId: string };
        wire.push({ type: msg.command.type, externalUserId: payload.externalUserId });
      },
    }),
  };
  const service = new AgentGatewayService(
    prisma as never,
    {} as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
  );
  /** What ProtocolUsersService.remove does: DELETE_USER first, then the
   * row goes. */
  const signOut = async (name: string) => {
    await service.enqueueCommand("node-1", "DELETE_USER", { protocol: "XRAY_VLESS_REALITY", externalUserId: `ext-${name}` });
    rows.splice(
      rows.findIndex((r) => r.externalUserId === `ext-${name}`),
      1,
    );
  };
  const reassert = (persist: boolean) =>
    (
      service as unknown as { reassertProvisionedUsers(id: string, o: { persist: boolean }): Promise<void> }
    ).reassertProvisionedUsers("node-1", { persist });
  return {
    service,
    wire,
    signOut,
    reassert,
    whileStoring: (run: () => Promise<void>) => {
      duringNextStore = run;
    },
    whileReading: (run: () => Promise<void>) => {
      duringNextRead = run;
    },
  };
}

/** The commands the node ends up with for one credential, in order. */
const forUser = (wire: Wire[], name: string) => wire.filter((w) => w.externalUserId === `ext-${name}`).map((w) => w.type);

describe("AgentGatewayService re-assert against a concurrent switch-off", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // On reconnect each row's command is stored before it is sent, so the
  // batch takes a while -- long enough for a sign-out to land in it.
  it("does not re-create on reconnect a credential signed out after the batch was read", async () => {
    const { wire, signOut, reassert, whileStoring } = build(["a", "b"]);
    whileStoring(() => signOut("b"));

    await reassert(true);

    expect(forUser(wire, "a")).toEqual(["CREATE_USER"]);
    expect(forUser(wire, "b")).toEqual(["DELETE_USER"]);
  });

  // The sign-out lands while this credential's own CREATE_USER is being
  // stored: the node gets the delete, then the create. The delete is sent
  // again after it.
  it("switches a credential off again when the switch-off lands while its create is on the way", async () => {
    const { wire, signOut, reassert, whileStoring } = build(["b"]);
    whileStoring(() => signOut("b"));

    await reassert(true);

    expect(forUser(wire, "b")).toEqual(["DELETE_USER", "CREATE_USER", "DELETE_USER"]);
  });

  it("does not re-create on the periodic re-assert a credential signed out while the batch was being read", async () => {
    const { wire, signOut, reassert, whileReading } = build(["a", "b"]);
    whileReading(() => signOut("b"));

    await reassert(false);

    expect(forUser(wire, "b")).toEqual(["DELETE_USER"]);
    expect(forUser(wire, "a")).toEqual(["CREATE_USER"]);
  });

  // A hold lapsing is how a held device comes back: that must keep
  // working. Its DISABLE_USER is a lease (90 s) old by then.
  it("re-asserts a credential switched off long before the batch was read", async () => {
    const { service, wire, reassert } = build(["a"]);
    await service.enqueueCommand("node-1", "DISABLE_USER", { protocol: "XRAY_VLESS_REALITY", externalUserId: "ext-a" });
    jest.setSystemTime(Date.now() + 120_000);

    await reassert(false);

    expect(forUser(wire, "a")).toEqual(["DISABLE_USER", "CREATE_USER"]);
  });

  // A credential switched back on after a switch-off is not held back.
  it("re-asserts a credential whose last command switched it back on", async () => {
    const { service, wire, reassert } = build(["a"]);
    await service.enqueueCommand("node-1", "DISABLE_USER", { protocol: "XRAY_VLESS_REALITY", externalUserId: "ext-a" });
    await service.enqueueCommand("node-1", "ENABLE_USER", { protocol: "XRAY_VLESS_REALITY", externalUserId: "ext-a" });

    await reassert(false);

    expect(forUser(wire, "a")).toEqual(["DISABLE_USER", "ENABLE_USER", "CREATE_USER"]);
  });

  /** The agent runs every command of every protocol in one loop, and an
   * IKEv2 re-assert reloads every secret per user. A node whose re-assert
   * takes longer than the 60 s cycle never catches up if each cycle adds
   * a full copy -- and sign-outs and quota cuts queue behind all of it.
   * One copy per credential at a time, and say so. */
  it("does not queue a second periodic re-assert behind one the node has not carried out, and says the node is behind", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { service, wire, reassert } = build(["a", "b"]);
    const ack = (commandId: string) =>
      (service as unknown as { handleCommandAck(n: string, a: object): Promise<void> }).handleCommandAck("node-1", {
        commandId,
        success: true,
        error: "",
      });

    await reassert(false);
    await ack("reassert:pu-000");
    await reassert(false);

    expect(forUser(wire, "a")).toEqual(["CREATE_USER", "CREATE_USER"]);
    expect(forUser(wire, "b")).toEqual(["CREATE_USER"]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("has not carried out 1 re-assert"))).toHaveLength(1);

    // An ack lost without the stream closing does not stop it for good.
    jest.setSystemTime(Date.now() + 11 * 60_000);
    await reassert(false);
    expect(forUser(wire, "b")).toEqual(["CREATE_USER", "CREATE_USER"]);
    jest.restoreAllMocks();
  });

  it("forgets what was in flight on a stream that closed", async () => {
    const { service, wire, reassert } = build(["a"]);

    await reassert(false);
    (service as unknown as { handleStreamClosed(n: string, c: unknown): void }).handleStreamClosed("node-1", {});
    await reassert(false);

    expect(forUser(wire, "a")).toEqual(["CREATE_USER", "CREATE_USER"]);
  });

  // A hold lifted because its device was let in: the hold's own
  // DISABLE_USER seconds ago must not stop the device coming back.
  it("puts a lifted hold back at once, though its switch-off was seconds ago", async () => {
    const { service, wire } = build(["a"]);
    await service.enqueueCommand("node-1", "DISABLE_USER", { protocol: "XRAY_VLESS_REALITY", externalUserId: "ext-a" });

    await service.reassertCredentials(["pu-000"]);

    expect(forUser(wire, "a")).toEqual(["DISABLE_USER", "CREATE_USER"]);
  });
});
