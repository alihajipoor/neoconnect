import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { AddressInfo, Server } from "node:net";

import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { RoutesService } from "./routes.service";

/** Does an *exit* identity actually reach a client, over HTTP, and does
 * it name an exit rather than a route?
 *
 * Driven end to end for the same reason `game-catalogue-delivery.spec.ts`
 * is: the past failure in this codebase was a field that every layer
 * handled correctly on its own and that the endpoint's `select` dropped
 * in the middle, with nothing anywhere reporting it. A DTO-shape
 * assertion would have passed. So this stands up a real Nest server, on
 * a real port, with the real `RoutesService` and the real
 * `ConfigService`, and asserts on the JSON a client parses.
 *
 * The three things it has to establish, because the feature is unusable
 * if any one of them is wrong:
 *
 *   1. two routes that end on the same machine carry the **same**
 *      handle -- including a direct route and a relay whose exit leg is
 *      that same machine, which is exactly the case a route id gets
 *      wrong and which would report `Fallback` for a game that is in
 *      fact where the customer put it;
 *   2. two routes that end on different machines carry **different**
 *      handles;
 *   3. nothing in the payload names an exit node -- no address, no
 *      hostname, no database id. `docs/node-address-hygiene.md` measured
 *      that an enumerable fleet is what earns the `is_vpn` label, and a
 *      handle that leaked one would trade a real asset for a feature.
 *
 * WHAT IS NOT PROVEN HERE, stated plainly: there is no Postgres. The
 * Prisma stand-in below applies `select` the way Prisma does -- which is
 * what pins the projection, and is the layer the past bug lived in --
 * but no query planner, no real join and no `text[]` round trip is
 * exercised. Nor has any of this been run against a live node: whether
 * traffic on two routes sharing a handle really leaves from one address
 * is a fact about the fleet, and its only ground truth is an exit-IP
 * check made through each tunnel.
 */

/** Applies a Prisma `select` recursively.
 *
 * Nested, unlike the flat helper in the gaming spec, because the thing
 * under test is a *nested* select: the exit node's id is read through
 * `exitProtocolConfig`, and a select that forgot to name it would be the
 * original bug's exact shape.
 */
function project(row: unknown, select: Record<string, unknown>): unknown {
  if (row === null || row === undefined) return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted === true) {
      out[key] = source[key];
    } else if (wanted && typeof wanted === "object") {
      const nested = (wanted as { select?: Record<string, unknown> }).select;
      out[key] = nested ? project(source[key], nested) : source[key];
    }
  }
  return out;
}

/** Node ids and addresses, all documentation-range per
 * `docs/node-address-hygiene.md`. The point of the exit ones is that
 * they must never appear in a response. */
const GERMANY = { id: "node-de-0000-0000-0000-000000000001", name: "germany-1", region: "de", publicIp: "203.0.113.10" };
const FINLAND = { id: "node-fi-0000-0000-0000-000000000002", name: "finland1", region: "fi", publicIp: "203.0.113.20" };
/** A relay in Iran. Its own address is an entry address and is published
 * already; what must stay hidden is which machine its traffic leaves
 * from. */
const IRAN_RELAY = { id: "node-ir-0000-0000-0000-000000000003", name: "ir1", region: "ir", publicIp: "198.51.100.10" };

const FRESH = new Date();

/** Four routes across three machines, chosen so every comparison the
 * feature depends on is present at once:
 *
 * | route | dialled at | leaves from |
 * |---|---|---|
 * | `de-wg`      | germany-1 | germany-1 |
 * | `de-reality` | germany-1 | germany-1 |
 * | `fi-reality` | finland1  | finland1  |
 * | `ir-relay`   | ir1       | germany-1 |
 *
 * `de-wg` and `de-reality` are the plain shared-exit case. `ir-relay`
 * and either of them is the sharp one: three different entry addresses,
 * two different protocols, and one machine that the far end sees.
 */
const ROUTES = [
  {
    id: "route-de-wg",
    name: "Germany (WireGuard)",
    exitProtocolConfigId: null,
    exitProtocolConfig: null,
    uplinkAssertedAt: null,
    entryProtocolConfig: {
      protocol: "WIREGUARD",
      nodeId: GERMANY.id,
      transport: "UDP",
      listenPort: 51820,
      node: { ...GERMANY, status: "ONLINE", lastHeartbeatAt: FRESH },
    },
  },
  {
    id: "route-de-reality",
    name: "Germany (Stealth)",
    exitProtocolConfigId: null,
    exitProtocolConfig: null,
    uplinkAssertedAt: null,
    entryProtocolConfig: {
      protocol: "XRAY_VLESS_REALITY",
      nodeId: GERMANY.id,
      transport: "TCP",
      listenPort: 443,
      node: { ...GERMANY, status: "ONLINE", lastHeartbeatAt: FRESH },
    },
  },
  {
    id: "route-fi-reality",
    name: "Finland (Stealth)",
    exitProtocolConfigId: null,
    exitProtocolConfig: null,
    uplinkAssertedAt: null,
    entryProtocolConfig: {
      protocol: "XRAY_VLESS_REALITY",
      nodeId: FINLAND.id,
      transport: "TCP",
      listenPort: 443,
      node: { ...FINLAND, status: "ONLINE", lastHeartbeatAt: FRESH },
    },
  },
  {
    id: "route-ir-relay",
    name: "Iran relay to Germany",
    exitProtocolConfigId: "cfg-de-exit",
    // The exit leg. Read through a nested select, and the one field in
    // this whole response that decides what the far end sees.
    exitProtocolConfig: { nodeId: GERMANY.id },
    uplinkAssertedAt: FRESH,
    entryProtocolConfig: {
      protocol: "XRAY_VLESS_REALITY",
      nodeId: IRAN_RELAY.id,
      transport: "TCP",
      listenPort: 443,
      node: { ...IRAN_RELAY, status: "ONLINE", lastHeartbeatAt: FRESH },
    },
  },
];

type Option = {
  id: string;
  name: string;
  isRelay: boolean;
  exit: string | null;
  endpoint: { host: string; port: number };
  location: { region: string; nodeName: string };
};

describe("exit identity delivery", () => {
  let app: INestApplication;
  let baseUrl: string;

  /** Whatever this deployment has configured. Set per test through the
   * closure below so the "no secret" case exercises the same server. */
  let secret: string | undefined = "test-exit-handle-secret";

  beforeAll(async () => {
    const prisma = {
      route: {
        findMany: jest.fn(({ where, select }) => {
          const allowed = new Set<string>(where?.id?.in ?? []);
          const protocols = new Set<string>(where?.entryProtocolConfig?.protocol?.in ?? []);
          const rows = ROUTES.filter(
            (r) => allowed.has(r.id) && protocols.has(r.entryProtocolConfig.protocol),
          );
          return Promise.resolve(rows.map((r) => project(r, select)));
        }),
      },
    };

    const config = { get: (key: string) => (key === "security.exitHandleSecret" ? secret : undefined) };

    @Controller("customer")
    class TestCustomerController {
      constructor(private readonly routes: RoutesService) {}
      // The same call `CustomerController.availableRoutes` makes. The
      // guards it carries are about who may ask; this is about what
      // comes back.
      @Get("subscriptions/:customerId/routes")
      availableRoutes(@Param("customerId") customerId: string) {
        return this.routes.listAvailableForPlan(
          ["WIREGUARD", "XRAY_VLESS_REALITY"] as never,
          ROUTES.map((r) => r.id),
          customerId,
        );
      }
    }

    @Module({
      controllers: [TestCustomerController],
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentGatewayService, useValue: {} },
        { provide: ProtocolUsersService, useValue: {} },
        { provide: ConfigService, useValue: config },
      ],
    })
    class TestModule {}

    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication();
    await app.init();
    await app.listen(0);
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function optionsFor(customerId: string): Promise<Option[]> {
    const res = await fetch(`${baseUrl}/customer/subscriptions/${customerId}/routes`);
    expect(res.status).toBe(200);
    return (await res.json()) as Option[];
  }

  const byId = (options: Option[], id: string) => options.find((o) => o.id === id);

  it("gives two routes that leave from one machine the same handle", async () => {
    const options = await optionsFor("customer-1");
    const wg = byId(options, "route-de-wg");
    const reality = byId(options, "route-de-reality");

    // Present at all -- a null here is the state that shipped before
    // this existed and it makes every assertion below vacuous.
    expect(typeof wg?.exit).toBe("string");
    expect(wg?.exit).toBe(reality?.exit);
    // And the route ids are not the handle, which is the mistake this
    // whole field exists to correct.
    expect(wg?.exit).not.toBe(wg?.id);
  });

  it("gives a relay the handle of the machine it leaves from, not the one it is dialled at", async () => {
    const options = await optionsFor("customer-1");
    const relay = byId(options, "route-ir-relay");
    const germany = byId(options, "route-de-wg");
    const finland = byId(options, "route-fi-reality");

    // The case a route id gets wrong. A game placed on Germany and
    // carried over the Iran relay IS on Germany -- the far end sees
    // germany-1 -- and reporting that as `Fallback` would be claiming a
    // mismatch nobody established.
    expect(relay?.isRelay).toBe(true);
    expect(relay?.exit).toBe(germany?.exit);
    expect(relay?.exit).not.toBe(finland?.exit);
    // Its entry is somewhere else entirely, and the handle is unmoved by
    // that.
    expect(relay?.location.nodeName).toBe("ir1");
  });

  it("gives two routes that leave from different machines different handles", async () => {
    const options = await optionsFor("customer-1");
    expect(byId(options, "route-de-wg")?.exit).not.toBe(byId(options, "route-fi-reality")?.exit);
  });

  it("names no exit node -- no address, no hostname, no id -- anywhere in the payload", async () => {
    const res = await fetch(`${baseUrl}/customer/subscriptions/customer-1/routes`);
    const raw = await res.text();

    // The relay's exit is germany-1. Its address, its name and its
    // database id must all be absent: an identifier a client can turn
    // back into a machine is a fleet that can be enumerated, which is
    // the property `docs/node-address-hygiene.md` measured as the thing
    // that earns an `is_vpn` label.
    expect(raw).not.toContain(GERMANY.id);
    expect(raw).not.toContain(FINLAND.id);
    expect(raw).not.toContain(IRAN_RELAY.id);

    // Entry addresses ARE published -- the client dials them, and it
    // times them itself rather than trusting a figure measured on the
    // server. So the assertion is per route: an option's endpoint host
    // is its own entry, and never the machine behind a relay.
    const options = JSON.parse(raw) as Option[];
    expect(byId(options, "route-ir-relay")?.endpoint.host).toBe(IRAN_RELAY.publicIp);
    for (const option of options) {
      expect(option).not.toHaveProperty("exitProtocolConfig");
      expect(option).not.toHaveProperty("exitProtocolConfigId");
      expect(option).not.toHaveProperty("uplinkCredentialsJson");
    }
    // And germany-1's address appears only on the two routes actually
    // dialled there, never smuggled through the relay's row.
    const carryingGermanyAddress = options.filter((o) => JSON.stringify(o).includes(GERMANY.publicIp));
    expect(carryingGermanyAddress.map((o) => o.id).sort()).toEqual(["route-de-reality", "route-de-wg"]);
  });

  it("gives two customers different handles for the same machine", async () => {
    const [mine, theirs] = await Promise.all([optionsFor("customer-1"), optionsFor("customer-2")]);

    // Without this, anyone holding two accounts -- or aggregating what
    // clients send -- could count the fleet and join sightings of one
    // exit across unrelated customers. Comparability is only ever needed
    // *within* one customer's own list.
    expect(byId(mine, "route-de-wg")?.exit).not.toBe(byId(theirs, "route-de-wg")?.exit);
    // And it stays comparable inside each of them.
    expect(byId(theirs, "route-de-wg")?.exit).toBe(byId(theirs, "route-ir-relay")?.exit);
  });

  it("is stable, so a preference saved last month still names the same exit", async () => {
    const first = await optionsFor("customer-1");
    const second = await optionsFor("customer-1");
    expect(byId(second, "route-de-wg")?.exit).toBe(byId(first, "route-de-wg")?.exit);
  });

  it("falls back to no exit vocabulary at all when no secret is configured", async () => {
    const configured = secret;
    secret = undefined;
    try {
      const options = await optionsFor("customer-1");
      // Null, not an unkeyed digest. An unkeyed handle would be the same
      // string for every customer, which is the one property this must
      // never have -- and null is a state the client already handles by
      // offering no picker and reporting every placement as unknown.
      expect(options.map((o) => o.exit)).toEqual([null, null, null, null]);
    } finally {
      secret = configured;
    }
  });

  it("fits the identifier cap the desktop IPC enforces", async () => {
    const options = await optionsFor("customer-1");
    for (const option of options) {
      // MAX_EXIT_ID_LEN in apps/desktop-windows/ipc/src/lib.rs. A handle
      // over it is refused by the service, which would take the
      // customer's whole app selection down with it.
      expect((option.exit ?? "").length).toBeGreaterThan(0);
      expect((option.exit ?? "").length).toBeLessThanOrEqual(64);
      // Nothing the IPC's control-character check would reject, and
      // nothing a URL or a JSON string has to escape.
      expect(option.exit).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
