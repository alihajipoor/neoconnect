import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ *
 * The Windows client named the pin over a tunnel the ladder had moved
 * off, after Settings and back (VM, 0.9.51). The phone does not: since
 * 2026-10-07 its screen re-adopts the credential the pass landed on
 * (`passTunnel`, pinned in phone-pass.test.ts). But `passTunnel` lives
 * in the app's memory, and the platform keeps a VPN up when the app is
 * closed -- swiped away on Android, ended on iOS. Opened again, the app
 * had no pass to ask, adopted the platform's "connected", and named the
 * credential its load picked -- the pin -- over a tunnel on another
 * route. The same misnaming, after a restart instead of a remount.
 *
 * The decision is shared with Windows (`credentialOnTunnel` in
 * desktop-windows/src/lib/tunnel-credential.ts, tested there); this pins
 * the phone's wiring of it.
 * ------------------------------------------------------------------ */

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

function body(signature: string): string {
  const start = dashboard.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  return dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
}

describe("the phone names the route a tunnel found up is on", () => {
  const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
  const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");

  it("records each dial where an app opened later can find it, on disk before the engine can come up", () => {
    // Awaited: an app ended while the engine came up leaves the tunnel up,
    // and a record still on the dial before would name it.
    const recorded = walk.indexOf("await tunnelCredential.dialling(candidate);");
    expect(recorded).toBeGreaterThan(0);
    expect(dashboard.split("tunnelCredential.dialling(").length - 1).toBe(1);
    // Ahead of the last check for a stop or a sign-out, so nothing is
    // awaited between that check and the dial.
    const check = walk.indexOf('if (sessionGeneration() !== sessionAtStart) return "failed";', recorded);
    const unproven = walk.indexOf('passTunnel.current = "unproven";', recorded);
    const dial = walk.indexOf("await connectIkev2({", recorded);
    expect(check).toBeGreaterThan(recorded);
    expect(walk.slice(recorded, check)).not.toContain("pass.stopped()");
    expect(unproven).toBeGreaterThan(check);
    expect(dial).toBeGreaterThan(unproven);
    expect(walk.slice(unproven, dial)).not.toContain("await ");
  });

  it("fails closed: a load that puts the pin on screen names no tunnel by it", () => {
    expect(dashboard).toContain("const [tunnelRouteUnknown, setTunnelRouteUnknown] = useState(true);");
    const cached = body("  async function showCached(");
    expect(cached.indexOf("setTunnelRouteUnknown(true);")).toBeGreaterThan(cached.indexOf("cached.protocolUsers.find((u) => u.routeId === preferred)"));
    expect(cached.indexOf("setTunnelRouteUnknown(true);")).toBeLessThan(cached.indexOf("await adoptPlatform("));
    const load = body("  async function loadScreen(");
    const pin = load.indexOf("usersResult.data.find((u) => u.routeId === chosen)");
    expect(pin).toBeGreaterThan(0);
    expect(load.indexOf("setTunnelRouteUnknown(true);", pin)).toBeGreaterThan(pin);
    expect(load.indexOf("setTunnelRouteUnknown(true);", pin)).toBeLessThan(load.indexOf("await adoptPlatform("));
  });

  // iOS said whether a tunnel was up and nothing about which: every
  // recorded dial passed the protocol check. Its two configurations --
  // IKEv2 through the system, Xray and WireGuard through our extension --
  // can each be started from iOS Settings, so the last dial an IKEv2 rung
  // and a tunnel-provider configuration holding an earlier Xray rung
  // started there named the IKEv2 dial's country over it. The Swift is
  // not compiled here; this pins what it says.
  it("hears from iOS which protocol is up, as from Android", () => {
    const swift = readFileSync(
      new URL("../../plugins/vpn/ios/Sources/NeoxifyVpnPlugin/NeoxifyVpnPlugin.swift", import.meta.url),
      "utf8",
    );
    const status = swift.slice(swift.indexOf("@objc public func status(_ invoke: Invoke) {"));
    expect(status).toContain("running = providerProtocol(managers.first)");
    expect(status).toContain('running = "IKEV2"');
    expect(status).toContain("running = NSNull()");
    expect(status).toContain('"protocol": running,');
    // The tunnel provider's, kept beside its engine's keys at each start --
    // the client's own name from the Xray profile, WIREGUARD for WireGuard
    // -- and for a configuration saved before that, a name no dial
    // carries, so no dial is taken for its route.
    expect(swift).toContain("let `protocol`: String?");
    expect(swift).toContain("stored[providerProtocolKey] = named");
    expect(swift).toContain('proto.providerConfiguration = ["wireguard": json, providerProtocolKey: "WIREGUARD"]');
    expect(swift).toContain('return "UNRECORDED"');
    // The Xray profile the bridge sends carries it.
    const bridge = readFileSync(new URL("../../plugins/vpn/src/lib.rs", import.meta.url), "utf8");
    const xray = bridge.slice(bridge.indexOf("pub struct XrayProfile {"));
    expect(xray.slice(0, xray.indexOf("}"))).toContain("pub protocol: String,");
  });

  it("asks the record only when no pass of this app has said, first", () => {
    const read = adopt.indexOf("const dial = passTunnel.current === null ? await tunnelCredential.last() : null;");
    expect(read).toBeGreaterThan(0);
    // Before the checks for a pass or a press and the stamps, so none of
    // them is taken before a wait.
    expect(read).toBeLessThan(adopt.indexOf("if (passInFlight() || pressElsewhere) {"));
    expect(read).toBeLessThan(adopt.indexOf("await withTimeout(vpnStatus()"));
    expect(read).toBeLessThan(adopt.indexOf("const reconnectStamp = autoReconnect.stamp();"));
  });

  it("names the pass's landing first, the recorded dial when no pass has said, and no route when neither can", () => {
    expect(adopt).toContain(
      "const landedOn = landed === null ? null : (users.find((u) => u.id === landed.id) ?? null);",
    );
    expect(adopt).toContain(
      "const on = landedOn ?? (left === null ? credentialOnTunnel(dial, platformProtocol, users) : null);",
    );
    expect(adopt).toContain("if (on !== null) setProtocolUser(on);");
    expect(adopt).toContain("setTunnelRouteUnknown(on === null);");
    // A tunnel no pass of this app landed is proven against no baseline:
    // its success would otherwise be judged against another network's.
    expect(adopt).toContain("setBaselineIp(landedOn !== null ? ladderPass.baseline.current : null);");
  });

  it("lets the pass's own landing name its route again", () => {
    const named = walk.indexOf("setProtocolUser(candidate);");
    expect(walk.slice(named, named + 120)).toContain("setTunnelRouteUnknown(false);");
  });

  it("names no server, no protocol and no current row for a tunnel it cannot name", () => {
    expect(dashboard).toContain("const tunnelNamed = !tunnelRouteUnknown;");
    expect(dashboard).toMatch(
      /displayedRoute\(\s*routes,\s*connectionState,\s*protocolUser\?\.routeId,\s*chosenRouteId,\s*protocolUser\?\.routeId,\s*tunnelNamed,\s*\)/,
    );
    // The location card's protocol and the list's current row ("Connected
    // here") by the same rule as the place (displayed-route.ts), not from
    // the credential the screen holds, which after a load is the pin.
    expect(dashboard).toContain(
      "const screenRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed);",
    );
    expect(dashboard).toContain(
      "const shownProtocol = displayedProtocol(connectionState, protocolUser, chosenRouteId, protocolUsers, routes, tunnelNamed);",
    );
    expect(dashboard).toContain("currentRouteId={screenRouteId ?? undefined}");
    expect(dashboard).not.toMatch(/currentRouteId=\{protocolUser/);
    // And credits no route with a session it cannot name.
    expect(dashboard).toContain("settledRouteRef.current = tunnelRouteUnknown ? null : (protocolUser?.routeId ?? null);");
  });
});
