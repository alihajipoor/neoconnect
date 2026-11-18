import {
  classifyFailure,
  classifyReport,
  isConnectAttempt,
  reportFailureCode,
  rungFailed,
  rungNotDialled,
  scrubAddresses,
  type FailureCode,
  type ReportCategory,
} from "./insight-classify";

/** Every string here is one a client writes today, copied from the client
 * code named beside it. */

const report = (kind: string, outcome: string, reason: string | null = null, hasRungs = false) => ({
  kind,
  outcome,
  reason,
  hasRungs,
});

describe("classifyReport", () => {
  const cases: [string, ReturnType<typeof report>, ReportCategory][] = [
    ["a landed connect (Dashboard.tsx)", report("CONNECT", "SUCCESS", null, true), "connect"],
    ["a failed ladder (Dashboard.tsx)", report("CONNECT", "NOT_CARRYING_TRAFFIC", "handshake timed out", true), "connect"],
    ["a failed ladder with no error kind", report("CONNECT", "OTHER", null, true), "connect"],
    ["a refusal before dialling (device-slots.ts)", report("CONNECT", "REJECTED", "DEVICE_LIMIT"), "connect"],
    [
      "a reconnect pass that landed (auto-reconnect.ts asReconnectReport)",
      report("CONNECT", "SUCCESS", "auto-reconnect attempt 2 of at most 6 after the tunnel dropped", true),
      "reconnect",
    ],
    [
      "a reconnect pass that failed",
      report("CONNECT", "OTHER", "auto-reconnect attempt 1 of at most 6 after the tunnel dropped: did not connect (NOT_CARRYING_TRAFFIC); timed out", true),
      "reconnect",
    ],
    [
      "an episode stop",
      report("CONNECT", "OTHER", "auto-reconnect stopped after 6 attempt(s): every attempt was used (6)"),
      "reconnect",
    ],
    [
      "a pre-connect config refresh (connection-config.ts)",
      report(
        "CONNECT",
        "CONTROL_PLANE_UNREACHABLE",
        "pre-connect config refresh failed (no answer within 6000ms) after 6003ms; connecting on cached credentials 40 min old (horizon 30 min)",
      ),
      "api",
    ],
    [
      "a dashboard load (unanswered-report.ts)",
      report("CONNECT", "CONTROL_PLANE_UNREACHABLE", "dashboard load: no answer from Neoxify to protocolUsers after 9000ms; not a connect, nothing is being dialled; showing cached"),
      "api",
    ],
    [
      "a probe follow-up (attempts.ts sendFollowUp)",
      report("CONNECT", "OTHER", "probe follow-up to the CONNECT CONTROL_PLANE_UNREACHABLE report of 2026-11-01T10:00:00.000Z, which was no longer held when the probe answered; not an attempt"),
      "api",
    ],
    [
      "an unreachable refiled as this machine refusing (control-plane-probe.ts)",
      report("CONNECT", "OTHER", "online config refresh failed; was refused here (permission denied: os error 10013 on Windows); filed as OTHER, not CONTROL_PLANE_UNREACHABLE"),
      "api",
    ],
    [
      "changed server parameters (connection-config.ts)",
      report("CONNECT", "SUCCESS", "resume refresh found changed server parameters: Fast port 443 -> 8443"),
      "config",
    ],
    [
      "a late refresh with changed parameters",
      report("CONNECT", "SUCCESS", "pre-connect refresh answered after its 6000ms budget (in 9100ms) and found changed server parameters: x; the connect had gone ahead on the cached values"),
      "config",
    ],
    ["a cancelled mobile pass", report("CONNECT", "OTHER", "cancelled by the customer after 2 of 5 attempt(s)", true), "cancelled"],
    ["a session", report("SESSION", "SUCCESS"), "session"],
    ["a sign-in", report("SIGN_IN", "REJECTED", "Invalid email or password"), "signin"],
    ["a sign-up", report("REGISTER", "SUCCESS"), "register"],
    ["an OTHER with nothing to go on", report("CONNECT", "OTHER", "something new"), "other"],
  ];
  it.each(cases)("%s", (_name, r, expected) => {
    expect(classifyReport(r)).toBe(expected);
  });

  it("counts connects and reconnect passes as attempts, but not an episode stop or a drop", () => {
    expect(isConnectAttempt(report("CONNECT", "SUCCESS", null, true))).toBe(true);
    expect(isConnectAttempt(report("CONNECT", "SUCCESS", "auto-reconnect attempt 1 of at most 6 after the tunnel dropped", true))).toBe(true);
    expect(isConnectAttempt(report("CONNECT", "OTHER", "auto-reconnect stopped after 6 attempt(s): every attempt was used (6)"))).toBe(false);
    expect(isConnectAttempt(report("CONNECT", "OTHER", "auto-reconnect drop seen; state disconnected; run: ok"))).toBe(false);
    expect(isConnectAttempt(report("CONNECT", "CONTROL_PLANE_UNREACHABLE", "x"))).toBe(false);
    expect(isConnectAttempt(report("CONNECT", "SUCCESS", "resume refresh found changed server parameters: x"))).toBe(false);
  });
});

describe("rungs", () => {
  it("tells a rung passed over from one dialled", () => {
    expect(rungNotDialled("not dialled -- its server was too slow a moment ago")).toBe(true);
    expect(rungNotDialled("up but unreachable")).toBe(false);
    // The phone ladder's skips (mobile Dashboard.tsx), copied verbatim.
    expect(rungNotDialled("not available with selected apps")).toBe(true);
    expect(rungNotDialled("not supported on this platform")).toBe(true);
    expect(rungFailed("not available with selected apps")).toBe(false);
    expect(rungFailed("not supported on this platform")).toBe(false);
    expect(rungFailed("connected")).toBe(false);
    expect(rungFailed("not dialled -- its server was too slow a moment ago")).toBe(false);
    expect(rungFailed("going back to it -- slow, but it works; 2 more dialled in 9 s found nothing better, 1 further not dialled yet")).toBe(false);
    expect(rungFailed("up but unreachable")).toBe(true);
  });
});

describe("classifyFailure", () => {
  const cases: [string, string | undefined, FailureCode][] = [
    ["Could not reach Neoxify. Check your connection.", "CONTROL_PLANE_UNREACHABLE", "API_UNREACHABLE"],
    ["pre-connect config refresh failed (no answer within 6000ms) after 6003ms", undefined, "API_UNREACHABLE"],
    ["up but unreachable", undefined, "NOT_CARRYING"],
    ["up but bypassingTunnel", undefined, "NOT_CARRYING"],
    ["up but unreachable, checked again after the IPv4 confinement was let go of", undefined, "NOT_CARRYING"],
    ["up but too slow (180 kbps down, 40 kbps up, upload given 12.0 s)", undefined, "TOO_SLOW"],
    ["No response from the server. UDP is likely blocked on this network; try a Stealth protocol instead.", undefined, "NO_RESPONSE_UDP_BLOCKED"],
    [
      "The connection did not complete. Try a Stealth protocol, which works on networks that block this one -- and tell support if it keeps happening, because this can also be a fault at the server.",
      undefined,
      "DID_NOT_COMPLETE",
    ],
    ["The Neoxify background service did not answer within 30s. It may be stuck -- restarting the app usually clears it.", undefined, "SERVICE_NOT_ANSWERING"],
    ["Could not reach the Neoxify background service (it is not running). Try restarting the app, or reinstalling if this keeps happening.", undefined, "SERVICE_NOT_ANSWERING"],
    ["Xray started but its network adapter (neoconnect0) never appeared", undefined, "ADAPTER_MISSING"],
    ["Wintun would not create an adapter (Access is denied.)", undefined, "ADAPTER_MISSING"],
    ["wireguard.exe is missing from the installation", undefined, "ENGINE_FAILED"],
    ["The VPN engine failed to start.", undefined, "ENGINE_FAILED"],
    ["VPN permission declined", undefined, "PERMISSION_DENIED"],
    ["auto-reconnect stopped after 0 attempt(s): another VPN holds the device", undefined, "OTHER_VPN_ACTIVE"],
    ["auto-reconnect preflight stopped: a VPN that is none of ours is still up (otherVpnUp); state connected", undefined, "OTHER_VPN_ACTIVE"],
    ["cancelled by the customer after 2 of 5 attempt(s)", undefined, "CANCELLED_BY_CUSTOMER"],
    ["SUBSCRIPTION_INACTIVE", "REJECTED", "SUBSCRIPTION_INACTIVE"],
    ["DEVICE_LIMIT", "REJECTED", "DEVICE_LIMIT"],
    ["TAKEOVER_LIMIT", "REJECTED", "DEVICE_LIMIT"],
    ["Invalid email or password", "REJECTED", "WRONG_PASSWORD"],
    ["A customer with this email already exists", "REJECTED", "EMAIL_EXISTS"],
    ["That referral code is not valid", "REJECTED", "BAD_REFERRAL_CODE"],
    ["Invalid or expired verification code", "REJECTED", "CODE_NOT_ACCEPTED"],
    ["Connected, but Custom mode didn't start. The apps you chose are going out without protection.", undefined, "CUSTOM_MODE_FAILED"],
    ["The server refused the connection. Check your account is active, or try a Stealth protocol.", undefined, "IKEV2_REFUSED"],
    ["The server rejected these credentials.", undefined, "IKEV2_REFUSED"],
    ["handshake did not complete after 5 seconds", undefined, "SERVER_NOT_REACHED"],
    ["no network connection with a gateway to reach the server over", undefined, "NO_NETWORK"],
    ["auto-reconnect drop seen; state disconnected; run: ended by the system", undefined, "TUNNEL_DROPPED"],
    ["auto-reconnect stopped after 6 attempt(s): every attempt was used (6)", undefined, "RECONNECT_GAVE_UP"],
    ["", "NOT_CARRYING_TRAFFIC", "NO_HANDSHAKE_OR_TRAFFIC"],
    ["something nobody wrote yet", "NOT_CARRYING_TRAFFIC", "NO_HANDSHAKE_OR_TRAFFIC"],
    // The Linux client's IKEv2 text (desktop-linux tunnel/src/ikev2.rs).
    [
      "timed out waiting for the IKEv2 server to answer on UDP 500 and 4500 (UDP is likely blocked on this network; try a Stealth protocol instead)",
      undefined,
      "NO_RESPONSE_UDP_BLOCKED",
    ],
    // Texts real reports carried that matched nothing at first (two weeks
    // of production reports run through this table, 2026-11-18).
    ["device-limit-reached", undefined, "DEVICE_LIMIT"],
    ["Sign in to your Apple Account in Settings, then try again.", "REJECTED", "APPLE_ACCOUNT_NEEDED"],
    ["اول در تنظیمات دستگاه وارد حساب اپل خود شوید، بعد دوباره امتحان کنید.", "REJECTED", "APPLE_ACCOUNT_NEEDED"],
    ["OpenVPN did not finish connecting within 30s: 2026-11-10 10:00:00 library versions: OpenSSL 3.0.0, LZO 2.10", undefined, "OPENVPN_DID_NOT_CONNECT"],
    [
      "OpenVPN exited immediately (exit code: 1): 2026-11-10 10:00:00 Exiting due to fatal error | 2026-11-10 10:00:00 Failed to open wintun adapter: Neoxify-OpenVPN",
      undefined,
      "ADAPTER_MISSING",
    ],
    ["OpenVPN exited immediately (exit code: 1): 2026-11-10 10:00:00 Options error", undefined, "OPENVPN_DID_NOT_CONNECT"],
    ["The VPN service did not start", undefined, "ENGINE_FAILED"],
    [
      "Unable to start service Intent { cmp=com.neoxify.mobile/com.neoxify.vpn.NeoxifyTunService (has extras) }: Unable to launch app com.neoxify.mobile/10200 for service",
      undefined,
      "ENGINE_FAILED",
    ],
    ["connect failed: com.wireguard.android.backend.BackendException", undefined, "ENGINE_FAILED"],
    ["setting the tunnel's DNS failed (exit code: 1)", undefined, "ENGINE_FAILED"],
    ["strongSwan for Built-in (IKEv2) (the packages charon-cmd, libcharon-extra-plugins and libcharon-extauth-plugins on Debian and Ubuntu", undefined, "ENGINE_FAILED"],
    ["the tunnel adapter (neoconnect0) took no address within 20s, so the tunnel's routes would have had no next hop", undefined, "ADAPTER_MISSING"],
    ["server: must be a hostname, not an address", undefined, "SERVER_SETTINGS_UNUSABLE"],
    ["There was an internal authentication error.", undefined, "IKEV2_REFUSED"],
    ["something nobody wrote yet", "OTHER", "UNKNOWN"],
  ];
  it.each(cases)("%s -> %s", (text, outcome, expected) => {
    expect(classifyFailure(text, outcome)).toBe(expected);
  });

  it("reads a failed reconnect pass by what it would have been", () => {
    expect(
      reportFailureCode({
        ...report("CONNECT", "OTHER", "auto-reconnect attempt 1 of at most 6 after the tunnel dropped: did not connect (NOT_CARRYING_TRAFFIC)", true),
        rungResults: ["up but unreachable"],
      }),
    ).toBe("NOT_CARRYING");
    expect(
      reportFailureCode({
        ...report("CONNECT", "OTHER", "auto-reconnect attempt 1 of at most 6 after the tunnel dropped: did not connect (NOT_CARRYING_TRAFFIC)", true),
        rungResults: [],
      }),
    ).toBe("NO_HANDSHAKE_OR_TRAFFIC");
    expect(
      reportFailureCode({
        ...report("CONNECT", "OTHER", "auto-reconnect attempt 1 of at most 6 after the tunnel dropped: did not connect (ENGINE_FAILED); The VPN engine failed to start.", true),
        rungResults: [],
      }),
    ).toBe("ENGINE_FAILED");
  });

  it("gives no code to a success, a session, a config note or a probe follow-up", () => {
    expect(reportFailureCode({ ...report("CONNECT", "SUCCESS", null, true), rungResults: ["connected"] })).toBeNull();
    expect(reportFailureCode({ ...report("SESSION", "SUCCESS"), rungResults: [] })).toBeNull();
    expect(
      reportFailureCode({ ...report("CONNECT", "OTHER", "probe follow-up to the CONNECT CONTROL_PLANE_UNREACHABLE report of x; not an attempt"), rungResults: [] }),
    ).toBeNull();
  });

  it("falls back to the last failed rung when the reason is empty", () => {
    expect(
      reportFailureCode({ ...report("CONNECT", "OTHER", null, true), rungResults: ["up but unreachable", "up but too slow (1 kbps down, 1 kbps up)"] }),
    ).toBe("TOO_SLOW");
  });
});

describe("scrubAddresses", () => {
  it("replaces IPv4 and IPv6 addresses and leaves times and host:port alone", () => {
    expect(scrubAddresses("dial 192.0.2.7:2053 failed at 12:30:45 via a.example:443")).toBe(
      "dial <address>:2053 failed at 12:30:45 via a.example:443",
    );
    expect(scrubAddresses("route to 2001:db8::1 and 2001:db8:0:0:0:0:0:2 refused")).toBe("route to <address> and <address> refused");
  });
});
