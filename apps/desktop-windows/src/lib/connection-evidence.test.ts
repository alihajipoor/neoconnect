import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  combineEvidence,
  customModePollState,
  droppedFromPoll,
  fullTunnelPollState,
  handshakeEvidence,
  headlineFor,
  isTunnelUp,
  LIVENESS_POLL_MS,
  noTunnelVerified,
  rungJudgedByHandshake,
  showsIpv6Escape,
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
  // Exit addresses are RFC 5737 documentation addresses standing in
  // for a node and for a customer's own line; only the fact that
  // they differ matters. See docs/node-address-hygiene.md.
  const through: EgressVerdict = { state: "throughTunnel", exitIp: "203.0.113.10" };
  const bypassing: EgressVerdict = { state: "bypassingTunnel", exitIp: "192.0.2.228" };
  const nothing: EgressVerdict = { state: "unreachable" };
  const noComparison: EgressVerdict = { state: "indeterminate", exitIp: "192.0.2.228" };

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
    const egress: EgressVerdict = { state: "indeterminate", exitIp: "192.0.2.228" };
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

/* ------------------------------------------------------------------ *
 * Our control plane down under a working tunnel.
 *
 * Every endpoint answers 502 (the backend container being rebuilt; every
 * mirror proxies to it) or nothing answers at all (the panel host down)
 * while the public internet is fine. The egress check now calls that
 * `indeterminate` -- see egress.test.ts -- and these pin what the screen
 * and the ladder do with it.
 * ------------------------------------------------------------------ */

describe("an outage of ours, seen from a working tunnel", () => {
  const ourOutage: EgressVerdict = { state: "indeterminate", exitIp: null };
  const blackHole: EgressVerdict = { state: "unreachable" };

  it("does not mark a tunnel degraded on the poll, so no strike and no ladder", () => {
    // Xray, OpenVPN, IKEv2: nothing proven, nothing refuted.
    expect(fullTunnelPollState("unverified", ourOutage)).toBe("unverified");
    // WireGuard with a live handshake keeps its green.
    expect(fullTunnelPollState("connected", ourOutage)).toBe("connected");
    // A tunnel that really is carrying nothing still says so.
    expect(fullTunnelPollState("unverified", blackHole)).toBe("degraded");
  });

  it("judges an earlier rung on its handshake when no baseline could be taken", () => {
    // No baseline: no candidate can ever be proven, so rejecting each for
    // lacking proof walked every working protocol off the ladder.
    expect(rungJudgedByHandshake(ourOutage, { isLast: false, baselineTaken: false })).toBe(true);
    // With a baseline, an earlier rung still has to prove itself while
    // another candidate waits.
    expect(rungJudgedByHandshake(ourOutage, { isLast: false, baselineTaken: true })).toBe(false);
    // A black hole is a measured negative either way: next protocol.
    expect(rungJudgedByHandshake(blackHole, { isLast: false, baselineTaken: false })).toBe(false);
    // The last rung always falls back to the handshake.
    expect(rungJudgedByHandshake(blackHole, { isLast: true, baselineTaken: true })).toBe(true);
    // And proof needs no fallback.
    expect(
      rungJudgedByHandshake({ state: "throughTunnel", exitIp: "203.0.113.10" }, { isLast: true, baselineTaken: true }),
    ).toBe(false);
  });

  it("is what the connect ladder asks, rather than a bare isLast", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(dashboard).toContain("rungJudgedByHandshake(egress, {");
    expect(dashboard).toContain("baselineTaken: baselineIpRef.current !== null");
    // The shape that rejected every earlier rung without a comparison.
    expect(dashboard).not.toMatch(/: isLast\s*\n\s*\? combineEvidence\(await confirmReachable\(\), egress\)/);
  });
});

describe("the IPv6 escape alarm", () => {
  it("is raised for a full tunnel whose IPv6 is getting out", () => {
    expect(showsIpv6Escape("connected", { customMode: false, escaping: true })).toBe(true);
    expect(showsIpv6Escape("unverified", { customMode: false, escaping: true })).toBe(true);
    expect(showsIpv6Escape("connected", { customMode: false, escaping: false })).toBe(false);
    expect(showsIpv6Escape("disconnected", { customMode: false, escaping: true })).toBe(false);
  });

  it("is never raised in Custom mode, where the probe sees only this app's direct traffic", () => {
    // On any network with working IPv6 the app's own probe gets out
    // directly in Custom mode, by design, and the red line used to fire
    // on every connect -- telling the customer to reconnect over a
    // tunnel carrying their chosen apps.
    expect(showsIpv6Escape("connected", { customMode: true, escaping: true })).toBe(false);
    expect(showsIpv6Escape("unverified", { customMode: true, escaping: true })).toBe(false);
  });

  it("is what the screen asks", () => {
    const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(dashboard).toContain("showsIpv6Escape(connectionState, { customMode: splitTunnelActive, escaping: ipv6Escaping })");
    expect(dashboard).not.toContain("isTunnelUp(connectionState) && ipv6Escaping ?");
  });
});

describe("measurements that cannot outlive what they serve", () => {
  // The walk of the endpoint list used to be unbounded wherever it ran:
  // a dozen endpoints at six seconds each. Source assertions, for the
  // reason given in "the wiring the pure functions cannot check".
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("caps the health poll's egress walk and runs one measurement at a time", () => {
    expect(dashboard).toContain(
      "verifyEgress(baselineIpRef.current, { totalMs: HEALTH_EGRESS_TOTAL_MS, tunnelServer })",
    );
    // One at a time; a newer state's first check waits rather than
    // running beside it (dashboard-remount.test.ts has the rest).
    expect(dashboard).toMatch(
      /if \(healthCheckInFlightRef\.current\) \{\s+if \(catchUp\) healthCheckWantedRef\.current = \(\) => check\(\);\s+return;\s+\}\s+healthCheckInFlightRef\.current = true;/,
    );
  });

  it("settles each candidate on an endpoint already known to answer, within a ceiling", () => {
    expect(dashboard).toContain("settleAndCaptureBaseline(settleBudget, knownBaseline, tunnelServer)");
    expect(dashboard).toContain("captureBaselineIp({ only: ask.from, deadline, tunnelServer })");
    expect(dashboard).toContain("captureBaselineIp({ deadline: walkDeadline, tunnelServer })");
    // The shape that checked its budget only between whole walks.
    expect(dashboard).not.toMatch(/for \(;;\) \{\s*const ip = await captureBaselineIp\(\);/);
  });

  it("stops a pass whose guard expired once a newer pass has started", () => {
    expect(dashboard).toContain("if (ladderGenerationRef.current !== generation) break;");
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

/* ------------------------------------------------------------------ *
 * A tunnel that goes while the screen is vouching for it.
 *
 * Measured on 2026-10-06 in the test VM: xray.exe killed, every packet
 * out direct within 0.2s, and "You're protected" on screen for another
 * 17.0 seconds (8.1 in Custom mode), then "You're not protected --
 * Connect to encrypt your traffic", which describes someone who never
 * connected. These pin the app's half: the drop is recognised from one
 * status answer, nothing but the service's verified "no tunnel" counts
 * -- not a failed call, not its busy fallback's guess, not an answer our
 * own Custom-mode change or probe disturbed -- and the words change.
 * ------------------------------------------------------------------ */

describe("noticing that the tunnel has gone", () => {
  const LIVE: ConnectionState[] = ["connected", "unverified", "degraded"];
  const NOT_LIVE: ConnectionState[] = ["disconnected", "unknown", "connecting", "verifying", "disconnecting"];
  /** The service's own "nothing is running": from the engine it holds,
   * or the record of that engine ending. */
  const ENDED: Pick<VpnStatus, "connected" | "health"> = { connected: false, health: { state: "down" } };
  /** What a current service's fallback says while its owning thread is
   * busy and it can see no tunnel: nothing proved either way. */
  const GUESSED: Pick<VpnStatus, "connected" | "health"> = { connected: false, health: { state: "unknown" } };

  it("takes the service at its word when it says nothing is running", () => {
    for (const shown of LIVE) {
      expect(droppedFromPoll(shown, "idle", ENDED, false), shown).toBe(true);
    }
  });

  it("does not treat a live answer as anything", () => {
    const answers: Pick<VpnStatus, "connected" | "health">[] = [
      { connected: true, health: { state: "alive", age_secs: 3 } },
      { connected: true, health: { state: "unknown" } },
      { connected: true, health: { state: "neverHandshaked" } },
    ];
    for (const shown of LIVE) {
      for (const answer of answers) {
        expect(droppedFromPoll(shown, "idle", answer, false), `${shown} ${answer.health.state}`).toBe(false);
      }
    }
  });

  it("never calls a failed call a drop", () => {
    // A miss is a miss. The health poll turns several of them into
    // "Can't tell right now"; turning one into "connection lost" would
    // tell somebody their tunnel failed on no evidence at all.
    for (const shown of LIVE) {
      expect(droppedFromPoll(shown, "idle", null, false), shown).toBe(false);
    }
  });

  it("never calls the busy service's guess a drop", () => {
    // The fallback's "no tunnel" is an adapter not seen, or PowerShell
    // not answering -- both of which happen with a tunnel up: a
    // Custom-mode rebuild takes the Xray adapter down for seconds, and
    // PowerShell times out. A current service says so with `unknown`.
    for (const shown of LIVE) {
      expect(droppedFromPoll(shown, "idle", GUESSED, false), shown).toBe(false);
    }
    expect(noTunnelVerified(GUESSED)).toBe(false);
    expect(noTunnelVerified(ENDED)).toBe(true);
    expect(noTunnelVerified({ connected: true, health: { state: "down" } })).toBe(false);
  });

  it("never calls an answer our own Custom-mode change or probe disturbed a drop", () => {
    // What covers a 0.9.43 service, which says `down` for the guess too,
    // and the probe race: an answer the probe or a rebuild may have
    // caught is set aside whatever it says.
    for (const shown of LIVE) {
      expect(droppedFromPoll(shown, "idle", ENDED, true), shown).toBe(false);
    }
  });

  it("is not fooled by our own teardowns", () => {
    // A disconnect the customer asked for, and the teardown every
    // connect starts with, both produce `connected: false` while the
    // screen still shows a tunnel. Neither is a drop.
    for (const shown of LIVE) {
      expect(droppedFromPoll(shown, "disconnect", ENDED, false), shown).toBe(false);
      expect(droppedFromPoll(shown, "connect", ENDED, false), shown).toBe(false);
    }
  });

  it("has nothing to say when nothing was being claimed", () => {
    for (const shown of NOT_LIVE) {
      expect(droppedFromPoll(shown, "idle", ENDED, false), shown).toBe(false);
    }
  });

  it("stops claiming protection the moment it is told the engine is gone", () => {
    // The whole path, in the order the dashboard takes it: a tunnel
    // shown as protected, one status answer saying nothing is running,
    // and what goes on screen next.
    const shown: ConnectionState = "connected";
    expect(headlineFor(shown, { dropped: false, customMode: false }).title).toBe("dash.protected");

    const answer = status({ connected: false, protocol: null, health: { state: "down" } });
    expect(droppedFromPoll(shown, "idle", answer, false)).toBe(true);
    const next = stateFromStatus(answer);
    expect(next).toBe("disconnected");

    const headline = headlineFor(next, { dropped: true, customMode: false });
    expect(headline.title).toBe("dash.dropped");
    expect(headline.hint).toBe("dash.droppedHint");
    expect(headline.tone).toBe("destructive");
  });

  it("asks often enough that the old seventeen seconds cannot happen", () => {
    expect(LIVENESS_POLL_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("the headline", () => {
  const EVERY: ConnectionState[] = [
    "disconnected",
    "unknown",
    "connecting",
    "verifying",
    "connected",
    "unverified",
    "degraded",
    "disconnecting",
  ];

  it("says 'protected' for one state only, whatever else is true", () => {
    for (const state of EVERY) {
      for (const dropped of [false, true]) {
        for (const customMode of [false, true]) {
          const { title, hint } = headlineFor(state, { dropped, customMode });
          const claims = title === "dash.protected" || hint === "dash.protectedHint";
          expect(claims, `${state} dropped=${dropped} custom=${customMode}`).toBe(state === "connected");
        }
      }
    }
  });

  it("keeps the ordinary words for somebody who simply has not connected", () => {
    expect(headlineFor("disconnected", { dropped: false, customMode: false })).toEqual({
      title: "dash.notProtected",
      hint: "dash.notProtectedHint",
      tone: "plain",
    });
  });

  it("gives Custom mode its narrower unconfirmed sentence", () => {
    expect(headlineFor("unverified", { dropped: false, customMode: true }).hint).toBe("dash.unverifiedCustomHint");
    expect(headlineFor("unverified", { dropped: false, customMode: false }).hint).toBe("dash.unverifiedHint");
  });
});

describe("the liveness wiring the pure functions cannot check", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = dashboard.indexOf("const look = async () => {");
  const end = dashboard.indexOf("const id = setInterval(() => void look(), LIVENESS_POLL_MS);", start);
  const look = dashboard.slice(start, end);
  const checkStart = dashboard.indexOf("const measure = async (): Promise<boolean> => {");
  const check = dashboard.slice(
    checkStart,
    dashboard.indexOf("const id = setInterval(() => void check(), HEALTH_POLL_MS);", checkStart),
  );
  const dropStart = dashboard.indexOf("function publishDrop(generation: number): boolean {");
  const publishDrop = dashboard.slice(dropStart, dashboard.indexOf("\n  }\n", dropStart));

  it("polls liveness on its own interval", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("decides through the rule and publishes through the stamp", () => {
    expect(look).toContain("droppedFromPoll(connectionState, intentRef.current.intent, status, disturbed)");
    expect(look).toContain("publishDrop(generation)");
    expect(look).toContain("const generation = intentRef.current.generation;");
    expect(look).not.toContain("setConnectionState(");
  });

  it("stays cheap: no egress request and no probe every second", () => {
    expect(look).not.toContain("verifyEgress");
    expect(look).not.toContain("vpn_probe_split_tunnel");
  });

  it("sets aside an answer the probe or a Custom-mode change may have caught", () => {
    // Not starting while one runs is not enough: the health poll starts
    // the probe after its own status returns, so a probe can begin while
    // a look is already waiting. The mark is taken before asking and
    // read after.
    expect(look).toContain("if (statusDisturbances.busy()) return;");
    const asked = look.indexOf("await serviceStatus()");
    expect(asked).toBeGreaterThan(0);
    expect(look.indexOf("const mark = statusDisturbances.mark();")).toBeGreaterThan(0);
    expect(look.indexOf("const mark = statusDisturbances.mark();")).toBeLessThan(asked);
    expect(look.indexOf("statusDisturbances.since(mark)")).toBeGreaterThan(asked);
    // And the probe is what marks itself.
    expect(check).toContain("statusDisturbances.begin(PROBE_CAP_MS)");
  });

  it("words the slower poll's drop the same way, through the same rule", () => {
    expect(check).toContain("droppedFromPoll(connectionState, intentRef.current.intent, status, disturbed)");
    expect(check).toContain("publishDrop(generation)");
    // And a "no tunnel" it cannot trust is a miss there, not a verdict.
    expect(check).toContain("if (!status.connected && (disturbed || !noTunnelVerified(status))) {");
  });

  it("makes a drop outrank every answer still in flight", () => {
    expect(dropStart).toBeGreaterThan(0);
    expect(publishDrop).toContain('publishObserved(generation, "disconnected")');
    expect(publishDrop).toContain("intentRef.current = supersedeAnswers(intentRef.current);");
    expect(publishDrop).toContain("setTunnelDropped(true)");
    // Only there: one place says "VPN connection lost".
    expect(dashboard.split("setTunnelDropped(true)").length).toBe(2);
  });

  it("drops a health check's reading once it has been overtaken", () => {
    // The check reads status, then spends seconds on egress or the
    // probe. If the tunnel was found gone meanwhile, nothing it measured
    // may reach the screen or the per-ISP tags.
    const measured = check.indexOf("verdict = fullTunnelPollState(fromStatus, egress);");
    const guard = check.indexOf("if (!isCurrent(intentRef.current, generation)) return false;", measured);
    const tags = check.indexOf("sessionTrackerRef.current.healthy(");
    expect(measured).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(measured);
    expect(guard).toBeLessThan(tags);
  });

  it("takes the headline from the table rather than re-deriving it", () => {
    expect(dashboard).toContain("headlineFor(connectionState, { dropped: tunnelDropped");
    expect(dashboard).not.toContain('t("dash.protected")');
  });
});

/** The egress check passes over endpoints on the tunnel's own server,
 * which the client routes around the tunnel (`TunnelServer` in
 * egress.ts; the behaviour is in egress-own-mirror.test.ts). Whether the
 * screen tells it which server that is, is wiring, asserted here like
 * the rest. */
describe("the tunnel's own server, named to the egress check", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("names the rung's server to every baseline and check it makes while connecting", () => {
    expect(dashboard).toContain("const tunnelServer = await tunnelServerOf(candidate);");
    expect(dashboard).toContain("settleAndCaptureBaseline(settleBudget, knownBaseline, tunnelServer)");
    expect(dashboard).toContain("confirmEgress(baselineIpRef.current, verifyBudget, !isLast, tunnelServer)");
    // Kept for the health poll, from whichever Dashboard is mounted.
    expect(dashboard).toContain("ladderPass.tunnelServer.current = tunnelServer;");
    expect(dashboard.indexOf("ladderPass.tunnelServer.current = tunnelServer;")).toBeLessThan(
      dashboard.indexOf('await invoke("vpn_connect"'),
    );
  });

  it("names the connected server to the health poll", () => {
    expect(dashboard).toContain("const tunnelServer = ladderPass.tunnelServer.current ?? undefined;");
    expect(dashboard).toMatch(/verifyEgress\(baselineIpRef\.current, \{[^}]*tunnelServer[^}]*\}\)/);
  });

  it("takes no baseline while connecting without the rung's server", () => {
    // Every capture inside the settle passes it; the one taken when the
    // screen loads has no rung yet, and the settle passes over a `known`
    // endpoint on the server instead (`fromTunnelServer`).
    const settle = dashboard.slice(
      dashboard.indexOf("async function settleAndCaptureBaseline("),
      dashboard.indexOf("function describeAttempts("),
    );
    const captures = [...settle.matchAll(/captureBaselineIp\(([^)]*)\)/g)].map((m) => m[1]);
    expect(captures).toHaveLength(2);
    for (const args of captures) expect(args).toContain("tunnelServer");
    expect(settle).toContain("!fromTunnelServer(known, tunnelServer)");
  });
});
