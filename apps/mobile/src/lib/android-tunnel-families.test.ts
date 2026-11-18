import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TUN_DNS } from "./xray-config";

/** IPv6 under the Android tunnels: what was measured, and the lines it
 * rests on.
 *
 * Android blocks an address family for a VPN's apps when the VPN is given
 * no address, route or DNS server of that family. It unblocks the family,
 * to fall through to the network underneath, the moment the VPN is given
 * one of the three or `allowFamily` is called. That is
 * `VpnService.Builder`'s own documentation, and `Vpn.makeLinkProperties`
 * in Android's source. The Xray tunnel is IPv4 only and depends on the
 * first half of it.
 *
 * Measured on 2026-11-18 on the emulator (Android 16, kernel 6.6, on a
 * line with working IPv6), with a capture on the guest's Wi-Fi interface.
 * The service code is the released 0.2.41's, unchanged.
 *
 *   - Xray tunnel: the VPN's routing table holds `unreachable ::/0`. A
 *     new IPv6 connection fails at once with "no route to host" for this
 *     app's uid, another app's and root. IPv4 leaves at the node's
 *     address.
 *   - Connections opened before the tunnel: Android closes every other
 *     app's and leaves this app's alone, because it exempts the VPN's
 *     owner. Those carried nothing further. No packet of theirs was on
 *     the outside interface after the tunnel was established.
 *   - WireGuard and IKEv2 are given a `::/0` route, so IPv6 goes into the
 *     tunnel and is dropped there. Slow to fail, but not outside.
 *
 * What does get out, and is Android's to stop rather than ours: a socket
 * bound to the outside interface (SO_BINDTODEVICE). From this app's own
 * uid such a socket works in both directions, so nothing in the app may
 * bind one. From another app the packet leaves and its answer is
 * dropped.
 *
 * Not measured: any other Android version, a real phone, mobile data.
 *
 * These are not tests of Android. They hold the few lines whose change
 * would undo the above with no other test noticing. */

const kotlin = (name: string) =>
  readFileSync(new URL(`../../plugins/vpn/android/src/main/java/com/neoxify/vpn/${name}`, import.meta.url), "utf8");

/** Source without its comments, so that a word in a comment proves
 * nothing either way. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const service = code(kotlin("NeoxifyTunService.kt"));
const plugin = code(kotlin("NeoxifyVpnPlugin.kt"));
const ikev2 = code(kotlin("Ikev2Engine.kt"));

describe("the Xray tunnel leaves IPv6 to Android's block", () => {
  it("is given one IPv4 address and the IPv4 default route, and nothing else", () => {
    expect(service.match(/\.addAddress\(/g)).toHaveLength(1);
    expect(service.match(/\.addRoute\(/g)).toHaveLength(1);
    expect(service).toContain('.addAddress("172.19.0.1", 30)');
    expect(service).toContain('.addRoute("0.0.0.0", 0)');
  });

  // The third way to unblock a family, and the easy one to take by
  // accident: one IPv6 resolver added "as a fallback" removes the
  // `unreachable ::/0` and every app's IPv6 goes round the tunnel.
  it("is given an IPv4 DNS server", () => {
    expect(service.match(/\.addDnsServer\(/g)).toHaveLength(1);
    expect(service).toContain(".addDnsServer(dns)");
    const fallback = service.match(/getStringExtra\(EXTRA_DNS\)\s*\?:\s*"([^"]+)"/);
    expect(fallback?.[1]).toMatch(IPV4);
    expect(TUN_DNS).toMatch(IPV4);
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    const connect = dashboard.slice(dashboard.indexOf("await connectXray({"));
    expect(connect.slice(0, connect.indexOf("});"))).toContain("dns: TUN_DNS,");
  });
});

describe("no engine lifts the block or lets an app out", () => {
  it.each([
    ["NeoxifyTunService.kt", service],
    ["NeoxifyVpnPlugin.kt", plugin],
    ["Ikev2Engine.kt", ikev2],
  ])("%s", (_name, source) => {
    expect(source).not.toMatch(/\b(allowFamily|allowBypass|addDisallowedApplication|excludeRoute)\s*\(/);
    expect(source).not.toContain("ExcludedApplications");
  });

  it("IKEv2 is not bypassable", () => {
    expect(ikev2).toContain(".setBypassable(false)");
    expect(ikev2).not.toMatch(/setBypassable\(\s*true/);
  });

  // The WireGuard library applies its own rule (GoBackend): unless one
  // peer carries a default route, it calls `allowFamily` for both
  // families, and whatever the routes do not cover goes round the tunnel.
  it("WireGuard is handed a default route for both families, as the server wrote it", () => {
    const credentials = readFileSync(
      new URL("../../../backend/src/modules/protocol-users/generate-credentials.ts", import.meta.url),
      "utf8",
    );
    expect(credentials).toContain('allowedIPs: "0.0.0.0/0, ::/0"');
    expect(plugin).toContain('append("AllowedIPs = ").append(p.allowedIPs)');
    expect(plugin.match(/\[Peer\]/g)).toHaveLength(1);
  });
});

describe("nothing in the app binds a socket to an interface", () => {
  // This app owns the VPN, so Android applies none of its filters to it:
  // measured, a socket of this uid bound to the Wi-Fi interface reached
  // the internet with the line's own address while the tunnel was up.
  const BINDS = /bind_device|SO_BINDTODEVICE|IP_BOUND_IF|IP_UNICAST_IF|\.interface\(|bindSocket\(|bindProcessToNetwork\(/;

  it("in the Rust compiled into the phone app", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const shared = [...lib.matchAll(/#\[path = "([^"]+)"\]/g)].map((m) => m[1]!);
    // The files lib.rs pulls in from the Windows app; the list is read
    // from it so that a new one is covered the day it is added.
    expect(shared.length).toBeGreaterThanOrEqual(5);
    const files = [
      ...["lib.rs", "latency.rs", "main.rs"].map((name) => `../../src-tauri/src/${name}`),
      ...shared.map((path) => `../../src-tauri/src/${path}`),
    ];
    for (const file of files) {
      expect(code(readFileSync(new URL(file, import.meta.url), "utf8")), file).not.toMatch(BINDS);
    }
  });

  it("in the Android plugin", () => {
    for (const source of [service, plugin, ikev2]) expect(source).not.toMatch(BINDS);
  });
});
