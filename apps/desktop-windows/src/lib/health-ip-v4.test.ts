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

type Reply = { status: number; body: unknown } | "no answer";
const replies = new Map<string, Reply>();
const calls: { base: string; timeoutMs: number }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { base: string; timeoutMs: number }) => {
    if (command === "probe_ipv4_egress") return Promise.resolve(false);
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

  it("tells an error page from silence, as it did through fetch", async () => {
    endpoints.mockResolvedValue([CDN, MIRROR]);
    const baseline = { ip: "192.0.2.228", from: CDN };

    replies.set(CDN, { status: 502, body: null });
    replies.set(MIRROR, { status: 502, body: null });
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "indeterminate", exitIp: null });

    replies.clear();
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "unreachable" });
  });

  it("moves on past an endpoint that answered without an address", async () => {
    endpoints.mockResolvedValue([CDN, MIRROR]);
    replies.set(CDN, { status: 200, body: null });
    replies.set(MIRROR, { status: 200, body: { ip: "203.0.113.20" } });
    await expect(captureBaselineIp()).resolves.toEqual({ ip: "203.0.113.20", from: MIRROR });
  });

  it("is installed before the app renders", () => {
    // The whole fix rests on this one line in the Windows entry point;
    // without it the check silently goes back to the plugin's fetch.
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toContain("setHealthIpTransport(ipv4OnlyHealthIp);");
    expect(main.indexOf("setHealthIpTransport(ipv4OnlyHealthIp);")).toBeLessThan(main.indexOf(".render("));
  });
});
