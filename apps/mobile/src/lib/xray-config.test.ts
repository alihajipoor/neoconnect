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
