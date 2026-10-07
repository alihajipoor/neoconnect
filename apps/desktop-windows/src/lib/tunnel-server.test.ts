import { afterEach, describe, expect, it, vi } from "vitest";

/** Which addresses a credential's tunnel is dialled at -- what the egress
 * check passes over, because the client routes them around the tunnel.
 * `resolve_ipv4` (health_ip.rs, tested there against this machine's
 * resolver) is stood in for. Addresses are RFC 5737 stand-ins. */

const resolved = new Map<string, string[] | "fails">();
const asked: { host: string; timeoutMs: number }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { host: string; timeoutMs: number }) => {
    if (command !== "resolve_ipv4") return Promise.reject(new Error(`unexpected ${command}`));
    asked.push(args);
    const answer = resolved.get(args.host);
    return answer === undefined || answer === "fails" ? Promise.reject("no answer") : Promise.resolve(answer);
  },
}));

const { hostOfEndpoint, isAddressLiteral, serverHostsOf, tunnelServerOf, RESOLVE_TIMEOUT_MS } = await import(
  "./tunnel-server"
);

const NODE = "203.0.113.41";

afterEach(() => {
  resolved.clear();
  asked.length = 0;
});

describe("serverHostsOf", () => {
  it("names every host an engine may dial, once", () => {
    // Xray dials `connection.host`; IKEv2 the certificate name; WireGuard
    // and OpenVPN the host in `credentials.endpoint`.
    expect(
      serverHostsOf({
        connection: { host: NODE, publicParams: { endpointHost: "fi1.example.test" } },
        credentials: { endpoint: `${NODE}:51820` },
      }),
    ).toEqual([NODE, "fi1.example.test"]);
  });

  it("copes with a credential that names nothing", () => {
    expect(serverHostsOf({})).toEqual([]);
    expect(serverHostsOf({ connection: null, credentials: null })).toEqual([]);
    expect(serverHostsOf({ connection: { host: " ", publicParams: { endpointHost: 7 } } })).toEqual([]);
  });
});

describe("hostOfEndpoint", () => {
  it("takes the host from host:port, [v6]:port and a bare host", () => {
    expect(hostOfEndpoint(`${NODE}:1194`)).toBe(NODE);
    expect(hostOfEndpoint("vpn.example.test:443")).toBe("vpn.example.test");
    expect(hostOfEndpoint("[2001:db8::1]:51820")).toBe("2001:db8::1");
    expect(hostOfEndpoint("2001:db8::1")).toBe("2001:db8::1");
    expect(hostOfEndpoint(NODE)).toBe(NODE);
  });
});

describe("isAddressLiteral", () => {
  it("tells an address from a name", () => {
    expect(isAddressLiteral(NODE)).toBe(true);
    expect(isAddressLiteral("2001:db8::1")).toBe(true);
    expect(isAddressLiteral("[2001:db8::1]")).toBe(true);
    expect(isAddressLiteral("fi1.example.test")).toBe(false);
    expect(isAddressLiteral("203.0.113.41.example.test")).toBe(false);
  });
});

describe("tunnelServerOf", () => {
  it("takes an address as it is, asking no resolver", async () => {
    await expect(tunnelServerOf({ connection: { host: NODE } })).resolves.toEqual(new Set([NODE]));
    expect(asked).toEqual([]);
  });

  it("resolves a name the way the engines do, within a bound", async () => {
    resolved.set("fi1.example.test", [NODE, "203.0.113.42"]);
    await expect(
      tunnelServerOf({ connection: { host: NODE, publicParams: { endpointHost: "fi1.example.test" } } }),
    ).resolves.toEqual(new Set([NODE, "203.0.113.42"]));
    expect(asked).toEqual([{ host: "fi1.example.test", timeoutMs: RESOLVE_TIMEOUT_MS }]);
  });

  it("knows nothing of a name that does not resolve, and does not throw", async () => {
    resolved.set("gone.example.test", "fails");
    await expect(
      tunnelServerOf({ connection: { host: NODE, publicParams: { endpointHost: "gone.example.test" } } }),
    ).resolves.toEqual(new Set([NODE]));
    await expect(tunnelServerOf({ connection: { host: "gone.example.test" } })).resolves.toEqual(new Set());
  });
});
