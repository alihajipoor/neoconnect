import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineIp, EgressVerdict, VerifyOptions } from "@shared/lib/egress";

/** The rules that decide whether the phone says "You're protected".
 *
 * Before these were pulled out of the dashboard, an `indeterminate`
 * egress reading counted as carrying traffic in three places -- the
 * connect ladder, the health poll, and (through a status with no
 * handshake) the adopted state on relaunch. Every test below that
 * expects "unverified" or "notCarrying" from an indeterminate reading
 * would have read "connected" there. Only `verifyEgress` is stood in
 * for; nothing here has run against a phone. */

const calls: { baseline: BaselineIp | null; options: VerifyOptions | undefined }[] = [];
let answers: EgressVerdict[] = [];

vi.mock("@shared/lib/egress", () => ({
  verifyEgress: (baseline: BaselineIp | null, options?: VerifyOptions) => {
    calls.push({ baseline, options });
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return Promise.resolve(next ?? { state: "unreachable" });
  },
}));

const { confirmEgress, pollEgress, pollState, rungOutcome, stateFromStatus, tunnelUp } = await import(
  "./tunnel-evidence"
);

const BASELINE: BaselineIp = { ip: "198.51.100.7", from: "https://api.example.test" };
const THROUGH: EgressVerdict = { state: "throughTunnel", exitIp: "203.0.113.9" };
const BYPASS: EgressVerdict = { state: "bypassingTunnel", exitIp: "198.51.100.7" };
const INDETERMINATE: EgressVerdict = { state: "indeterminate", exitIp: "203.0.113.9" };
const UNREACHABLE: EgressVerdict = { state: "unreachable" };

const xrayUp = { connected: true, protocol: "XRAY_VLESS_REALITY", rxBytes: 0, txBytes: 0, lastHandshakeAgeSecs: null };
const wireguard = (age: number | null) => ({
  connected: true,
  protocol: "WIREGUARD",
  rxBytes: 0,
  txBytes: 0,
  lastHandshakeAgeSecs: age,
});

beforeEach(() => {
  calls.length = 0;
  answers = [];
});

describe("stateFromStatus", () => {
  it("does not call an engine with no handshake to read 'connected'", () => {
    // The adopted-on-relaunch case: Android's Xray status after a reboot
    // reported exactly this from a stale state file.
    expect(stateFromStatus(xrayUp)).toBe("unverified");
  });

  it("keeps the handshake's own verdict for WireGuard", () => {
    expect(stateFromStatus(wireguard(20))).toBe("connected");
    expect(stateFromStatus(wireguard(600))).toBe("degraded");
  });

  it("reads not connected as disconnected", () => {
    expect(stateFromStatus({ ...xrayUp, connected: false })).toBe("disconnected");
  });
});

describe("pollState", () => {
  it("never turns an indeterminate reading into 'connected' without a handshake", () => {
    expect(pollState("unverified", INDETERMINATE)).toBe("unverified");
  });

  it("lets a fresh WireGuard handshake stand where egress abstains", () => {
    expect(pollState("connected", INDETERMINATE)).toBe("connected");
  });

  it("promotes on a changed exit address and demotes on a measured negative", () => {
    expect(pollState("unverified", THROUGH)).toBe("connected");
    expect(pollState("unverified", BYPASS)).toBe("degraded");
    expect(pollState("connected", UNREACHABLE)).toBe("degraded");
  });

  it("keeps a stale handshake degraded whatever egress says", () => {
    expect(pollState("degraded", THROUGH)).toBe("degraded");
  });
});

describe("the stale Android state file, end to end through these rules", () => {
  it("shows an adopted tunnel with no baseline as not confirmed, on every poll", async () => {
    // Relaunch over a tunnel nobody can vouch for: status says up, there
    // is no baseline, and the API answers over the plain network.
    const adopted = stateFromStatus(xrayUp);
    answers = [{ state: "indeterminate", exitIp: "198.51.100.7" }];
    const egress = await pollEgress(null);
    for (let poll = 0; poll < 3; poll++) {
      expect(pollState(adopted, egress)).toBe("unverified");
    }
    expect(pollState(adopted, egress)).not.toBe("connected");
  });
});

describe("rungOutcome", () => {
  it("lands only a changed exit address as connected", () => {
    expect(rungOutcome(THROUGH, { baselineTaken: true, isLast: false })).toBe("connected");
  });

  it("moves on from an indeterminate reading while another protocol is left", () => {
    expect(rungOutcome(INDETERMINATE, { baselineTaken: true, isLast: false })).toBe("notCarrying");
  });

  it("lands an indeterminate last rung, or one with no baseline, as unverified", () => {
    expect(rungOutcome(INDETERMINATE, { baselineTaken: true, isLast: true })).toBe("unverified");
    expect(rungOutcome(INDETERMINATE, { baselineTaken: false, isLast: false })).toBe("unverified");
  });

  it("rejects a bypassed or unreachable rung", () => {
    expect(rungOutcome(BYPASS, { baselineTaken: true, isLast: true })).toBe("notCarrying");
    expect(rungOutcome(UNREACHABLE, { baselineTaken: true, isLast: true })).toBe("notCarrying");
  });
});

describe("confirmEgress", () => {
  it("returns proof as soon as it has it", async () => {
    answers = [THROUGH];
    await expect(confirmEgress(BASELINE, { intervalMs: 1 })).resolves.toEqual(THROUGH);
    expect(calls).toHaveLength(1);
  });

  it("keeps asking past an indeterminate reading when a comparison is possible", async () => {
    answers = [INDETERMINATE, INDETERMINATE, THROUGH];
    await expect(confirmEgress(BASELINE, { intervalMs: 1, timeoutMs: 5_000 })).resolves.toEqual(THROUGH);
    expect(calls).toHaveLength(3);
  });

  it("stops at once on indeterminate with no baseline, where asking again proves nothing", async () => {
    answers = [INDETERMINATE];
    await expect(confirmEgress(null, { intervalMs: 1, timeoutMs: 5_000 })).resolves.toEqual(INDETERMINATE);
    expect(calls).toHaveLength(1);
  });

  it("returns the last verdict at the deadline", async () => {
    answers = [BYPASS];
    await expect(confirmEgress(BASELINE, { intervalMs: 5, timeoutMs: 20 })).resolves.toEqual(BYPASS);
  });

  it("passes sameEndpointOnly through to every check", async () => {
    answers = [BYPASS, THROUGH];
    await confirmEgress(BASELINE, { sameEndpointOnly: true, intervalMs: 1, timeoutMs: 5_000 });
    expect(calls.every((c) => c.options?.sameEndpointOnly === true)).toBe(true);
  });

  it("answers null once cancelled", async () => {
    answers = [BYPASS];
    let cancelled = false;
    const pending = confirmEgress(BASELINE, { intervalMs: 5, timeoutMs: 5_000, cancelled: () => cancelled });
    cancelled = true;
    await expect(pending).resolves.toBeNull();
  });
});

describe("pollEgress", () => {
  it("asks the baseline's own endpoint first", async () => {
    answers = [THROUGH];
    await expect(pollEgress(BASELINE)).resolves.toEqual(THROUGH);
    expect(calls).toEqual([{ baseline: BASELINE, options: { sameEndpointOnly: true } }]);
  });

  it("falls back to the whole list only when that endpoint does not answer", async () => {
    answers = [UNREACHABLE, INDETERMINATE];
    await expect(pollEgress(BASELINE)).resolves.toEqual(INDETERMINATE);
    expect(calls.map((c) => c.options?.sameEndpointOnly ?? false)).toEqual([true, false]);
  });

  it("asks the whole list when there is no baseline", async () => {
    answers = [INDETERMINATE];
    await pollEgress(null);
    expect(calls).toEqual([{ baseline: null, options: undefined }]);
  });
});

describe("tunnelUp", () => {
  it("counts unverified as a tunnel to poll and to take down", () => {
    expect(tunnelUp("unverified")).toBe(true);
    expect(tunnelUp("connected")).toBe(true);
    expect(tunnelUp("degraded")).toBe(true);
    expect(tunnelUp("disconnected")).toBe(false);
    expect(tunnelUp("disconnecting")).toBe(false);
  });
});
