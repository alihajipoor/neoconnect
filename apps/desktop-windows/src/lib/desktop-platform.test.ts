import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Linux app shares this interface with Windows and, since 0.2, has
 * what Windows has but gaming mode and Custom mode's game catalogue (with
 * its per-game exits): each of those is missing by not being offered and
 * by never being asked of the helper. And with the platform at its default
 * the Windows app, which ships to live users from these files, must be
 * exactly what it was. */

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
const { webviewVersion, resetEngineNoteForTests, takeEngineNote, webkitGtkVersion, webkitLine } = await import("./webview-engine");
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
    expect(platform.supportsGameCatalogue()).toBe(true);
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

  it("still notes an old WebView2 on the first report, and asks nothing about WebKitGTK", async () => {
    invoke.mockResolvedValue("100.0.1185.36");
    expect(await takeEngineNote()).toBe("webview 100.0.1185.36");
    expect(invoke).toHaveBeenCalledWith("webview_version", undefined);
    invoke.mockClear();
    expect(await webkitGtkVersion()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
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

  it("offers everything Windows does but gaming mode and the game catalogue", () => {
    expect(platform.supportsCustomMode()).toBe(true);
    expect(platform.supportsRepair()).toBe(true);
    expect(platform.supportsReconnectHold()).toBe(true);
    expect(platform.supportsSelfUpdate()).toBe(true);
    expect(platform.offersIkev2()).toBe(true);
    expect(platform.supportsGaming()).toBe(false);
    expect(platform.supportsGameCatalogue()).toBe(false);
  });

  it("Settings has Custom mode, Repair and the hold, never gaming mode, and names no Windows", () => {
    // What App passes on Linux: Custom mode's card, no gaming section.
    const html = renderSettings("linux", { custom: true, gaming: false }, {
      ...DESKTOP_DEVICE,
      reconnectHold: { apply: async () => undefined },
    });
    for (const row of [
      "Open Neoxify when I sign in",
      "sign in to this computer",
      "Notify me when the connection changes",
      "Connect when Neoxify starts",
      "Leak protection",
      "Custom mode",
      "Modes",
      "Repair network",
      "Block the internet while reconnecting",
    ]) {
      expect(html, row).toContain(row);
    }
    for (const missing of ["Windows", "Gaming mode", "Gaming"]) {
      expect(html, missing).not.toContain(missing);
    }
  });

  it("asks the helper for a hold, never for a gaming disarm or the WebView2 version", async () => {
    expect(holdWanted(true)).toBe(true);
    expect(holdWanted(false)).toBe(false);
    await desktopTeardownDeps.disarmGaming();
    expect(await webviewVersion()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("notes no old engine for WebKitGTK's 2.x, and names it in the diagnostics line", async () => {
    invoke.mockResolvedValue("2.44.0");
    expect(await takeEngineNote()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(webkitLine(await webkitGtkVersion())).toBe("webview: WebKitGTK 2.44.0");
    expect(invoke).toHaveBeenCalledWith("webview_version", undefined);
    resetEngineNoteForTests();
    invoke.mockRejectedValue(new Error("no such command"));
    expect(webkitLine(await webkitGtkVersion())).toBe("webview: WebKitGTK (version could not be read)");
  });

  it("offers IKEv2 in the automatic order and the server list, as Windows does", () => {
    const users = [user("a", "IKEV2"), user("b", "WIREGUARD"), user("c", "OPENVPN")];
    expect(offeredUsers(users)).toBe(users);
    setDesktopPlatform("windows");
    const windowsOrder = orderCandidates(users).map((u) => u.protocol);
    setDesktopPlatform("linux");
    expect(orderCandidates(users).map((u) => u.protocol)).toEqual(windowsOrder);
    expect(orderCandidates(users, { pinnedRouteId: "a" }).map((u) => u.routeId)[0]).toBe("a");
  });

  it("says to install strongSwan when Built-in cannot find it, and only on Linux", () => {
    const shown = classifyConnectionError("charon-cmd is missing from the install: install strongswan");
    expect(shown.kind).toBe("engineMissing");
    expect(shown.messageKey).toBe("err.engineMissingStrongswan");
    expect(classifyConnectionError("xray is missing from the install").messageKey).toBe("err.engineMissing");
    setDesktopPlatform("windows");
    expect(classifyConnectionError("charon-cmd is missing from the install").messageKey).toBe("err.engineMissing");
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

  it("calls Tauri's updater on Windows only: Linux has its own path, and the notice elsewhere", () => {
    expect(app).toMatch(
      /if \(!supportsSelfUpdate\(\)\) return startUpdateNotices\(setUpdateState\);\s+return isLinux\(\) \? startLinuxUpdates\(setUpdateState\) : startUpdateChecks\(setUpdateState\);/,
    );
    expect(app).toMatch(/if \(isLinux\(\)\) \{\s+await applyLinuxUpdate\(setUpdateState\);\s+return;\s+\}\s+await applyStagedUpdate\(true\);/);
    expect(source("./update-notice.ts")).not.toMatch(/plugin-updater/);
    expect(source("./linux-update.ts")).not.toMatch(/plugin-updater/);
  });

  it("the Dashboard sends no per-game exits where there is no catalogue", () => {
    expect(dash).toContain("const concurrent = splitTunnelSettings && supportsGameCatalogue()");
    expect(dash).toMatch(/if \(splitTunnelSettings && supportsGameCatalogue\(\)\) \{\s+await pushSplitTunnel\(/);
    expect(source("./split-tunnel.ts")).toContain(
      "exits: supportsGameCatalogue() ? exitsForGames(settings.games, settings.apps).exits : []",
    );
  });

  it("the Dashboard sends no split-tunnel, gaming or probe request without the feature, and offers no repair", () => {
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
  });

  it("Support offers its diagnostics only where the helper has them", () => {
    expect(support).toContain("{supportsRepair() ? <DiagnosticsCard /> : null}");
  });

  it("Support's engine line is WebView2's on Windows as before, and WebKitGTK's on Linux", () => {
    expect(support).toMatch(/platform === "windows"\s+\? engineLine\(await webviewVersion\(\), chromiumFromUserAgent\(\)\)/);
    expect(support).toContain('platform === "linux"');
    expect(support).toContain("? webkitLine(await webkitGtkVersion())");
  });
});

function user(routeId: string, protocol: Protocol): ProtocolUser {
  return { routeId, protocol } as ProtocolUser;
}
