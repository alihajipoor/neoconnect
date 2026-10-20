import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The phones' byte counts, which the speeds and the session log are made
 * from: the engines' own counts or nothing -- never a zero standing for
 * "not known" (inventory B1; product rule: no number the app has not
 * measured). The native code runs only on a device; these hold what it
 * reports to what the app reads. The Go counters have their own tests in
 * plugins/vpn/xray (counters_test.go, wireguard_totals_test.go). */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const kotlin = source("../../plugins/vpn/android/src/main/java/com/neoxify/vpn/NeoxifyVpnPlugin.kt");
const service = source("../../plugins/vpn/android/src/main/java/com/neoxify/vpn/NeoxifyTunService.kt");
const extension = source("../../plugins/vpn/tunnel/Sources/NeoxifyTunnel/PacketTunnelProvider.swift");
const plugin = source("../../plugins/vpn/ios/Sources/NeoxifyVpnPlugin/NeoxifyVpnPlugin.swift");

describe("Android", () => {
  it("starts every count as unknown, and a count it could not read stays unknown", () => {
    expect(kotlin).toContain("var rx: Long? = null");
    expect(kotlin).toContain("var tx: Long? = null");
    expect(kotlin).not.toMatch(/var rx = 0L|var tx = 0L/);
    expect(kotlin).toMatch(/Log\.w\(TAG, "statistics unavailable", e\)\s+rx = null\s+tx = null/);
  });

  it("takes Xray's count from the tunnel's process, only while fresh", () => {
    expect(kotlin).toContain("NeoxifyTunService.readTraffic(activity)?.let { (r, t, at) ->");
    expect(kotlin).toContain("if (System.currentTimeMillis() - at in 0..TRAFFIC_FRESH_MS) {");
    // Published only while the app is in front to show it, and only a real
    // count: -1 from the engine writes nothing.
    expect(service).toContain("if (Notices.appInFront(this)) {");
    expect(service).toContain("if (up >= 0 && down >= 0) {");
  });

  it("dates the session only for the engine that is up", () => {
    expect(kotlin).toMatch(/wireguardUp -> wireguardSince\s+xrayUp -> NeoxifyTunService\.readSince\(activity\)\s+else -> null/);
    expect(service).toMatch(/writeSince\(this, System\.currentTimeMillis\(\)\)[\s\S]{0,200}publish\(STATE_UP, null\)/);
  });
});

describe("iOS", () => {
  it("asks the extension, which answers with the running engine's count or nothing", () => {
    expect(extension).toContain("override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {");
    expect(extension).toMatch(/guard rx >= 0, tx >= 0 else \{\s+completionHandler\?\(nil\)/);
    expect(plugin).toContain('try session.sendProviderMessage(Data("totals".utf8)) { data in');
  });

  it("waits half a second at most, and says nothing of IKEv2", () => {
    expect(plugin).toContain("DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { finish(nil) }");
    expect(plugin).toContain("if up(tunnel), let session = managers.first?.connection as? NETunnelProviderSession,");
  });
});
