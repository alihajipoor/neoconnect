import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URLS } from "./config";

/** The order the control plane is asked in while a tunnel is up, when its
 * own server hosts one of the mirrors.
 *
 * On Windows the Xray, OpenVPN and IKEv2 engines reach their server around
 * the tunnel, and with it every request to that address (`tunnelServerOf`
 * in tunnel-server.ts): a mirror on the connected node is asked over the
 * bare line, a full TLS handshake with the mirror's name beside the
 * tunnel, readable by the network the tunnel exists to hide from.
 * Measured on 2026-10-06 for all three engines through finland1. It is
 * still a working endpoint, so it is asked last rather than not at all.
 *
 * Addresses are RFC 5737 stand-ins. */

const FINLAND = "203.0.113.41";
const FRANCE = "203.0.113.42";

const tlsUser = (host: string, serverName: string, protocol = "XRAY_VLESS_TLS") => ({
  protocol,
  connection: { host, port: 2053, security: "TLS", publicParams: { serverName } },
});

const snapshot = {
  protocolUsers: [tlsUser(FINLAND, "fi1.example.test"), tlsUser(FRANCE, "fr1.example.test")],
};

const remembered = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => remembered.get(key),
    set: async (key: string, value: unknown) => void remembered.set(key, value),
    save: async () => undefined,
    delete: async (key: string) => void remembered.delete(key),
  }),
}));
vi.mock("./endpoint-bundle-store", () => ({ bundledBases: async () => [] }));
vi.mock("./credential-cache", () => ({ loadSnapshot: async () => snapshot }));

let endpoints: typeof import("./api-endpoints");

beforeEach(async () => {
  remembered.clear();
  vi.resetModules();
  endpoints = await import("./api-endpoints");
});

const FI_MIRROR = "https://fi1.example.test:2053/api";
const FR_MIRROR = "https://fr1.example.test:2053/api";

describe("the endpoint order with a tunnel up", () => {
  it("connected_server_mirror_is_last_when_around", async () => {
    // The last address that answered was the connected node's own mirror
    // -- the journal's 2026-10-06 case -- so it would lead every race.
    remembered.set("lastGood", FI_MIRROR);
    expect((await endpoints.apiEndpoints())[0]).toBe(FI_MIRROR);

    endpoints.setTunnelServer({ addresses: new Set([FINLAND]), reachedAround: true });
    const ordered = await endpoints.apiEndpoints();

    expect(ordered[ordered.length - 1]).toBe(FI_MIRROR);
    expect(ordered).toEqual([...API_BASE_URLS, FR_MIRROR, FI_MIRROR]);
  });

  it("still_first_for_wireguard", async () => {
    // WireGuard reaches its server through the tunnel, so nothing about the
    // mirror's request is visible beside it, and the order is untouched.
    remembered.set("lastGood", FI_MIRROR);
    endpoints.setTunnelServer({ addresses: new Set([FINLAND]), reachedAround: false });

    expect((await endpoints.apiEndpoints())[0]).toBe(FI_MIRROR);
  });

  /** Source assertions, as in auto-reconnect.wiring.test.ts: the screen
   * needs a Tauri runtime and the service, so what can be pinned is that it
   * tells the order about the server it dials, and forgets it when the
   * tunnel is shown down. */
  it("is told by the Windows screen as each rung is dialled, and forgets on disconnect", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    const dial = dashboard.indexOf('await invoke("vpn_connect", {');
    const told = dashboard.lastIndexOf("setEndpointTunnelServer(tunnelServer);", dial);
    expect(told).toBeGreaterThan(0);
    expect(dashboard.slice(told, dial)).not.toContain("await ");
    expect(dashboard).toContain('if (connectionState === "disconnected") setEndpointTunnelServer(null);');
  });

  it("goes back to the usual order once the tunnel is down", async () => {
    remembered.set("lastGood", FI_MIRROR);
    endpoints.setTunnelServer({ addresses: [FINLAND], reachedAround: true });
    endpoints.setTunnelServer(null);

    expect((await endpoints.apiEndpoints())[0]).toBe(FI_MIRROR);
  });
});
