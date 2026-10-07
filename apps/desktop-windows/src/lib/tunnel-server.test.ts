import { afterEach, describe, expect, it, vi } from "vitest";

/** Which addresses a credential's tunnel is dialled at, and whether the
 * client reaches them around the tunnel -- what the egress check needs
 * to know about the tunnel's own server (`TunnelServer` in egress.ts).
 * `resolve_ipv4` (health_ip.rs, tested there against this machine's
 * resolver) is stood in for. Addresses are RFC 5737 stand-ins. */

const resolved = new Map<string, string[] | "fails" | "hangs">();
const asked: { host: string; timeoutMs: number }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { host: string; timeoutMs: number }) => {
    if (command !== "resolve_ipv4") return Promise.reject(new Error(`unexpected ${command}`));
    asked.push(args);
    const answer = resolved.get(args.host);
    if (answer === "hangs") return new Promise(() => undefined);
    return answer === undefined || answer === "fails" ? Promise.reject("no answer") : Promise.resolve(answer);
  },
}));

const {
  hostOfEndpoint,
  isAddressLiteral,
  literalTunnelServer,
  nodeAddressesOf,
  reachesServerAround,
  serverHostsOf,
  tunnelServerOf,
  RESOLVE_TIMEOUT_MS,
} = await import("./tunnel-server");

const NODE = "203.0.113.41";

afterEach(() => {
  vi.useRealTimers();
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

describe("reachesServerAround", () => {
  it("on Windows: around for every engine the service or the system routes around, through for WireGuard", () => {
    // Xray: the service's host route, measured for Stealth. OpenVPN and
    // IKEv2: their own host routes, not measured. WireGuard: wireguard.exe
    // binds its socket instead and installs no route for the endpoint --
    // from upstream's design, not measured.
    for (const protocol of [
      "XRAY_VLESS_REALITY",
      "XRAY_VLESS_TLS",
      "XRAY_VMESS",
      "XRAY_TROJAN",
      "SHADOWSOCKS",
      "OPENVPN",
      "IKEV2",
    ]) {
      expect(reachesServerAround("windows", protocol), protocol).toBe(true);
    }
    expect(reachesServerAround("windows", "WIREGUARD")).toBe(false);
  });

  it("on the phones: through for Xray and WireGuard, around for the system's IKEv2", () => {
    // Android's VpnService routes 0.0.0.0/0 into the tunnel and protects
    // only the engine's sockets; iOS claims the default route with a
    // made-up tunnelRemoteAddress. From the source, not measured.
    for (const protocol of ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_TROJAN", "SHADOWSOCKS", "WIREGUARD"]) {
      expect(reachesServerAround("phone", protocol), protocol).toBe(false);
    }
    expect(reachesServerAround("phone", "IKEV2")).toBe(true);
  });

  it("takes anything it does not know to be around: its mistake costs 'not confirmed', not an accusation", () => {
    expect(reachesServerAround("phone", undefined)).toBe(true);
    expect(reachesServerAround("phone", "SOMETHING_NEW")).toBe(true);
    expect(reachesServerAround("windows", undefined)).toBe(true);
    expect(reachesServerAround("windows", "SOMETHING_NEW")).toBe(true);
  });
});

describe("literalTunnelServer", () => {
  it("takes the literals and asks no resolver", () => {
    expect(
      literalTunnelServer(
        {
          protocol: "IKEV2",
          connection: { host: NODE, publicParams: { endpointHost: "fi1.example.test" } },
          credentials: { endpoint: "[2001:db8::1]:500" },
        },
        "phone",
      ),
    ).toEqual({ addresses: new Set([NODE, "2001:db8::1"]), reachedAround: true });
    expect(asked).toEqual([]);
  });
});

describe("tunnelServerOf", () => {
  it("takes an address as it is, asking no resolver", async () => {
    await expect(tunnelServerOf({ protocol: "XRAY_VLESS_TLS", connection: { host: NODE } }, "windows")).resolves.toEqual(
      { addresses: new Set([NODE]), reachedAround: true },
    );
    await expect(tunnelServerOf({ protocol: "XRAY_VLESS_TLS", connection: { host: NODE } }, "phone")).resolves.toEqual({
      addresses: new Set([NODE]),
      reachedAround: false,
    });
    expect(asked).toEqual([]);
  });

  it("resolves a name the way the engines do, within a bound", async () => {
    resolved.set("fi1.example.test", [NODE, "203.0.113.42"]);
    await expect(
      tunnelServerOf(
        { protocol: "IKEV2", connection: { host: NODE, publicParams: { endpointHost: "fi1.example.test" } } },
        "phone",
      ),
    ).resolves.toEqual({ addresses: new Set([NODE, "203.0.113.42"]), reachedAround: true });
    expect(asked).toEqual([{ host: "fi1.example.test", timeoutMs: RESOLVE_TIMEOUT_MS }]);
  });

  it("knows nothing of a name that does not resolve, and does not throw", async () => {
    resolved.set("gone.example.test", "fails");
    await expect(
      tunnelServerOf({ connection: { host: NODE, publicParams: { endpointHost: "gone.example.test" } } }, "windows"),
    ).resolves.toEqual({ addresses: new Set([NODE]), reachedAround: true });
    await expect(tunnelServerOf({ connection: { host: "gone.example.test" } }, "windows")).resolves.toEqual({
      addresses: new Set(),
      reachedAround: true,
    });
  });

  it("does not wait on a lookup that never comes back", async () => {
    // The command is bounded in Rust; a call that never returns at all
    // -- a wedged IPC, say -- must not hold a rung forever.
    vi.useFakeTimers();
    resolved.set("stuck.example.test", "hangs");
    let result: unknown = "pending";
    void tunnelServerOf(
      { protocol: "IKEV2", connection: { host: NODE, publicParams: { endpointHost: "stuck.example.test" } } },
      "windows",
      500,
    ).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(400);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(result).toEqual({ addresses: new Set([NODE]), reachedAround: true });
  });
});

describe("nodeAddressesOf", () => {
  it("collects every credential's node address once", () => {
    expect(
      nodeAddressesOf([{ connection: { host: NODE } }, { connection: { host: ` ${NODE} ` } }, { connection: null }, {}]),
    ).toEqual(new Set([NODE]));
  });
});
