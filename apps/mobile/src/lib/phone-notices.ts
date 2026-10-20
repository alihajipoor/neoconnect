import { invoke } from "@tauri-apps/api/core";
import type { NotifySetting } from "@shared/lib/notify";
import type { TranslationKey } from "@shared/lib/i18n";
import type { DeviceSettings } from "@shared/screens/Settings";
import { PHONE_MAIN_PAGE_EXTRAS } from "./phone-main-extras";

/** "Notify me when the connection changes", on a phone.
 *
 * The app's JavaScript does not run while it is in the background -- the
 * Android tunnel lives in its own service, iOS suspends the app within
 * seconds -- so the notifications come from the native side that is still
 * running: the Android tunnel service and the WireGuard library's callback
 * (plugins/vpn/android Notices.kt), and the iOS packet-tunnel extension
 * (TunnelNotice in PacketTunnelProvider.swift). What they say is narrower
 * than the Windows client's, and the Settings hint says exactly that:
 *
 *  - Android: "VPN turned off", when Android or another VPN app takes the
 *    tunnel away with Neoxify in the background; and, as Android requires
 *    of any VPN service, the ongoing "VPN is on" while an Xray tunnel runs
 *    ("Starting the VPN..." until its engine is up -- a fact about the
 *    tunnel, never "protected", which only the app's egress check says);
 *  - iOS: "VPN turned off" when another VPN or Settings turns it off, and
 *    "VPN stopped" when it stops by itself.
 *
 * Nothing here decides when; this hands the native side the words, in the
 * app's language, and the setting -- again whenever either changes. */

export interface Notices {
  enabled: boolean;
  statusChannel: string;
  changesChannel: string;
  title: string;
  starting: string;
  on: string;
  offTitle: string;
  offBody: string;
  stoppedTitle: string;
  stoppedBody: string;
}

export type PhonePlatform = "android" | "ios";

export function noticesFor(
  t: (key: TranslationKey) => string,
  enabled: boolean,
  platform: PhonePlatform,
): Notices {
  return {
    enabled,
    statusChannel: t("notif.statusChannel"),
    changesChannel: t("notif.changesChannel"),
    // The product's name, as the system shows it beside every
    // notification; not a sentence to translate.
    title: "Neoxify",
    starting: t("notif.starting"),
    on: t("notif.on"),
    offTitle: t("notif.offTitle"),
    offBody: t(platform === "ios" ? "notif.offBodyIos" : "notif.offBodyAndroid"),
    stoppedTitle: t("notif.stoppedTitle"),
    stoppedBody: t("notif.stoppedBody"),
  };
}

export const setNotices = (notices: Notices) => invoke<void>("vpn_set_notices", { notices });

/** The plugin's word for the system's setting, as Settings reads it. Any
 * other answer -- an older plugin, a failed call -- is "unknown", which
 * says nothing rather than something untrue. */
export function readNotifyState(raw: unknown): NotifySetting {
  const state = raw !== null && typeof raw === "object" ? (raw as { state?: unknown }).state : undefined;
  return state === "enabled" || state === "canAsk" || state === "disabledForApp" ? state : "unknown";
}

export const notificationState = (): Promise<NotifySetting> =>
  invoke<unknown>("vpn_notification_state").then(readNotifyState, () => "unknown");

/** The system's own question, where it can still be asked. Only from the
 * customer's press in Settings. */
export const requestNotifications = (): Promise<NotifySetting> =>
  invoke<unknown>("vpn_request_notifications").then(readNotifyState, () => "unknown");

export const openNotificationSettings = () => invoke<void>("vpn_open_notification_settings");

/** What a phone binds of Settings' device rows: notifications, and
 * "Connect when Neoxify starts" once the phone's main page honours it
 * (`PHONE_MAIN_PAGE_EXTRAS`, lib/phone-main-extras.ts).
 *
 * The others are not bound, so they are not drawn: Windows' "open at
 * sign-in" has no phone counterpart (Android's always-on VPN stops this
 * app's service, and iOS's on-demand rules are cleared on purpose), and
 * blocking the internet while reconnecting is the Windows service's. */
export const PHONE_DEVICE: DeviceSettings = {
  notifications: {
    setting: notificationState,
    request: requestNotifications,
    openSettings: openNotificationSettings,
  },
  ...(PHONE_MAIN_PAGE_EXTRAS ? { autoConnect: true } : {}),
};
