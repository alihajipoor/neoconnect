import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The Windows client's egress check, driven through the transport it
 * actually uses: `health_ip_v4` in the Rust side, which asks over IPv4
 * only. That command's own behaviour -- that it never reaches an IPv6
 * address -- is shown in `src-tauri/src/health_ip.rs` against this
 * machine's loopback. What is pinned here is the wiring: the check goes
 * through it, and reads its answers the way it read fetch's. */

const endpoints = vi.fn<() => Promise<string[]>>();
vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));

type Reply = { status: number; body: unknown; peer?: string } | "no answer";
const replies = new Map<string, Reply>();
const calls: { base: string; timeoutMs: number }[] = [];
/** What `probe_ipv4_egress` -- a verified TLS handshake with a public
 * resolver -- answers. */
let internet = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { base: string; timeoutMs: number }) => {
    if (command === "probe_ipv4_egress") return Promise.resolve(internet);
    if (command !== "health_ip_v4") return Promise.reject(new Error(`unexpected ${command}`));
    calls.push(args);
    const reply = replies.get(args.base);
    if (reply === undefined || reply === "no answer") return Promise.reject("no answer");
    return Promise.resolve(reply);
  },
}));

/** The plugin's fetch lets the system pick the family. Once the IPv4
 * transport is installed, nothing may reach it. */
const pluginFetch = vi.fn(() => Promise.reject(new Error("tauri-plugin-http must not be used")));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetch }));

const { captureBaselineIp, setHealthIpTransport, verifyEgress } = await import("./egress");
const { ipv4OnlyHealthIp } = await import("./health-ip-v4");
setHealthIpTransport(ipv4OnlyHealthIp);

const CDN = "https://connect.neoxify.site/api";
const MIRROR = "https://mirror.example.net:2053/api";

afterEach(() => {
  endpoints.mockReset();
  replies.clear();
  calls.length = 0;
  internet = false;
  pluginFetch.mockClear();
});

describe("the egress check on Windows", () => {
  it("asks through the IPv4-only command, never the plugin's fetch", async () => {
    endpoints.mockResolvedValue([CDN]);
    replies.set(CDN, { status: 200, body: { ip: "192.0.2.228", asn: 64500 } });
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: "192.0.2.228", from: CDN });

    replies.set(CDN, { status: 200, body: { ip: "203.0.113.10" } });
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "throughTunnel", exitIp: "203.0.113.10" });

    expect(calls.map((c) => c.base)).toEqual([CDN, CDN]);
    expect(calls.every((c) => c.timeoutMs > 0)).toBe(true);
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it("leaves an answer with no address to the public-internet probe", async () => {
    // On Windows an error page from ours is not the verdict: the probe
    // is. Through a working tunnel during an outage of ours the resolvers
    // answer, and there is no verdict; with them silent too the tunnel is
    // dead, whatever the connected node's own mirror (routed around the
    // tunnel) said.
    endpoints.mockResolvedValue([CDN, MIRROR]);
    const baseline = { ip: "192.0.2.228", from: CDN };

    replies.set(CDN, { status: 502, body: null });
    replies.set(MIRROR, { status: 502, body: null });
    internet = true;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: null });
    internet = false;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "unreachable" });

    replies.clear();
    internet = true;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: null });
    internet = false;
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "unreachable" });
  });

  it("moves on past an endpoint that answered without an address", async () => {
    endpoints.mockResolvedValue([CDN, MIRROR]);
    replies.set(CDN, { status: 200, body: null });
    replies.set(MIRROR, { status: 200, body: { ip: "203.0.113.20" } });
    await expect(captureBaselineIp()).resolves.toEqual({ ip: "203.0.113.20", from: MIRROR });
  });

  it("keeps the address the command connected to, and passes over the tunnel's own server", async () => {
    // `health_ip_v4` reports where the request actually went. The
    // connected node's own mirror is reached around the tunnel and
    // answers with the customer's home address; through this transport
    // it is recognised and the next endpoint asked.
    endpoints.mockResolvedValue([MIRROR, CDN]);
    replies.set(MIRROR, { status: 200, body: { ip: "192.0.2.228" }, peer: "203.0.113.41" });
    replies.set(CDN, { status: 200, body: { ip: "203.0.113.41" }, peer: "198.51.100.10" });
    await expect(captureBaselineIp()).resolves.toEqual({ ip: "192.0.2.228", from: MIRROR, peer: "203.0.113.41" });
    await expect(
      verifyEgress({ ip: "192.0.2.228", from: CDN, peer: "198.51.100.10" }, { tunnelServer: ["203.0.113.41"] }),
    ).resolves.toEqual({ state: "throughTunnel", exitIp: "203.0.113.41" });
  });

  it("is installed before the app renders", () => {
    // The whole fix rests on this one line in the Windows entry point;
    // without it the check silently goes back to the plugin's fetch.
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toContain("setHealthIpTransport(ipv4OnlyHealthIp);");
    expect(main.indexOf("setHealthIpTransport(ipv4OnlyHealthIp);")).toBeLessThan(main.indexOf(".render("));
  });
});
