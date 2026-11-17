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
    expect(config.outbounds.map((o: { tag: string }) => o.tag)).toEqual(["proxy", "dns-out", "block"]);
  });
});

const ALL_PROTOCOLS = [
  ["XRAY_VLESS_REALITY", REALITY_PARAMS, { uuid: "u-1", flow: "xtls-rprx-vision" }],
  ["XRAY_VLESS_TLS", { serverName: "example.com" }, { uuid: "u-1", flow: "xtls-rprx-vision" }],
  ["XRAY_TROJAN", { serverName: "example.com" }, { password: "p" }],
  ["SHADOWSOCKS", { method: "2022-blake3-aes-256-gcm", serverKey: "server-key" }, { userKey: "user-key" }],
] as const;

describe("lookups inside the engine", () => {
  // Every lookup from a new source port used to be a UDP flow of its own,
  // and on Stealth a new connection to the server: 868 ms a lookup.
  it("sends the tunnel's port 53 to the DNS outbound, on every protocol", () => {
    for (const [protocol, params, credentials] of ALL_PROTOCOLS) {
      const config = JSON.parse(buildXrayConfig(user(protocol, params, credentials)));
      expect(config.routing.rules[0], protocol).toEqual({
        type: "field",
        inboundTag: ["tun-in"],
        port: "53",
        outboundTag: "dns-out",
      });
      // The proxy stays first, so the resolver's own connections -- which
      // no rule names -- go through it and never directly.
      expect(config.outbounds[0].tag, protocol).toBe("proxy");
    }
  });

  // DoH keeps one connection for every query, so it is first. A dead
  // kept-open connection must not cost a lookup: it gets 2 s, then the
  // same lookup moves on to a TCP server, which dials fresh every time.
  // In turn, not at once. By address, and never "localhost" or a "+local"
  // scheme, which would leave outside the tunnel.
  it("asks DoH first with a short timeout, then a fresh TCP server, in turn, IPv4 answers only", () => {
    const config = JSON.parse(buildXrayConfig(user(...ALL_PROTOCOLS[0])));
    expect(config.dns.queryStrategy).toBe("UseIPv4");
    expect(config.dns.enableParallelQuery).toBe(false);
    expect(config.dns.servers).toEqual([
      { address: "https://1.1.1.1/dns-query", timeoutMs: 2000 },
      "tcp://8.8.8.8:53",
    ]);
    for (const server of config.dns.servers) {
      const address = typeof server === "string" ? server : server.address;
      expect(address).toMatch(/^(https|tcp):\/\/\d+\.\d+\.\d+\.\d+[:/]/);
    }
    // No serveStale: no expired answers kept in the iPhone's 50 MB.
    expect(config.dns.serveStale).toBeUndefined();
  });

  it("answers A and AAAA itself, empties HTTPS records, passes the rest on through the proxy", () => {
    const config = JSON.parse(buildXrayConfig(user(...ALL_PROTOCOLS[0])));
    const dnsOut = config.outbounds.find((o: { tag: string }) => o.tag === "dns-out");
    expect(dnsOut.protocol).toBe("dns");
    expect(dnsOut.settings.rewriteNetwork).toBe("tcp");
    expect(dnsOut.settings.rules).toEqual([
      { action: "hijack", qType: "1,28" },
      { action: "return", qType: "64,65" },
      { action: "direct" },
    ]);
    // Passed-on queries leave through the proxy, never from the phone.
    expect(dnsOut.proxySettings).toEqual({ tag: "proxy" });
  });
});

describe("IPv6", () => {
  it("closes an IPv6 destination on the phone, after the lookup rule", () => {
    for (const [protocol, params, credentials] of ALL_PROTOCOLS) {
      const config = JSON.parse(buildXrayConfig(user(protocol, params, credentials)));
      expect(config.routing.rules[1], protocol).toEqual({ type: "field", ip: ["::/0"], outboundTag: "block" });
      const block = config.outbounds.find((o: { tag: string }) => o.tag === "block");
      expect(block.protocol).toBe("blackhole");
    }
  });
});

describe("QUIC on Vision", () => {
  const flowOf = (config: { outbounds: { settings: { vnext: { users: { flow: string }[] }[] } }[] }) =>
    config.outbounds[0].settings.vnext[0].users[0].flow;

  const DROP_RULE = { type: "field", inboundTag: ["tun-in"], network: "udp", port: "443", outboundTag: "block" };
  const VISION_PROTOCOLS = [
    ["XRAY_VLESS_REALITY", REALITY_PARAMS],
    ["XRAY_VLESS_TLS", { serverName: "example.com" }],
  ] as const;

  // Plain Vision refuses UDP/443 after dialling the server: a wasted
  // handshake and silence. By default the phone refuses it first, without
  // dialling, and sends the flow as issued: the app sees what it saw
  // before, minus the wasted dial.
  it("by default refuses QUIC on the phone and keeps the issued flow", () => {
    for (const [protocol, params] of VISION_PROTOCOLS) {
      const config = JSON.parse(buildXrayConfig(user(protocol, params, { uuid: "u-1", flow: "xtls-rprx-vision" })));
      expect(flowOf(config), protocol).toBe("xtls-rprx-vision");
      expect(config.routing.rules, protocol).toContainEqual(DROP_RULE);
      // After the lookup and IPv6 rules, which keep their places.
      expect(config.routing.rules[2], protocol).toEqual(DROP_RULE);
    }
  });

  // Still selectable. The suffix is client-only; the outbound trims it
  // before anything is sent.
  it("can instead carry QUIC with the client-only udp443 flow", () => {
    for (const [protocol, params] of VISION_PROTOCOLS) {
      const config = JSON.parse(
        buildXrayConfig(user(protocol, params, { uuid: "u-1", flow: "xtls-rprx-vision" }), "carry"),
      );
      expect(flowOf(config), protocol).toBe("xtls-rprx-vision-udp443");
      expect(config.routing.rules.some((r: { port?: string }) => r.port === "443"), protocol).toBe(false);
    }
  });

  it("adds the refusal to no protocol without Vision", () => {
    for (const [protocol, params, credentials] of ALL_PROTOCOLS.slice(2)) {
      const config = JSON.parse(buildXrayConfig(user(protocol, params, credentials)));
      expect(config.routing.rules, protocol).not.toContainEqual(DROP_RULE);
      expect(config.routing.rules.length, protocol).toBe(2);
    }
  });

  // WebSocket has no Vision; Shadowsocks carries QUIC already. Neither
  // gets the flow nor the rule, whichever way the constant is set.
  it("leaves every other flow and protocol alone", () => {
    for (const quic of ["carry", "drop-locally"] as const) {
      const ws = user("XRAY_VLESS_TLS", { serverName: "example.com", path: "/ws" }, { uuid: "u-1", flow: "" });
      const wsConfig = JSON.parse(buildXrayConfig({ ...ws, connection: { ...ws.connection, transport: "WS" } } as ProtocolUser, quic));
      expect(flowOf(wsConfig), quic).toBe("");
      for (const config of [wsConfig, JSON.parse(buildXrayConfig(user(...ALL_PROTOCOLS[3]), quic))]) {
        expect(config.routing.rules.some((r: { port?: string }) => r.port === "443"), quic).toBe(false);
      }
    }
  });
});
