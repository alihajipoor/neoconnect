import { Controller, Get, Logger, Post, Req, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AsnTable } from "../../modules/network-identity/asn-table";
import {
  defaultGateways,
  parseRelayListen,
  relayContextOf,
  relayGate,
  startRelayListener,
  trustedRelayPeers,
} from "./relay-arrival";

/** Rows on documentation ranges: one network registered in Iran, one in
 * Germany. Anything else is unknown. */
const TABLE = AsnTable.fromLines([
  "192.0.2.0\t192.0.2.255\t64500\tIR\tEXAMPLE-IR",
  "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-DE",
]);

const reached: string[] = [];

@Controller()
class ProbeController {
  @Get("health")
  health(@Req() req: Request) {
    reached.push("health");
    return {
      relay: relayContextOf(req),
      via: req.headers["x-neoxify-via"] ?? null,
      box: req.headers["x-neoxify-relay-box"] ?? null,
    };
  }

  @Post("customer-auth/relay-register")
  register(@Req() req: Request) {
    reached.push("relay-register");
    return { relay: relayContextOf(req) };
  }

  @Get("customer/support")
  support() {
    reached.push("support");
    return { reached: true };
  }
}

describe("relay arrival", () => {
  let app: INestApplication;
  let main: string;
  let relay: string;
  let relayServer: Server;
  let strictServer: Server;
  let strict: string;
  const refused: string[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    const nest = module.createNestApplication<NestExpressApplication>();
    nest.set("trust proxy", 1);
    nest.use(
      relayGate({
        lookup: (ip) => {
          const info = TABLE.lookup(ip);
          return info ? { asn: info.asn, country: TABLE.countryOf(ip) } : null;
        },
      }),
    );
    await nest.listen(0, "127.0.0.1");
    app = nest;
    main = `http://127.0.0.1:${((nest.getHttpServer() as Server).address() as AddressInfo).port}`;

    const handler = nest.getHttpAdapter().getInstance();
    relayServer = await startRelayListener(handler, { host: "127.0.0.1", port: 0, trusted: trustedRelayPeers("", "") });
    relay = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;
    // A listener that trusts only some other peer: what a sibling
    // container dialling the backend's relay port directly looks like.
    strictServer = await startRelayListener(handler, {
      host: "127.0.0.1",
      port: 0,
      trusted: new Set(["192.0.2.254"]),
      onRefused: (peer) => refused.push(peer),
    });
    strict = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => relayServer?.close(resolve));
    await new Promise((resolve) => strictServer?.close(resolve));
    await app?.close();
  });

  beforeEach(() => {
    reached.length = 0;
  });

  const get = (base: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers });

  it("never takes a client's word for it on the normal listener", async () => {
    const res = await get(main, "/health", {
      "X-Neoxify-Via": "relay",
      "X-Neoxify-Relay-Box": "ir-a",
      "X-Forwarded-For": "192.0.2.10",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ relay: null, via: null, box: null });
  });

  it("marks a request that came in by the relay listener, with its box and network", async () => {
    const res = await get(relay, "/health", {
      "X-Forwarded-For": "192.0.2.10",
      "X-Neoxify-Relay-Box": "IR-A",
      "X-Neoxify-Via": "something",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relay: Record<string, unknown>; via: unknown; box: unknown };
    expect(body.relay).toMatchObject({ box: "ir-a", asn: 64500, region: "IR" });
    expect(body.relay.ipKey).toMatch(/^relay:/);
    expect(body.relay.ipKey).not.toContain("192.0.2.10");
    // Read once, then gone: nothing downstream sees either header.
    expect(body.via).toBeNull();
    expect(body.box).toBeNull();
  });

  it("drops a box name that is not one", async () => {
    const res = await get(relay, "/health", { "X-Forwarded-For": "192.0.2.10", "X-Neoxify-Relay-Box": "a b;c" });
    expect(((await res.json()) as { relay: { box: string } }).relay.box).toBe("");
  });

  it("answers 404 to anything off the allowlist, before any controller runs", async () => {
    for (const path of ["/customer/support", "/health?x=1", "/health/", "/HEALTH"]) {
      const res = await get(relay, path, { "X-Forwarded-For": "192.0.2.10" });
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(reached).toEqual([]);
    // The same route on the normal listener is served.
    expect((await get(main, "/customer/support")).status).toBe(200);
  });

  it("refuses a caller registered outside Iran with RELAY_REGION", async () => {
    const res = await get(relay, "/health", { "X-Forwarded-For": "203.0.113.5" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "RELAY_REGION" });
    expect(reached).toEqual([]);
  });

  it("lets an unknown network sign in but not sign up", async () => {
    expect((await get(relay, "/health", { "X-Forwarded-For": "198.51.100.7" })).status).toBe(200);
    const signup = await fetch(`${relay}/customer-auth/relay-register`, {
      method: "POST",
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    expect(signup.status).toBe(403);
    expect(await signup.json()).toMatchObject({ code: "RELAY_REGION" });
    const fromIran = await fetch(`${relay}/customer-auth/relay-register`, {
      method: "POST",
      headers: { "X-Forwarded-For": "192.0.2.10" },
    });
    expect(fromIran.status).toBe(201);
    expect(reached).toEqual(["health", "relay-register"]);
  });

  it("is a 404 on the normal listener for nobody: the route exists, it just is not relay-marked", async () => {
    const res = await fetch(`${main}/customer-auth/relay-register`, {
      method: "POST",
      headers: { "X-Neoxify-Via": "relay", "X-Forwarded-For": "192.0.2.10" },
    });
    expect(await res.json()).toEqual({ relay: null });
  });

  /** F3: the panel and the bot share the backend's network and could dial
   * the relay port directly. Their connections are closed unread. */
  it("closes a connection from a peer it does not trust, with or without a marker", async () => {
    await expect(get(strict, "/health", { "X-Neoxify-Via": "relay", "X-Forwarded-For": "192.0.2.10" })).rejects.toThrow();
    expect(refused).toContain("127.0.0.1");
    expect(reached).toEqual([]);
  });
});

describe("trusted relay peers", () => {
  const ROUTE_TABLE = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");

  it("reads the default gateway from /proc/net/route", () => {
    expect(defaultGateways(ROUTE_TABLE)).toEqual(["172.18.0.1"]);
    expect(defaultGateways("")).toEqual([]);
  });

  it("trusts loopback and the gateway, or loopback and what is configured", () => {
    expect([...trustedRelayPeers(undefined, ROUTE_TABLE)].sort()).toEqual(["127.0.0.1", "172.18.0.1", "::1"]);
    expect([...trustedRelayPeers("10.0.0.1, ::ffff:10.0.0.2, junk", ROUTE_TABLE)].sort()).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "127.0.0.1",
      "::1",
    ]);
  });

  it("parses RELAY_LISTEN, and anything odd means no relay listener", () => {
    expect(parseRelayListen("0.0.0.0:4001")).toEqual({ host: "0.0.0.0", port: 4001 });
    expect(parseRelayListen("4001")).toEqual({ host: "127.0.0.1", port: 4001 });
    for (const value of [undefined, "", "  ", "0", "70000", "localhost:4001", "[::]:4001", "1.2.3:4001", "4001x"]) {
      expect([value, parseRelayListen(value)]).toEqual([value, null]);
    }
  });
});
