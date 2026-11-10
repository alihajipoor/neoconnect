import { Logger } from "@nestjs/common";
import { NodesService } from "../nodes/nodes.service";
import { DOOR_FRESH_MS } from "./door";
import type { DoorProbe, DoorTarget } from "./door-prober";
import { NodeDoorsService } from "./node-doors.service";

/** The learner over a fake database and a fake network: what it asks of
 * each node, what it writes, and what it says. The network's own rules
 * are door-prober.spec.ts. */

const PIN_A = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PIN_B = "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";
const NOW = new Date("2026-11-10T12:00:00Z");
const now = () => NOW;

const KNOBS = ["NODE_DOORS", "NODE_DOOR_PORTS", "NODE_DOOR_SNI", "NODE_DOOR_DOMAINS"] as const;
const saved = Object.fromEntries(KNOBS.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of KNOBS) delete process.env[name];
  process.env.NODE_DOOR_SNI = "static.example.com";
});
afterAll(() => {
  for (const name of KNOBS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});
afterEach(() => jest.restoreAllMocks());

type Row = Record<string, unknown> & { id: string; name: string; publicIp: string };

const node = (over: Partial<Row> = {}): Row => ({
  id: "n1",
  name: "alpha",
  publicIp: "203.0.113.9",
  mirrorHost: null,
  doorPort: null,
  doorSni: null,
  doorPin: null,
  doorPreviousPin: null,
  doorPinChangedAt: null,
  doorVerifiedAt: null,
  protocolConfigs: [
    {
      protocol: "XRAY_VLESS_TLS",
      listenPort: 2053,
      security: "TLS",
      publicParamsJson: { serverName: "a.example.test" },
    },
  ],
  ...over,
});

function build(rows: Row[], answer: (target: DoorTarget) => DoorProbe | Promise<DoorProbe>) {
  const asked: DoorTarget[] = [];
  const written: { id: string; data: Record<string, unknown> }[] = [];
  const prisma = {
    node: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      updateMany: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        written.push({ id: where.id, data });
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  const prober = {
    probe: jest.fn((target: DoorTarget) => {
      asked.push(target);
      return Promise.resolve(answer(target));
    }),
  };
  const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  const service = new NodeDoorsService(prisma as never, prober as never);
  return { service, prisma, prober, asked, written, log, warn };
}

const passes = (pin: string) => (): DoorProbe => ({ ok: true, pin });
const fails = (): DoorProbe => ({ ok: false, reason: "ECONNREFUSED" });

describe("learning each node's door", () => {
  it("asks the node's address under the neutral name, and records what passed", async () => {
    const { service, asked, written, prisma } = build([node()], passes(PIN_A));

    expect(await service.runCycle(now)).toEqual({ checked: 1, verified: 1 });

    expect(asked).toEqual([
      { address: "203.0.113.9", port: 2053, sni: "static.example.com", names: ["a.example.test"], domains: [] },
    ]);
    expect(written).toEqual([
      { id: "n1", data: { doorPort: 2053, doorSni: "static.example.com", doorPin: PIN_A, doorVerifiedAt: NOW } },
    ]);
    // Retired and never-set-up nodes are not asked.
    expect(prisma.node.findMany.mock.calls[0][0].where).toEqual({ status: { in: ["ONLINE", "OFFLINE"] } });
  });

  it("moves on to the next port when one is not a door, and stops at the first that is", async () => {
    process.env.NODE_DOOR_PORTS = "2096,8443";
    const { service, asked, written } = build([node()], (target) => (target.port === 2096 ? passes(PIN_B)() : fails()));

    await service.runCycle(now);

    expect(asked.map((t) => t.port)).toEqual([2053, 2096]);
    expect(written[0].data).toMatchObject({ doorPort: 2096, doorPin: PIN_B });
  });

  it("asks the port it knows first, and only that one while it passes", async () => {
    const known = node({
      doorPort: 2096,
      doorPin: PIN_A,
      doorSni: "static.example.com",
      doorVerifiedAt: new Date(NOW.getTime() - 900_000),
    });
    const { service, asked } = build([known], passes(PIN_A));

    await service.runCycle(now);

    expect(asked.map((t) => t.port)).toEqual([2096]);
  });

  it("keeps the previous pin when a node's key has changed", async () => {
    const known = node({
      doorPort: 2053,
      doorPin: PIN_A,
      doorSni: "static.example.com",
      doorVerifiedAt: new Date(NOW.getTime() - 900_000),
    });
    const { service, written } = build([known], passes(PIN_B));

    await service.runCycle(now);

    expect(written).toEqual([
      {
        id: "n1",
        data: {
          doorPort: 2053,
          doorSni: "static.example.com",
          doorPin: PIN_B,
          doorVerifiedAt: NOW,
          doorPreviousPin: PIN_A,
          doorPinChangedAt: NOW,
        },
      },
    ]);
  });

  it("writes nothing when no port is a door, so the last passing check simply ages", async () => {
    const known = node({ doorPort: 2053, doorPin: PIN_A, doorVerifiedAt: new Date(NOW.getTime() - 900_000) });
    const { service, written, asked } = build([known], fails);

    expect(await service.runCycle(now)).toEqual({ checked: 1, verified: 0 });

    expect(asked.map((t) => t.port)).toEqual([2053, 2096]);
    expect(written).toEqual([]);
  });

  it("does not ask a node that no certificate could be accepted for", async () => {
    const nameless = node({
      protocolConfigs: [{ protocol: "WIREGUARD", listenPort: 51820, security: "NONE", publicParamsJson: {} }],
    });
    const { service, asked } = build([nameless], passes(PIN_A));

    expect(await service.runCycle(now)).toEqual({ checked: 1, verified: 0 });
    expect(asked).toEqual([]);

    // With a domain of ours configured there is something to accept.
    process.env.NODE_DOOR_DOMAINS = "example.org";
    await service.runCycle(now);
    expect(asked[0]).toMatchObject({ names: [], domains: ["example.org"] });
  });

  it("does not ask a row whose address is not an address", async () => {
    const { service, asked } = build([node({ publicIp: "a.example.test" })], passes(PIN_A));
    await service.runCycle(now);
    expect(asked).toEqual([]);
  });

  it("carries on with the other nodes when one throws", async () => {
    const rows = [node({ id: "n1", name: "alpha" }), node({ id: "n2", name: "beta", publicIp: "203.0.113.10" })];
    const { service, written } = build(rows, (target) => {
      if (target.address === "203.0.113.9") throw new Error("boom");
      return { ok: true, pin: PIN_A };
    });

    expect(await service.runCycle(now)).toEqual({ checked: 2, verified: 1 });
    expect(written.map((w) => w.id)).toEqual(["n2"]);
  });

  it("asks at most four nodes at once, and every node once", async () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      node({ id: `n${i}`, name: `node-${i}`, publicIp: `203.0.113.${i + 1}` }),
    );
    let inFlight = 0;
    let most = 0;
    const { service, asked } = build(rows, async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, pin: PIN_A };
    });

    expect(await service.runCycle(now)).toEqual({ checked: 11, verified: 11 });
    expect(most).toBe(4);
    expect(new Set(asked.map((t) => t.address)).size).toBe(11);
  });

  it("does not start a round while one is running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, asked } = build([node()], async () => {
      await gate;
      return { ok: true, pin: PIN_A };
    });

    const first = service.runCycle(now);
    expect(await service.runCycle(now)).toEqual({ checked: 0, verified: 0 });
    release();
    expect(await first).toEqual({ checked: 1, verified: 1 });
    expect(asked).toHaveLength(1);
  });

  it("does not throw when the database cannot be read", async () => {
    const { service, prisma } = build([], passes(PIN_A));
    prisma.node.findMany.mockRejectedValue(new Error("connection lost"));
    expect(await service.runCycle(now)).toEqual({ checked: 0, verified: 0 });
    // And is not left thinking a round is still running.
    prisma.node.findMany.mockResolvedValue([node()]);
    expect(await service.runCycle(now)).toEqual({ checked: 1, verified: 1 });
  });
});

describe("what the learner says", () => {
  it("says a door once when it is learned, and nothing while it stays the same", async () => {
    const row = node();
    const { service, log } = build([row], passes(PIN_A));

    await service.runCycle(now);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["alpha: door learned on port 2053"]);

    // The next round reads what the first wrote.
    Object.assign(row, { doorPort: 2053, doorSni: "static.example.com", doorPin: PIN_A, doorVerifiedAt: NOW });
    await service.runCycle(now);
    await service.runCycle(now);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("says a change of key once", async () => {
    const row = node({ doorPort: 2053, doorSni: "static.example.com", doorPin: PIN_A, doorVerifiedAt: NOW });
    const { service, log } = build([row], passes(PIN_B));

    await service.runCycle(now);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["alpha: door changed: certificate key changed"]);
  });

  it("says once that a door is no longer handed out, and once that it is back", async () => {
    const lastPassed = new Date(NOW.getTime() - DOOR_FRESH_MS - 60_000);
    const row = node({ doorPort: 2053, doorSni: "static.example.com", doorPin: PIN_A, doorVerifiedAt: lastPassed });
    let up = false;
    const { service, log, warn } = build([row], () =>
      up ? { ok: true, pin: PIN_A } : { ok: false, reason: "timeout" },
    );

    await service.runCycle(now);
    await service.runCycle(now);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("alpha: its door is no longer handed out");
    expect(log).not.toHaveBeenCalled();

    up = true;
    await service.runCycle(now);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["alpha: door back on port 2053"]);
  });

  it("says nothing about a door that missed a check but is still handed out", async () => {
    const row = node({ doorPort: 2053, doorPin: PIN_A, doorVerifiedAt: new Date(NOW.getTime() - 20 * 60_000) });
    const { service, log, warn } = build([row], fails);

    await service.runCycle(now);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("NODE_DOORS=off", () => {
  beforeEach(() => {
    process.env.NODE_DOORS = "off";
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("asks nothing, reads nothing and writes nothing", async () => {
    const { service, prisma, prober } = build([node()], passes(PIN_A));

    expect(await service.runCycle(now)).toEqual({ checked: 0, verified: 0 });
    expect(await service.learnNode("n1", now)).toBe(false);
    service.learnSoon("n1", 10);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(prisma.node.findMany).not.toHaveBeenCalled();
    expect(prisma.node.findFirst).not.toHaveBeenCalled();
    expect(prisma.node.updateMany).not.toHaveBeenCalled();
    expect(prober.probe).not.toHaveBeenCalled();
  });
});

describe("a node coming online", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("is asked for its door a little later, once, without anyone waiting", async () => {
    const { service, asked, written } = build([node()], passes(PIN_A));

    service.learnSoon("n1", 30_000);
    service.learnSoon("n1", 30_000);
    expect(asked).toEqual([]);

    await jest.advanceTimersByTimeAsync(29_000);
    expect(asked).toEqual([]);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(asked).toHaveLength(1);
    expect(written).toHaveLength(1);
  });

  it("is not asked after the service has shut down", async () => {
    const { service, asked } = build([node()], passes(PIN_A));
    service.learnSoon("n1", 30_000);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(asked).toEqual([]);
  });

  /** NodesService.setStatus is the one place a node's status is written. */
  function nodes(previous: string | null) {
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue(previous ? { status: previous, name: "alpha" } : null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const doors = { learnSoon: jest.fn() };
    const alerting = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new NodesService(
      prisma as never,
      alerting as never,
      {} as never,
      { get: () => undefined } as never,
      doors as never,
    );
    return { service, doors };
  }

  it.each(["PENDING", "OFFLINE"])("asks when a node goes from %s to ONLINE", async (previous) => {
    const { service, doors } = nodes(previous);
    await service.setStatus("n1", "ONLINE");
    expect(doors.learnSoon).toHaveBeenCalledWith("n1");
  });

  it("does not ask again when an agent that was already ONLINE says hello, or when a node goes OFFLINE", async () => {
    const { service, doors } = nodes("ONLINE");
    await service.setStatus("n1", "ONLINE");
    await service.setStatus("n1", "OFFLINE");
    expect(doors.learnSoon).not.toHaveBeenCalled();
  });

  it("still sets the status when built without the learner", async () => {
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue({ status: "OFFLINE", name: "alpha" }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new NodesService(
      prisma as never,
      { send: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      { get: () => undefined } as never,
    );
    await expect(service.setStatus("n1", "ONLINE")).resolves.toBeUndefined();
    expect(prisma.node.update).toHaveBeenCalled();
  });
});
