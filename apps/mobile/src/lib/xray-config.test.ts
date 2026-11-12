import { describe, expect, it } from "vitest";
import { buildXrayConfig } from "./xray-config";
import type { ProtocolUser } from "@shared/lib/types";

/*
Guards the shape of what the server sends against what this file reads.

Every bug this suite exists for is the same one: the backend puts a key
in `publicParams` under one name, the client reads another, the missing
value is falsy rather than fatal, and the connection fails somewhere far
away from the cause. It has now happened three times -- Trojan's
`serverName`, IKEv2's `endpointHost`, and REALITY's `shortIds` -- so
these assert against the real key names rather than against whatever the
builder happens to do today.
*/

function user(protocol: string, publicParams: Record<string, unknown>, credentials: Record<string, string>): ProtocolUser {
  return {
    id: "pu-1",
    subscriptionId: "sub-1",
    routeId: "route-1",
    nodeId: "node-1",
    protocolConfigId: "cfg-1",
    protocol: protocol as ProtocolUser["protocol"],
    externalUserId: "ext-1",
    status: "ACTIVE",
    createdAt: "",
    updatedAt: "",
    credentials,
    connection: { host: "203.0.113.5", port: 443, transport: "TCP", security: "REALITY", publicParams },
  } as ProtocolUser;
}

const REALITY_PARAMS = {
  realityPublicKey: "mYq9AsSqMYjpfG2Vp36NMc8zFJcippAHvP1_R0ebzFc",
  // An array, which is what the server actually sends: it is the set of
  // IDs the node will accept, and a client picks one.
  shortIds: ["e341f2050d3761d4"],
  dest: "cloudflare.com:443",
  serverName: "cloudflare.com",
};

describe("REALITY", () => {
  // The bug this file was written for. Reading `shortId` (singular)
  // meant every Android REALITY connection offered an empty one, and
  // REALITY answers an unauthenticated client by transparently proxying
  // it to the site it is imitating. So the tunnel came up, carried the
  // customer to cloudflare.com, and the app's evidence check reported
  // "up but not carrying traffic" -- a failure that looked like a
  // network problem and was a one-word mismatch.
  it("sends the first shortId from the server's list", () => {
    const config = JSON.parse(
      buildXrayConfig(user("XRAY_VLESS_REALITY", REALITY_PARAMS, { uuid: "u-1", flow: "xtls-rprx-vision" })),
    );
    const outbound = config.outbounds.find((o: { tag: string }) => o.tag === "proxy");
    expect(outbound.streamSettings.realitySettings.shortId).toBe("e341f2050d3761d4");
  });

  it("carries the public key and SNI the server published", () => {
    const config = JSON.parse(
      buildXrayConfig(user("XRAY_VLESS_REALITY", REALITY_PARAMS, { uuid: "u-1", flow: "xtls-rprx-vision" })),
    );
    const reality = config.outbounds.find((o: { tag: string }) => o.tag === "proxy").streamSettings.realitySettings;
    expect(reality.publicKey).toBe(REALITY_PARAMS.realityPublicKey);
    expect(reality.serverName).toBe("cloudflare.com");
  });

  // Refusing is the whole point: an empty shortId is accepted by the
  // server and silently downgrades the customer to browsing the
  // camouflage site, which is worse than not connecting.
  it("refuses to build a config with no shortId rather than sending an empty one", () => {
    const { shortIds, ...withoutShortIds } = REALITY_PARAMS;
    void shortIds;
    expect(() =>
      buildXrayConfig(user("XRAY_VLESS_REALITY", withoutShortIds, { uuid: "u-1", flow: "" })),
    ).toThrow(/REALITY/);
  });

  it("refuses an empty shortIds array, which is not the same as a valid one", () => {
    expect(() =>
      buildXrayConfig(user("XRAY_VLESS_REALITY", { ...REALITY_PARAMS, shortIds: [] }, { uuid: "u-1", flow: "" })),
    ).toThrow(/REALITY/);
  });
});

describe("Shadowsocks", () => {
  const SS_PARAMS = { method: "2022-blake3-aes-256-gcm", serverKey: "server-key" };

  // xray-core v26.6.27 (the engine since the TUN crash fix) reads no
  // `uot` (#6286): a key that looks like it carries UDP and does nothing,
  // so every UDP flow would leave as plain UDP. XUDP over the mux instead,
  // with TCP left unmuxed -- the Windows client's shape.
  it("carries UDP over the mux, not the dropped uot key", () => {
    const config = JSON.parse(buildXrayConfig(user("SHADOWSOCKS", SS_PARAMS, { userKey: "user-key" })));
    const outbound = config.outbounds.find((o: { tag: string }) => o.tag === "proxy");
    expect(outbound.mux).toEqual({ enabled: true, concurrency: -1, xudpConcurrency: 16, xudpProxyUDP443: "allow" });
    expect(outbound.settings.servers[0].uot).toBeUndefined();
    expect(outbound.settings.servers[0].password).toBe("server-key:user-key");
  });

  it("muxes nothing else: Vision refuses a mux, and TCP stays one connection each", () => {
    for (const [protocol, params, credentials] of [
      ["XRAY_VLESS_REALITY", REALITY_PARAMS, { uuid: "u-1", flow: "xtls-rprx-vision" }],
      ["XRAY_VLESS_TLS", { serverName: "example.com" }, { uuid: "u-1", flow: "xtls-rprx-vision" }],
      ["XRAY_TROJAN", { serverName: "example.com" }, { password: "p" }],
    ] as const) {
      const config = JSON.parse(buildXrayConfig(user(protocol, params, credentials)));
      expect(config.outbounds[0].mux, protocol).toBeUndefined();
    }
  });
});

/*
The configs the engine's own tests start (plugins/vpn/xray, darwin): one
per transport the phones offer, built here by the real builder so the Go
tests run what the app sends rather than a hand-written copy. The Go side
replaces only the address, port and credentials with a local server's
throwaway ones. A change to the builder changes this file; `pnpm test -u`
rewrites it, and the engine tests should then be run on the Mac.
*/
describe("engine test fixture", () => {
  it("matches what the builder produces for every transport", async () => {
    const PLACEHOLDER = { host: "127.0.0.1", port: 1 };
    function fixtureUser(protocol: string, transport: string, publicParams: Record<string, unknown>, credentials: Record<string, string>) {
      const u = user(protocol, publicParams, credentials);
      return { ...u, connection: { ...u.connection, ...PLACEHOLDER, transport } } as ProtocolUser;
    }
    const tls = { serverName: "neoxify.test" };
    const configs = {
      "reality": buildXrayConfig(fixtureUser("XRAY_VLESS_REALITY", "TCP", { ...REALITY_PARAMS, serverName: "neoxify.test" }, { uuid: "UUID", flow: "xtls-rprx-vision" })),
      "vless-tls-tcp": buildXrayConfig(fixtureUser("XRAY_VLESS_TLS", "TCP", tls, { uuid: "UUID", flow: "xtls-rprx-vision" })),
      "vless-tls-ws": buildXrayConfig(fixtureUser("XRAY_VLESS_TLS", "WS", { ...tls, path: "/ws" }, { uuid: "UUID", flow: "" })),
      "trojan": buildXrayConfig(fixtureUser("XRAY_TROJAN", "TCP", tls, { password: "PASSWORD" })),
      "shadowsocks": buildXrayConfig(fixtureUser("SHADOWSOCKS", "TCP", { method: "2022-blake3-aes-256-gcm", serverKey: "SERVERKEY" }, { userKey: "USERKEY" })),
    };
    const parsed = Object.fromEntries(Object.entries(configs).map(([k, v]) => [k, JSON.parse(v)]));
    await expect(JSON.stringify(parsed, null, 2) + "\n").toMatchFileSnapshot("../../plugins/vpn/xray/testdata/app-configs.json");
  });
});

describe("traffic counters", () => {
  // The speeds come from these (plugins/vpn/xray/xray.go, Uplink and
  // Downlink): the engine counts the outbound tagged "proxy", and only when
  // the config asks for stats and a system policy that counts it.
  it("asks the engine to count the server outbound in both directions", () => {
    const config = JSON.parse(buildXrayConfig(user("XRAY_VLESS_REALITY", REALITY_PARAMS, { uuid: "u-1", flow: "xtls-rprx-vision" })));
    expect(config.stats).toEqual({});
    expect(config.policy).toEqual({ system: { statsOutboundUplink: true, statsOutboundDownlink: true } });
    expect(config.outbounds.map((o: { tag: string }) => o.tag)).toEqual(["proxy"]);
  });
});
