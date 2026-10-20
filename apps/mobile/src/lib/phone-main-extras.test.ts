import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FOUND_ON_RETURN_MS,
  PHONE_MAIN_PAGE_EXTRAS,
  lostSessionEnd,
  phoneAutoConnect,
  trafficFromTotals,
  type PhoneAutoConnectDeps,
} from "./phone-main-extras";
import { PHONE_DEVICE } from "./phone-notices";
import type { VpnAccess } from "./vpn";

/** The phone main page's share of the device settings (inventory A2, A7,
 * B1, B2 on phones): what it decides, and that nothing is offered before
 * the page calls it. The page itself is merged later; see the module. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const SCREEN = {
  enabled: true,
  mode: "vpn" as const,
  state: "disconnected" as const,
  passRunning: false,
  reconnecting: false,
  hasCredential: true,
  subscriptionStatus: "ACTIVE",
  deviceLimitNotice: false,
  disclosureAccepted: true,
};

function deps(gone: boolean | Error, access: VpnAccess | Error): PhoneAutoConnectDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    vpnGone: async () => {
      asked.push("vpnGone");
      if (gone instanceof Error) throw gone;
      return gone;
    },
    access: async () => {
      asked.push("access");
      if (access instanceof Error) throw access;
      return access;
    },
  };
}

describe("Connect when Neoxify starts, on a phone", () => {
  it("goes over nothing, with the consent already given", async () => {
    expect(await phoneAutoConnect(SCREEN, deps(true, { granted: true }))).toEqual({ go: true, ikev2: true });
  });

  it("asks the phone nothing when the screen already says no", async () => {
    const d = deps(true, { granted: true });
    expect(await phoneAutoConnect({ ...SCREEN, enabled: false }, d)).toEqual({ go: false, why: "off" });
    expect(await phoneAutoConnect({ ...SCREEN, disclosureAccepted: false }, d)).toEqual({ go: false, why: "disclosure" });
    expect(await phoneAutoConnect({ ...SCREEN, state: "connected" }, d)).toEqual({ go: false, why: "notIdle" });
    expect(await phoneAutoConnect({ ...SCREEN, reconnecting: true }, d)).toEqual({ go: false, why: "busy" });
    expect(await phoneAutoConnect({ ...SCREEN, subscriptionStatus: "EXPIRED" }, d)).toEqual({ go: false, why: "notEntitled" });
    expect(await phoneAutoConnect({ ...SCREEN, deviceLimitNotice: true }, d)).toEqual({ go: false, why: "deviceLimit" });
    expect(d.asked).toEqual([]);
  });

  it("never dials over another VPN", async () => {
    expect(await phoneAutoConnect(SCREEN, deps(false, { granted: true }))).toEqual({ go: false, why: "otherVpn" });
    expect(await phoneAutoConnect(SCREEN, deps(true, { granted: true, chosenElsewhere: true }))).toEqual({
      go: false,
      why: "otherVpn",
    });
  });

  it("never raises the system's consent: without it, nothing is dialled", async () => {
    expect(await phoneAutoConnect(SCREEN, deps(true, { granted: false }))).toEqual({ go: false, why: "permission" });
  });

  it("passes over IKEv2 where dialling it would raise iOS's prompt", async () => {
    expect(await phoneAutoConnect(SCREEN, deps(true, { granted: true, ikev2: false }))).toEqual({ go: true, ikev2: false });
  });

  it("takes a question nobody answered as a no", async () => {
    expect(await phoneAutoConnect(SCREEN, deps(new Error("x"), { granted: true }))).toEqual({ go: false, why: "unreadable" });
    expect(await phoneAutoConnect(SCREEN, deps(true, new Error("x")))).toEqual({ go: false, why: "unreadable" });
  });
});

describe("speeds from the platform's running totals", () => {
  it("are nothing where nothing counted -- never a zero", () => {
    expect(trafficFromTotals(null, { rxBytes: null, txBytes: null }, 1_000)).toEqual({ reading: null, raw: null });
    expect(trafficFromTotals(null, null, 1_000)).toEqual({ reading: null, raw: null });
    expect(trafficFromTotals(null, { rxBytes: -1, txBytes: 5 }, 1_000).raw).toBeNull();
  });

  it("start with the totals and no rate, then a rate per second", () => {
    const first = trafficFromTotals(null, { rxBytes: 1_000, txBytes: 500 }, 10_000);
    expect(first.raw).toEqual({ rx_bytes: 1_000, tx_bytes: 500, rx_per_sec: null, tx_per_sec: null });
    const second = trafficFromTotals(first.reading, { rxBytes: 3_000, txBytes: 1_500 }, 12_000);
    expect(second.raw).toEqual({ rx_bytes: 3_000, tx_bytes: 1_500, rx_per_sec: 1_000, tx_per_sec: 500 });
  });

  it("make no rate across a new tunnel or a gap", () => {
    const before = { rx: 5_000, tx: 5_000, at: 10_000 };
    expect(trafficFromTotals(before, { rxBytes: 100, txBytes: 100 }, 11_000).raw?.rx_per_sec).toBeNull();
    expect(trafficFromTotals(before, { rxBytes: 9_000, txBytes: 9_000 }, 30_000).raw?.rx_per_sec).toBeNull();
    expect(trafficFromTotals(before, { rxBytes: 9_000, txBytes: 9_000 }, 10_100).raw?.rx_per_sec).toBeNull();
  });
});

describe("a lost session's end", () => {
  it("is now when the loss was seen", () => {
    expect(lostSessionEnd(50_000, null, null)).toBe(50_000);
    // In front the whole time: no return to speak of.
    expect(lostSessionEnd(50_000, null, 10_000)).toBe(50_000);
  });

  it("is when the app last saw it up, when it was found gone on coming back", () => {
    expect(lostSessionEnd(100_000, 20_000, 95_000)).toBe(20_000);
  });

  it("is now when the loss came long after coming back, or while still away", () => {
    expect(lostSessionEnd(100_000 + FOUND_ON_RETURN_MS + 1, 20_000, 100_000)).toBe(100_000 + FOUND_ON_RETURN_MS + 1);
    expect(lostSessionEnd(100_000, 60_000, 10_000)).toBe(100_000);
  });
});

describe("nothing is offered before the page honours it", () => {
  const dashboard = source("../screens/Dashboard.tsx");
  const app = source("../App.tsx");

  it("the flag is set exactly when the phone's main page calls the hook", () => {
    expect(dashboard.includes("usePhoneMainExtras(")).toBe(PHONE_MAIN_PAGE_EXTRAS);
  });

  it("Settings' Connect at start and Activity's session log follow the flag", () => {
    expect("autoConnect" in PHONE_DEVICE).toBe(PHONE_MAIN_PAGE_EXTRAS);
    expect(app).toContain("sessionLog={PHONE_MAIN_PAGE_EXTRAS}");
  });

  it("a run that does not open on the main page signed in connects nothing on start; a sign-out wipes the log", () => {
    expect(app.match(/autoConnectLatch\.disarm\(\);/g)?.length).toBe(4);
    expect(app).toContain("void sessionLog.wipe();");
  });
});
