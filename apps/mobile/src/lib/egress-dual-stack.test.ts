import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/** A dual-stack phone, through the real shared egress check and these
 * rules, with only the network stood in for.
 *
 * The phone has IPv6 and the API has AAAA records. With no tunnel up the
 * system picks IPv6, so a baseline asked through the plugin's fetch is
 * the phone's IPv6 address. Every reading through the tunnel is IPv4 --
 * Android's VpnService blocks the family it was not given, and iOS
 * claims IPv6 only so it cannot leave beside the tunnel. `verifyEgress`
 * will not compare two families, so every rung read "indeterminate":
 * each one with another to try was torn down as not carrying, and the
 * last landed "not confirmed" for the whole session. The fix is the
 * Windows client's: ask `/health/ip` over IPv4 only (`health_ip_v4`,
 * compiled into this app by path, installed from main.tsx).
 *
 * Addresses are RFC 5737/3849 stand-ins. Nothing here has run on a
 * phone; what the transport does on a real socket is shown by
 * health_ip.rs's own tests, which also run in this app's crate. */

const CDN = "https://api.example.test";
/** The phone's own addresses on its dual-stack network. */
const PHONE_V6 = "2001:db8:1::7";
const PHONE_V4 = "192.0.2.44";
/** The node's exit, IPv4 only. */
const EXIT_V4 = "203.0.113.9";

/** What the tunnel does to the phone's traffic right now. */
let tunnel: "down" | "carrying" | "bypassed" = "down";

vi.mock("@shared/lib/api-endpoints", () => ({ apiEndpoints: async () => [CDN] }));
vi.mock("@shared/lib/network-identity", () => ({ rememberNetwork: () => undefined }));

/** The plugin's fetch: the system picks the family, so IPv6 while the
 * bare network has it. */
const pluginFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ip: tunnel === "carrying" ? EXIT_V4 : tunnel === "bypassed" ? PHONE_V4 : PHONE_V6 }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetch }));

/** `health_ip_v4`: IPv4 only, whatever else the network has. The phone
 * registers no `probe_ipv4_egress`. */
const v4Calls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { base: string }) => {
    if (command !== "health_ip_v4") throw new Error(`${command} is not registered on the phone`);
    v4Calls.push(args.base);
    return { status: 200, body: { ip: tunnel === "carrying" ? EXIT_V4 : PHONE_V4 } };
  },
}));

const { captureBaselineIp, setHealthIpTransport } = await import("@shared/lib/egress");
const { ipv4OnlyHealthIp } = await import("@shared/lib/health-ip-v4");
const { confirmEgress, pollEgress, pollState, rejectionIsEvidence, rungOutcome } = await import("./tunnel-evidence");

const quick = { intervalMs: 5, timeoutMs: 40 };

// In this order: the module starts on the plugin's fetch, as the phones
// did, and the second block installs what main.tsx now installs.
describe("on the plugin's fetch, as the phones were", () => {
  it("rejected a working tunnel on every rung with another to try", async () => {
    tunnel = "down";
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: PHONE_V6, from: CDN });

    tunnel = "carrying";
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict).toEqual({ state: "indeterminate", exitIp: EXIT_V4 });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("notCarrying");
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("unverified");
  });
});

describe("over IPv4 only, as main.tsx installs it", () => {
  it("proves a working tunnel on the first rung", async () => {
    setHealthIpTransport(ipv4OnlyHealthIp);
    pluginFetch.mockClear();

    tunnel = "down";
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: PHONE_V4, from: CDN });

    tunnel = "carrying";
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: EXIT_V4 });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("connected");

    // And the health poll: proof, so an Xray tunnel reads "protected"
    // rather than "not confirmed" for the whole session.
    const poll = await pollEgress(baseline);
    expect(pollState("unverified", poll)).toBe("connected");

    expect(pluginFetch).not.toHaveBeenCalled();
    expect(v4Calls.length).toBeGreaterThan(0);
  });

  it("still catches IPv4 going round the tunnel", async () => {
    tunnel = "down";
    const baseline = await captureBaselineIp();
    tunnel = "bypassed";
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict).toEqual({ state: "bypassingTunnel", exitIp: PHONE_V4 });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: true })).toBe("notCarrying");
    expect(rejectionIsEvidence(verdict!)).toBe(true);
  });
});

describe("the wiring that makes it so", () => {
  // Either line missing and the check quietly goes back to the plugin's
  // fetch, or asks a command that is not there and never has a baseline.
  it("installs the IPv4 transport before the app renders", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const install = "setHealthIpTransport(ipv4OnlyHealthIp);";
    expect(main).toContain(install);
    expect(main.indexOf(install)).toBeLessThan(main.indexOf(".render("));
  });

  it("registers the command it asks, compiled from the Windows app's file", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toMatch(/#\[path = "\.\.\/\.\.\/\.\.\/desktop-windows\/src-tauri\/src\/health_ip\.rs"\]\s*mod health_ip;/);
    const handler = lib.slice(lib.indexOf("generate_handler!["));
    expect(handler.slice(0, handler.indexOf("])"))).toContain("health_ip::health_ip_v4");
  });
});
