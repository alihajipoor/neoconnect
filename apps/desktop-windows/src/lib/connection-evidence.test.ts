import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  combineEvidence,
  customModePollState,
  fullTunnelPollState,
  handshakeEvidence,
  isTunnelUp,
  stateFromStatus,
  type VpnStatus,
} from "./connection-evidence";
import type { EgressVerdict } from "./egress";
import type { ConnectionState } from "../components/ConnectOrb";

/** A status of the shape the helper service actually sends.
 *
 * `unknown` is the default because it is what three of the four
 * protocols report for as long as their process is alive -- Xray,
 * OpenVPN and IKEv2 all land there (`engines/mod.rs`, the `Active::Child`
 * and `Active::Ikev2` arms). WireGuard is the exception, not the rule.
 */
function status(over: Partial<VpnStatus> = {}): VpnStatus {
  return { connected: true, protocol: "XRAY_VLESS_REALITY", health: { state: "unknown" }, ...over };
}

/* ------------------------------------------------------------------ *
 * The controls.
 *
 * Each is the rule as it shipped in 0.9.29, written out here rather than
 * described, so every assertion below can be shown to distinguish the
 * two. A test that passes against both is not testing the fix.
 * ------------------------------------------------------------------ */

/** `stateFromStatus` as it was: a `default:` arm that swallowed
 * `unknown` -- and `down` with it -- into "connected". */
function stateFromStatus_0929(s: VpnStatus): ConnectionState {
  if (!s.connected) return "disconnected";
  switch (s.health.state) {
    case "stale":
    case "neverHandshaked":
      return "degraded";
    default:
      return "connected";
  }
}

/** The health poll's Custom-mode branch as it was. The probe result was
 * computed and then discarded whenever the engine reported up. */
function customModePoll_0929(fromStatus: ConnectionState, _probeCarried: boolean): ConnectionState {
  if (fromStatus === "disconnected") return "disconnected";
  if (fromStatus === "connected") return "connected";
  return "degraded";
}

/** The health poll's full-tunnel branch as it was: `indeterminate`
 * counted as carrying traffic. */
function fullTunnelPoll_0929(fromStatus: ConnectionState, egress: EgressVerdict): ConnectionState {
  const carrying = egress.state === "throughTunnel" || egress.state === "indeterminate";
  return carrying && fromStatus === "connected" ? "connected" : "degraded";
}

describe("what the service's health field is worth as evidence", () => {
  it("does not treat an engine that is merely running as a working tunnel", () => {
    // The defect, at its source. `unknown` is the service saying it
    // gathered nothing -- there is no cheap handshake to read for Xray,
    // OpenVPN or IKEv2 -- and it holds for as long as the process is
    // alive, which is to say indefinitely.
    expect(handshakeEvidence(status())).toBe("silent");
    expect(stateFromStatus(status())).toBe("unverified");

    // Control: the shipped rule called the same status "connected", so a
    // customer whose Xray tunnel had stopped carrying anything read
    // "You're protected" for as long as xray.exe stayed up.
    expect(stateFromStatus_0929(status())).toBe("connected");
  });

  it("still trusts a live handshake, which is real evidence", () => {
    // The other direction matters just as much. WireGuard can prove the
    // far end is talking to us, and downgrading that to `unverified`
    // would cry wolf on the one protocol that can answer the question.
    const wg = status({ protocol: "WIREGUARD", health: { state: "alive", age_secs: 12 } });
    expect(handshakeEvidence(wg)).toBe("proves");
    expect(stateFromStatus(wg)).toBe("connected");
  });

  it("still calls a stale handshake what it is", () => {
    const stale = status({ protocol: "WIREGUARD", health: { state: "stale", age_secs: 400 } });
    expect(handshakeEvidence(stale)).toBe("refutes");
    expect(stateFromStatus(stale)).toBe("degraded");
    const never = status({ protocol: "WIREGUARD", health: { state: "neverHandshaked" } });
    expect(stateFromStatus(never)).toBe("degraded");
  });

  it("reports nothing running as disconnected, whatever health says", () => {
    expect(stateFromStatus(status({ connected: false, health: { state: "down" } }))).toBe(
      "disconnected",
    );
  });
});

describe("Custom mode on a routine poll", () => {
  it("will not call a failed probe 'protected' just because the engine is up", () => {
    // The reported defect, exactly: Custom mode, an Xray protocol, the
    // probe failing, and a green orb that never goes away.
    //
    // `fromStatus` is what an Xray session now produces -- `unverified`,
    // because the service has no handshake to offer -- and a failed
    // probe adds nothing to it.
    expect(customModePollState("unverified", false)).toBe("unverified");

    // Control: under the shipped rule the same session came out of
    // `stateFromStatus` as "connected", and this branch then published
    // "connected" without consulting the probe at all.
    expect(customModePoll_0929(stateFromStatus_0929(status()), false)).toBe("connected");
  });

  it("will not cry wolf on a failed probe either", () => {
    // The probe has been seen to fail while Chrome was visibly going
    // through the tunnel -- 328 flows matched and 703 packets redirected
    // while the UI said "not carrying traffic". A check that flaky must
    // not be allowed to tell someone in Iran they are unprotected, and
    // must not be allowed to trigger a teardown.
    expect(customModePollState("unverified", false)).not.toBe("degraded");
    expect(customModePollState("connected", false)).not.toBe("degraded");
  });

  it("keeps a live tunnel out of 'protected' when the redirect is unproven", () => {
    // WireGuard with a live handshake and a probe that did not carry.
    // The tunnel is real; whether the *selected apps* are being carried
    // is a different fact, and this branch has no evidence for it.
    expect(customModePollState("connected", false)).toBe("unverified");
  });

  it("lets a probe that carried traffic settle the question", () => {
    expect(customModePollState("unverified", true)).toBe("connected");
    expect(customModePollState("connected", true)).toBe("connected");
  });

  it("lets a measured negative from the engine outrank the probe", () => {
    // A stale WireGuard handshake is an instrument that came back
    // saying "no", not one that abstained, and it stays authoritative
    // even when the probe passes -- the probe tests one synthetic
    // connection, the handshake tests the tunnel.
    expect(customModePollState("degraded", true)).toBe("degraded");
    expect(customModePollState("degraded", false)).toBe("degraded");
  });
});

describe("a full tunnel on a routine poll", () => {
  const through: EgressVerdict = { state: "throughTunnel", exitIp: "38.60.249.229" };
  const bypassing: EgressVerdict = { state: "bypassingTunnel", exitIp: "50.34.35.228" };
  const nothing: EgressVerdict = { state: "unreachable" };
  const noComparison: EgressVerdict = { state: "indeterminate", exitIp: "50.34.35.228" };

  it("treats a proven change of exit address as proof", () => {
    expect(fullTunnelPollState("unverified", through)).toBe("connected");
    expect(fullTunnelPollState("connected", through)).toBe("connected");
  });

  it("does not let 'no comparison was possible' stand in for proof", () => {
    // This is the same defect in the other mode, and it fires in a
    // completely ordinary situation: the app is reopened over a tunnel
    // the service kept up, so no baseline was ever taken, so every
    // comparison is `indeterminate` -- forever.
    expect(fullTunnelPollState("unverified", noComparison)).toBe("unverified");

    // Control: the shipped poll counted `indeterminate` as carrying
    // traffic, so that session read "You're protected" on the strength
    // of a comparison that was never made.
    expect(fullTunnelPoll_0929(stateFromStatus_0929(status()), noComparison)).toBe("connected");
  });

  it("keeps saying so when traffic is provably going around the tunnel", () => {
    expect(fullTunnelPollState("connected", bypassing)).toBe("degraded");
    expect(fullTunnelPollState("unverified", bypassing)).toBe("degraded");
    expect(fullTunnelPollState("connected", nothing)).toBe("degraded");
  });

  it("lets a live handshake stand where egress could not compare", () => {
    // WireGuard, adopted with no baseline. The handshake is real
    // evidence and there is no reason to withhold the green.
    expect(fullTunnelPollState("connected", noComparison)).toBe("connected");
  });
});

describe("combining the connect path's two instruments", () => {
  it("does not turn an absent comparison into a claim", () => {
    const egress: EgressVerdict = { state: "indeterminate", exitIp: "50.34.35.228" };
    expect(combineEvidence("unverified", egress)).toBe("unverified");
    expect(combineEvidence("connected", egress)).toBe("connected");
  });

  it("lets egress overrule a handshake that abstained", () => {
    expect(combineEvidence("unverified", { state: "throughTunnel", exitIp: "1.2.3.4" })).toBe(
      "connected",
    );
    expect(combineEvidence("unverified", { state: "unreachable" })).toBe("degraded");
  });

  it("never contradicts a service that says nothing is running", () => {
    expect(combineEvidence("disconnected", { state: "throughTunnel", exitIp: "1.2.3.4" })).toBe(
      "disconnected",
    );
  });
});

describe("which states mean an engine is up", () => {
  it("counts the unverified one, which is the whole hazard of adding it", () => {
    // Every call site that asked "is there a tunnel here" was written as
    // `=== "connected" || === "degraded"`. Missing one of them would
    // have made a teardown look complete while an adapter was still
    // carrying traffic, or stopped the health poll from ever running in
    // the new state -- which would leave `unverified` on screen
    // permanently and turn an honest answer into a worse lie than the
    // one it replaced.
    expect(isTunnelUp("unverified")).toBe(true);
    expect(isTunnelUp("connected")).toBe(true);
    expect(isTunnelUp("degraded")).toBe(true);

    expect(isTunnelUp("disconnected")).toBe(false);
    expect(isTunnelUp("unknown")).toBe(false);
    expect(isTunnelUp("connecting")).toBe(false);
    expect(isTunnelUp("verifying")).toBe(false);
    expect(isTunnelUp("disconnecting")).toBe(false);
  });
});

describe("the wiring the pure functions cannot check", () => {
  // Source assertions, for the same reason `connect-intent.test.ts` has
  // them: the dashboard needs a Tauri runtime, a helper service and a
  // real network, so nothing here can observe what it publishes.
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("routes the Custom-mode poll through the rule instead of re-deriving it", () => {
    // The branch that shipped read
    //   if (splitTunnelActive && fromStatus === "connected") { publish("connected") }
    // and it is the defect itself. Its absence is the assertion.
    expect(dashboard).not.toContain('splitTunnelActive && fromStatus === "connected"');
    expect(dashboard).toContain("customModePollState(fromStatus, carried)");
  });

  it("no longer counts an indeterminate egress reading as carrying traffic", () => {
    expect(dashboard).not.toContain(
      'egress.state === "throughTunnel" || egress.state === "indeterminate"',
    );
    expect(dashboard).toContain("fullTunnelPollState(fromStatus, egress)");
  });

  it("gives the poll a leading edge, so the new state resolves in seconds", () => {
    // Without this, `unverified` -- which every Xray, OpenVPN and IKEv2
    // status now produces on sight -- would sit on screen for a full
    // poll interval before anything tried to resolve it.
    expect(dashboard).toContain("if (Date.now() - lastCheckAtRef.current >= MIN_CHECK_GAP_MS)");
  });

  it("does not remember a route as last-good without proof it carried traffic", () => {
    // `lastGood` decides which candidate leads the ladder next time.
    // Promoting one that only reached `unverified` would teach the app
    // to open with a protocol nothing has ever vouched for.
    expect(dashboard).toContain('if (verdict === "connected") {\n              const updated =');
  });
});
