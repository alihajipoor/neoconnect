import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Linux app shares this interface with Windows, and its first version
 * has less: no Custom mode, no gaming mode, no Repair or Diagnostics, no
 * reconnect hold, no IKEv2, no self-update. Each is missing by not being
 * offered and by never being asked of the helper. And with the platform at
 * its default the Windows app, which ships to live users from these files,
 * must be exactly what it was. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const platform = await import("./desktop-platform");
const { setDesktopPlatform, desktopPlatform } = platform;
const { I18nProvider } = await import("./i18n");
const { Settings } = await import("../screens/Settings");
const { holdWanted } = await import("./reconnect-hold");
const { desktopTeardownDeps } = await import("./tunnel-teardown");
const { orderCandidates, offeredUsers } = await import("./failover");
const { classifyConnectionError } = await import("./connection-errors");
const { detectPlatform } = await import("./attempts");
const { reachesServerAround } = await import("./tunnel-server");
const { webviewVersion, resetEngineNoteForTests } = await import("./webview-engine");
import type { DeviceSettings, SettingsPlatform } from "../screens/Settings";
import type { Protocol, ProtocolUser } from "./types";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const noop = () => undefined;

function renderSettings(p: SettingsPlatform, sections: { custom: boolean; gaming: boolean }, device: DeviceSettings): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(Settings, {
        onBack: noop,
        onOpenReferrals: noop,
        onOpenSupport: noop,
        onLoggedOut: noop,
        customSection: sections.custom ? createElement("div") : null,
        gamingSection: sections.gaming ? createElement("div") : undefined,
        platform: p,
        device,
      }),
    ),
  );
}

const DESKTOP_DEVICE: DeviceSettings = {
  autostart: { read: async () => false, write: async () => false },
  autoConnect: true,
  notifications: {},
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  setDesktopPlatform("windows");
  resetEngineNoteForTests();
});

describe("the default platform", () => {
  it("is Windows, with every feature it has today", () => {
    expect(desktopPlatform()).toBe("windows");
    expect(platform.supportsCustomMode()).toBe(true);
    expect(platform.supportsGaming()).toBe(true);
    expect(platform.supportsRepair()).toBe(true);
    expect(platform.supportsReconnectHold()).toBe(true);
    expect(platform.supportsSelfUpdate()).toBe(true);
    expect(platform.offersIkev2()).toBe(true);
  });

  it("leaves Windows' requests and choices as they were", async () => {
    expect(holdWanted(true)).toBe(true);
    await desktopTeardownDeps.disarmGaming();
    expect(invoke).toHaveBeenCalledWith("gaming_disarm", undefined);
    const users = [user("a", "IKEV2"), user("b", "WIREGUARD")];
    expect(offeredUsers(users)).toBe(users);
    expect(orderCandidates(users).map((u) => u.protocol)).toEqual(["WIREGUARD", "IKEV2"]);
    expect(classifyConnectionError("the background service is not running").messageKey).toBe("err.serviceUnavailable");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)", 0)).toBe("unknown");
  });

  it("draws Windows' Settings as before", () => {
    const html = renderSettings("windows", { custom: true, gaming: true }, {
      ...DESKTOP_DEVICE,
      reconnectHold: { apply: async () => undefined },
    });
    for (const row of [
      "Open Neoxify when I sign in to Windows",
      "Leak protection",
      "Gaming mode",
      "Custom mode",
      "Repair network",
      "Block the internet while reconnecting",
      "doesn&#x27;t do this in Gaming mode",
    ]) {
      expect(html, row).toContain(row);
    }
  });
});

describe("on Linux", () => {
  beforeEach(() => setDesktopPlatform("linux"));

  it("offers none of what its first version lacks", () => {
    expect(platform.supportsCustomMode()).toBe(false);
    expect(platform.supportsGaming()).toBe(false);
    expect(platform.supportsRepair()).toBe(false);
    expect(platform.supportsReconnectHold()).toBe(false);
    expect(platform.supportsSelfUpdate()).toBe(false);
    expect(platform.offersIkev2()).toBe(false);
  });

  it("Settings has autostart, notifications and leak protection, and nothing it cannot do", () => {
    // Bound as Windows binds it, hold included: Settings drops what Linux lacks.
    const html = renderSettings("linux", { custom: false, gaming: false }, {
      ...DESKTOP_DEVICE,
      reconnectHold: { apply: async () => undefined },
    });
    expect(html).toContain("Open Neoxify when I sign in");
    expect(html).toContain("sign in to this computer");
    expect(html).toContain("Notify me when the connection changes");
    expect(html).toContain("Connect when Neoxify starts");
    expect(html).toContain("Leak protection");
    for (const missing of [
      "Windows",
      "Gaming mode",
      "Custom mode",
      "Repair network",
      "Block the internet while reconnecting",
      "Modes",
    ]) {
      expect(html, missing).not.toContain(missing);
    }
  });

  it("never asks the helper for a hold, a gaming disarm or the WebView2 version", async () => {
    expect(holdWanted(true)).toBe(false);
    await desktopTeardownDeps.disarmGaming();
    expect(await webviewVersion()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves IKEv2 out of the automatic order and out of the server list", () => {
    const users = [user("a", "IKEV2"), user("b", "WIREGUARD"), user("c", "OPENVPN")];
    expect(orderCandidates(users).map((u) => u.protocol)).toEqual(["WIREGUARD", "OPENVPN"]);
    expect(orderCandidates(users, { pinnedRouteId: "a" }).map((u) => u.routeId)).not.toContain("a");
    expect(offeredUsers(users).map((u) => u.protocol)).toEqual(["WIREGUARD", "OPENVPN"]);
  });

  it("says what helps when the service is not running: restart the computer, or install again", () => {
    const shown = classifyConnectionError("the background service is not running");
    expect(shown.kind).toBe("serviceUnavailable");
    expect(shown.messageKey).toBe("err.serviceUnavailableLinux");
  });

  it("counts a Linux user agent as Linux, and reaches servers as Windows does", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", 0)).toBe("linux");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe("android");
    for (const protocol of ["XRAY_VLESS_REALITY", "SHADOWSOCKS", "OPENVPN", "WIREGUARD"]) {
      expect(reachesServerAround("linux", protocol), protocol).toBe(reachesServerAround("windows", protocol));
    }
    expect(reachesServerAround("linux", "WIREGUARD")).toBe(false);
  });
});

/** The call sites, read from source: these sit deep in the Dashboard's
 * connect pass and the app's start-up, which have no harness of their own,
 * and a guard deleted from any of them would leave every test above
 * passing while a Linux session sent the request. */
describe("the guarded call sites", () => {
  const app = source("../App.tsx");
  const dash = source("../screens/Dashboard.tsx");
  const support = source("../screens/Support.tsx");

  it("App passes the platform, and the optional sections only where they exist", () => {
    expect(app).toContain("platform={desktopPlatform()}");
    expect(app).toContain("customSection={supportsCustomMode() ? <CustomModeCard /> : null}");
    expect(app).toContain("gamingSection={supportsGaming() ? <GamingModeCard /> : undefined}");
    expect(app).toMatch(/if \(!supportsReconnectHold\(\)\) return undefined;\s+return watchEpisodesForHold/);
    expect(app).not.toContain('platform="windows"');
  });

  it("never calls the updater where the app cannot install its own updates", () => {
    expect(app).toContain("supportsSelfUpdate() ? startUpdateChecks(setUpdateState) : startUpdateNotices(setUpdateState)");
    expect(source("./update-notice.ts")).not.toMatch(/plugin-updater/);
  });

  it("the Dashboard sends no split-tunnel, gaming or probe request on Linux, and offers no repair", () => {
    expect(dash).toMatch(/if \(!onMainPage\) return;\s+\/\/[^\n]*\n\s+if \(!supportsCustomMode\(\)\) return;\s+loadSplitTunnel\(\)/);
    expect(dash).toMatch(/if \(supportsCustomMode\(\)\) \{\s+try \{\s+const settings = await loadSplitTunnel\(\);/);
    expect(dash).toContain("if (status.splitTunnelActive && supportsCustomMode()) {");
    expect(dash).toContain("const customMode = supportsCustomMode() && Boolean(status.splitTunnelActive);");
    expect(dash).toMatch(/if \(!supportsGaming\(\)\) return undefined;\s+let cancelled = false;\s+void loadGaming\(\)/);
    expect(dash).toContain('if (next === "vpn" && supportsGaming()) {');
    expect(dash).toContain("{supportsGaming() ? <Segmented");
    expect(dash).toContain("|| !supportsRepair() ? null : <RepairNetwork");
    // Every split-tunnel push in the pass is behind the settings the guarded
    // read produced, and every probe behind a guarded \`customMode\`.
    expect(dash.match(/pushSplitTunnel\(/g)).toHaveLength(2);
    expect(dash).toMatch(/if \(splitTunnelSettings\) \{\s+await pushSplitTunnel\(/);
  });

  it("Support offers its diagnostics only where the helper has them", () => {
    expect(support).toContain("{supportsRepair() ? <DiagnosticsCard /> : null}");
  });
});

function user(routeId: string, protocol: Protocol): ProtocolUser {
  return { routeId, protocol } as ProtocolUser;
}
