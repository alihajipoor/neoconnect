import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { Settings, type DeviceSettings, type SettingsPlatform } from "../screens/Settings";

/** Settings draws a device row only where the platform does what it says
 * (owner, 2026-10-19: "make sure every single part of the app works
 * properly" -- no "Not built yet" ships), and the main page does what the
 * rows say. Read from the source where the wiring has no harness of its
 * own: a line deleted from either would leave every unit test passing. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const noop = () => undefined;

function render(platform: SettingsPlatform, device?: DeviceSettings): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(Settings, {
        onBack: noop,
        onOpenReferrals: noop,
        onOpenSupport: noop,
        onLoggedOut: noop,
        customSection: null,
        platform,
        device,
      }),
    ),
  );
}

const WINDOWS: DeviceSettings = {
  autostart: { read: async () => false, write: async () => false },
  autoConnect: true,
  notifications: {},
  reconnectHold: { apply: async () => undefined },
};

const ROWS = [
  "Open Neoxify when I sign in to Windows",
  "Connect when Neoxify starts",
  "Block the internet while reconnecting",
  "Notify me when the connection changes",
];

describe("Settings' device rows", () => {
  it("are all there on Windows, which binds every one", () => {
    const html = render("windows", WINDOWS);
    for (const row of ROWS) expect(html, row).toContain(row);
  });

  it("are not drawn where nothing is bound: a phone before its main page honours them, and the web portal", () => {
    for (const platform of ["android", "ios", "web"] as const) {
      const html = render(platform);
      for (const row of ROWS) expect(html, `${platform}: ${row}`).not.toContain(row);
    }
  });

  it("on a phone, only the one it binds: notifications, from the tunnel's own side", () => {
    for (const platform of ["android", "ios"] as const) {
      const html = render(platform, { notifications: {} });
      expect(html, platform).toContain("Notify me when the connection changes");
      for (const row of ROWS.slice(0, 3)) expect(html, `${platform}: ${row}`).not.toContain(row);
    }
    expect(render("android", { notifications: {} })).toContain("Tells you when Android or another VPN app turns off");
    expect(render("ios", { notifications: {} })).toContain("Tells you when Neoxify&#x27;s VPN stops");
  });

  it("never say Not built yet", () => {
    const html = render("windows", WINDOWS);
    expect(html).not.toMatch(/Not built yet/);
    for (const path of ["../screens/Settings.tsx", "../screens/Activity.tsx", "../components/ui.tsx"]) {
      expect(source(path), path).not.toMatch(/notBuilt|NotBuiltTag|set\.notBuilt/);
    }
  });

  it("are bound by the Windows app, and by the phone's for notifications only", () => {
    const app = source("../App.tsx");
    expect(app).toContain("device={WINDOWS_DEVICE}");
    expect(app).toMatch(/autostart: windowsAutostart,\s+autoConnect: true,\s+notifications: \{ setting: notificationSetting \},/);
    // The reconnect hold only where the build offers it (reconnect-hold.wiring.test.ts).
    expect(app).toContain('reconnectHold: { apply: (enabled: boolean) => invoke<void>("vpn_set_reconnect_hold", { enabled }) }');
    const phone = source("../../../mobile/src/App.tsx");
    expect(phone.match(/\bdevice=\{/g)?.length).toBe(1);
    expect(phone).toContain("device={isAndroid() || isIOS() ? PHONE_DEVICE : undefined}");
    expect(source("../../../mobile/src/lib/phone-notices.ts")).toMatch(
      /export const PHONE_DEVICE: DeviceSettings = \{\s+notifications: \{/,
    );
  });
});

describe("the main page does what the rows say", () => {
  const dashboard = source("../screens/Dashboard.tsx");

  it("connects at launch once, over nothing, as the customer's own Connect", () => {
    expect(dashboard).toContain("if (!alive || !autoConnectLatch.take()) return;");
    expect(dashboard).toContain("const decision = autoConnectDecision({");
    expect(dashboard).toContain("state: connectionStateRef.current,");
    // No takeover: the device slot is never taken from another device.
    expect(dashboard).toContain("void connectNowRef.current().finally(() => setAutoConnecting(false));");
    const app = source("../App.tsx");
    expect(app.match(/autoConnectLatch\.disarm\(\);/g)?.length).toBe(3);
  });

  it("sends the reconnect hold's setting with every connect, and keeps or lets go of it as the pass goes", () => {
    expect(dashboard).toContain("blockWhileReconnecting: holdWanted(appPrefs.current().blockWhileReconnecting),");
    expect(dashboard.match(/await takeDown\(\)\.catch\(\(\) => undefined\);/g)?.length).toBe(2);
    expect(dashboard).toContain('await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect").catch(() => undefined);');
    expect(dashboard).toContain(
      "await (options.reconnect && holdThrough ? holdService.disconnectKeepingHold() : serviceDisconnect()).catch(() => undefined);",
    );
    expect(dashboard).toMatch(
      /publishObserved\(intent, verdict\);\s+\/\/ A tunnel is up[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s+if \(holdWanted\(appPrefs\.current\(\)\.blockWhileReconnecting\)\) void releaseOnLanding\(verdict\);/,
    );
    expect(source("../App.tsx")).toContain("return watchEpisodesForHold({");
  });

  it("reads the hold and the counters from every status it takes", () => {
    expect(dashboard.match(/noteStatus\(status\);/g)?.length).toBe(3);
    // The read that finds a drop included: it is the one that says whether
    // the service holds the internet for it.
    expect(dashboard).toContain("if (status !== null) noteStatus(status);");
  });

  it("notifies from the calm tone, only with the setting on and the window not in front", () => {
    expect(dashboard).toContain("const step = notifyStep(notifyMemory.current(), {");
    // Another page of the shell does not say the state: as for a window behind.
    expect(dashboard).toContain('focused: typeof document !== "undefined" && document.hasFocus() && onMainPage,');
    expect(dashboard).toContain("if (step.say === null || !appPrefs.current().notifications) return;");
  });

  it("shows the speed only while the counters are read, and the rung and the countdown while it gets somewhere", () => {
    expect(dashboard).toContain("speed={trafficShown ? <SpeedSection /> : undefined}");
    expect(dashboard).toContain("<ProgressLine routes={routes} autoConnecting={autoConnecting} />");
    expect(dashboard).toContain("ladderProgress.rung({");
    expect(dashboard).toContain("ladderProgress.ended(generation);");
  });
});
