import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, type TranslationKey } from "@shared/lib/i18n";
import { notificationsRowView } from "@shared/screens/Settings";
import { PHONE_DEVICE, noticesFor, readNotifyState } from "./phone-notices";

/** The phone's "Notify me when the connection changes": the words the
 * native side posts, the system's answer as Settings reads it, and what
 * the phone binds. The posting itself is Kotlin and Swift (Notices.kt,
 * TunnelNotice), run only on a device. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tIn = (language: "en" | "fa") => (key: TranslationKey) => DICTIONARIES[language][key];

describe("the words handed to the native side", () => {
  it("are the app's, in its language, for both platforms", () => {
    for (const platform of ["android", "ios"] as const) {
      const en = noticesFor(tIn("en"), true, platform);
      const fa = noticesFor(tIn("fa"), true, platform);
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        if (key === "enabled" || key === "title") continue;
        expect(en[key], `${platform} ${key}`).toBeTruthy();
        expect(fa[key], `${platform} ${key}`).not.toBe(en[key]);
        expect(String(fa[key]), `${platform} ${key}`).toMatch(/[؀-ۿ]/);
      }
      expect(en.title).toBe("Neoxify");
    }
  });

  it("carry the setting as it is, on or off", () => {
    expect(noticesFor(tIn("en"), true, "android").enabled).toBe(true);
    expect(noticesFor(tIn("en"), false, "ios").enabled).toBe(false);
  });

  it("name the platform that turned the VPN off", () => {
    expect(noticesFor(tIn("en"), true, "android").offBody).toMatch(/Android/);
    expect(noticesFor(tIn("en"), true, "ios").offBody).not.toMatch(/Android/);
  });

  // The ongoing notification is posted the moment the tunnel exists, long
  // before the app has checked anything: it may state a fact about the
  // tunnel and nothing more (product rule: never a state not measured).
  it("never claim protection or a verified connection", () => {
    for (const language of ["en", "fa"] as const) {
      const n = noticesFor(tIn(language), true, "android");
      for (const text of [n.starting, n.on, n.offTitle, n.offBody, n.stoppedTitle, n.stoppedBody]) {
        expect(text).not.toMatch(/protected|secure|safe|connected/i);
        expect(text).not.toContain("محافظت");
        expect(text).not.toContain("متصل");
      }
    }
  });
});

describe("the system's answer", () => {
  it("is one of the three the plugins send, or unknown", () => {
    expect(readNotifyState({ state: "enabled" })).toBe("enabled");
    expect(readNotifyState({ state: "canAsk" })).toBe("canAsk");
    expect(readNotifyState({ state: "disabledForApp" })).toBe("disabledForApp");
    expect(readNotifyState({ state: "granted" })).toBe("unknown");
    expect(readNotifyState(null)).toBe("unknown");
    expect(readNotifyState(undefined)).toBe("unknown");
  });

  it("asks only while the switch is on and the system can still be asked", () => {
    const base = { checked: true, platform: "android" as const, canRequest: true, canOpen: true };
    expect(notificationsRowView({ ...base, os: "canAsk" })).toEqual({ hint: "set.notifsCanAsk", blocked: true, action: "ask" });
    expect(notificationsRowView({ ...base, os: "disabledForApp" })).toEqual({
      hint: "set.notifsOffPhone",
      blocked: true,
      action: "open",
    });
    expect(notificationsRowView({ ...base, os: "enabled" })).toEqual({
      hint: "set.notificationsHintAndroid",
      blocked: false,
      action: null,
    });
    // Off: what the system would do does not matter, and nothing is asked.
    expect(notificationsRowView({ ...base, checked: false, os: "canAsk" }).action).toBeNull();
    expect(notificationsRowView({ ...base, checked: false, os: "disabledForApp" }).action).toBeNull();
    // A question that could not be read says nothing it does not know.
    expect(notificationsRowView({ ...base, os: "unknown" }).blocked).toBe(false);
    expect(notificationsRowView({ ...base, platform: "ios", os: "enabled" }).hint).toBe("set.notificationsHintIos");
  });

  it("keeps Windows' own wording on Windows", () => {
    const view = notificationsRowView({ checked: true, os: "disabledForApp", platform: "windows", canRequest: false, canOpen: false });
    expect(view).toEqual({ hint: "set.notifsOffApp", blocked: true, action: null });
  });
});

describe("what the phone binds", () => {
  it("is notifications only: the rows a phone does not honour are not drawn", () => {
    expect(Object.keys(PHONE_DEVICE)).toEqual(["notifications"]);
    expect(PHONE_DEVICE.notifications?.setting).toBeTypeOf("function");
    expect(PHONE_DEVICE.notifications?.request).toBeTypeOf("function");
    expect(PHONE_DEVICE.notifications?.openSettings).toBeTypeOf("function");
  });

  it("hands the words over once the setting is read, again on a change, and passes the binding to Settings", () => {
    const app = source("../App.tsx");
    expect(app).toContain("void appPrefs.load().then(() => alive && setPrefsLoaded(true));");
    expect(app).toContain("if (!prefsLoaded) return;");
    expect(app).toContain("void setNotices(noticesFor(t, prefs.notifications, platform)).catch(() => undefined);");
    expect(app).toContain("}, [prefsLoaded, prefs.notifications, language]);");
    expect(app).toContain("device={isAndroid() || isIOS() ? PHONE_DEVICE : undefined}");
  });

  it("is answered by a command the app registers, for every one it calls", () => {
    const rust = source("../../src-tauri/src/lib.rs");
    for (const command of [
      "vpn_set_notices",
      "vpn_notification_state",
      "vpn_request_notifications",
      "vpn_open_notification_settings",
    ]) {
      expect(rust, command).toContain(`tauri_plugin_neoxify_vpn::${command},`);
      expect(source("./phone-notices.ts"), command).toContain(`"${command}"`);
    }
  });
});

describe("the native side", () => {
  const kotlin = (name: string) => source(`../../plugins/vpn/android/src/main/java/com/neoxify/vpn/${name}`);
  const swift = (path: string) => source(`../../plugins/vpn/${path}`);

  it("Android says 'VPN is on' only once the engine is up, and 'turned off' only for a stop it did not ask for", () => {
    const service = kotlin("NeoxifyTunService.kt");
    expect(service).toContain("startForeground(Notices.STATUS_ID, Notices.status(this, up = false))");
    expect(service).toMatch(/publish\(STATE_UP, null\)[\s\S]{0,400}Notices\.updateStatus\(this, up = true\)/);
    expect(service).toContain("if (!stopAsked && started) Notices.postTurnedOff(this)");
    expect(service).not.toContain('setContentText("Connected")');
    const plugin = kotlin("NeoxifyVpnPlugin.kt");
    expect(plugin).toContain("if (!ours) Notices.postTurnedOff(activity.applicationContext)");
    // Every change of WireGuard's state this app makes is marked as its own.
    expect(plugin).not.toMatch(/[^{] backend\.setState\(/);
    expect(plugin.match(/ourOwn \{ backend\.setState\(/g)?.length).toBe(5);
  });

  it("Android posts nothing with the setting off, the app in front, or notifications blocked", () => {
    const notices = kotlin("Notices.kt");
    expect(notices).toContain("if (!text.enabled || appInFront(context)) return");
    expect(notices).toContain("if (!manager.areNotificationsEnabled()) return");
  });

  it("Android asks only from a press, and only where the question would still show", () => {
    const plugin = kotlin("NeoxifyVpnPlugin.kt");
    expect(plugin).toContain('if (Build.VERSION.SDK_INT < 33 || notificationStateNow() != "canAsk") {');
    expect(plugin).toContain('requestPermissionForAlias(NOTIFICATIONS_ALIAS, invoke, "notificationsAnswered")');
  });

  it("iOS says nothing for a stop the app asked for, or with the setting off", () => {
    const extension = swift("tunnel/Sources/NeoxifyTunnel/PacketTunnelProvider.swift");
    expect(extension).toContain('defaults.bool(forKey: "notices.enabled") else { return done() }');
    expect(extension).toContain('if Date().timeIntervalSince1970 < defaults.double(forKey: "notices.ownStopUntil") { return done() }');
    const plugin = swift("ios/Sources/NeoxifyVpnPlugin/NeoxifyVpnPlugin.swift");
    // Both of the app's own stops mark themselves first.
    expect(plugin.match(/TunnelNotices\.ownStopComing\(\)/g)?.length).toBe(2);
  });
});
