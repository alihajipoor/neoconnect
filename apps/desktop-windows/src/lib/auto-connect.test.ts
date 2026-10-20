import { beforeEach, describe, expect, it } from "vitest";
import { autoConnectDecision, autoConnectLatch, type AutoConnectInput } from "./auto-connect";

const READY: AutoConnectInput = {
  enabled: true,
  mode: "vpn",
  state: "disconnected",
  passRunning: false,
  reconnecting: false,
  hasCredential: true,
  subscriptionStatus: "ACTIVE",
  deviceLimitNotice: false,
};

const decide = (over: Partial<AutoConnectInput> = {}) => autoConnectDecision({ ...READY, ...over });

beforeEach(() => autoConnectLatch.resetForTests());

describe("Connect when Neoxify starts", () => {
  it("connects over nothing, with the setting on", () => {
    expect(decide()).toEqual({ go: true });
  });

  it("does nothing with the setting off", () => {
    expect(decide({ enabled: false })).toEqual({ go: false, why: "off" });
  });

  it("never dials over a tunnel the service kept up, a teardown, or a state it could not tell", () => {
    for (const state of ["connected", "unverified", "degraded", "connecting", "verifying", "disconnecting", "unknown"] as const) {
      expect(decide({ state }), state).toEqual({ go: false, why: "notIdle" });
    }
  });

  it("never in Gaming mode", () => {
    expect(decide({ mode: "gaming" })).toEqual({ go: false, why: "gaming" });
  });

  it("never past a pass or a reconnect already running", () => {
    expect(decide({ passRunning: true })).toEqual({ go: false, why: "busy" });
    expect(decide({ reconnecting: true })).toEqual({ go: false, why: "busy" });
  });

  it("needs something to dial and a plan that allows it", () => {
    expect(decide({ hasCredential: false })).toEqual({ go: false, why: "nothingToDial" });
    for (const status of ["SUSPENDED", "EXPIRED", "PENDING"]) {
      expect(decide({ subscriptionStatus: status }), status).toEqual({ go: false, why: "notEntitled" });
    }
    // Offline with nothing cached to say: the pass itself finds out.
    expect(decide({ subscriptionStatus: undefined })).toEqual({ go: true });
  });

  it("does not run into a device limit that has already spoken", () => {
    expect(decide({ deviceLimitNotice: true })).toEqual({ go: false, why: "deviceLimit" });
  });

  it("never connects a phone that owes its VPN disclosure", () => {
    expect(decide({ disclosureAccepted: false })).toEqual({ go: false, why: "disclosure" });
    expect(decide({ disclosureAccepted: true })).toEqual({ go: true });
  });

  it("gets one chance per run", () => {
    expect(autoConnectLatch.armed()).toBe(true);
    expect(autoConnectLatch.take()).toBe(true);
    expect(autoConnectLatch.take()).toBe(false);
    expect(autoConnectLatch.armed()).toBe(false);
  });

  it("gets none in a run that opened on sign-in", () => {
    autoConnectLatch.disarm();
    expect(autoConnectLatch.take()).toBe(false);
  });
});
