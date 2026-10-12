import { describe, expect, it, vi } from "vitest";

// i18n.tsx reaches for Tauri at import time through its store and
// version helpers; none of that is exercised here.
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("test") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("no network")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));

const { DICTIONARIES } = await import("./i18n");

/** The words under the orb when a full tunnel's IPv4 is not confined to
 * it (`warnsUnconfined`, `unconfinedLine`).
 *
 * The line is shown whenever the tunnel is up and unconfined -- which
 * includes "unverified" (no baseline to compare an exit address with) and
 * "degraded" (the egress check failed). It opened with "Your traffic is
 * going through the VPN": a claim the app has not seen in the first and
 * has seen to be false in the second, under a headline saying "Your
 * traffic is NOT protected". It says only what is not covered. */
describe("the line for a tunnel whose IPv4 is not confined", () => {
  for (const key of ["dash.ipv4NotConfined", "dash.ipv4NotConfinedIkev2"] as const) {
    it(`${key} claims nothing about the tunnel carrying traffic`, () => {
      expect(DICTIONARIES.en[key]).not.toMatch(/going through the VPN|goes through (the VPN|Neoxify)|is encrypted/i);
      expect(DICTIONARIES.fa[key]).not.toContain("ترافیک شما از VPN عبور می‌کند");
      expect(DICTIONARIES.fa[key]).not.toContain("ترافیک شما از طریق نئوکسیفای عبور می‌کند");
      // And still says what is not covered.
      expect(DICTIONARIES.en[key]).toContain("connections opened before you connected");
      expect(DICTIONARIES.fa[key]).toContain("اتصال‌هایی که پیش از وصل شدن شما باز شده بودند");
    });
  }
});

/** The mode's own line under the switch said "Everything on this
 * computer goes through Neoxify." beside a warning that some connections
 * on it may go around. While the tunnel is up and not confined, it says
 * what the mode is meant to do and that, right now, it does not hold. */
describe("the VPN mode's line beside that warning", () => {
  it("does not contradict it", () => {
    const en = DICTIONARIES.en["dash.modeVpnHintNotConfined"];
    const fa = DICTIONARIES.fa["dash.modeVpnHintNotConfined"];
    expect(en).toBeTruthy();
    expect(fa).toBeTruthy();
    expect(en).not.toBe(DICTIONARIES.en["dash.modeVpnHint"]);
    expect(en).toMatch(/go around/);
  });
});
