import { invoke } from "@tauri-apps/api/core";
import type { Language } from "./i18n";

/** Windows toasts (src-tauri/src/notify.rs). What to say and when is
 * lib/connection-notify.ts's; this only hands the words over. */

/** Whether Windows lets Neoxify's notifications show. */
export type NotifySetting = "enabled" | "disabledForApp" | "disabledForUser" | "disabledByPolicy" | "unknown";

export function showNotification(title: string, body: string, language: Language): Promise<void> {
  return invoke<void>("notify_show", { title, body, lang: language });
}

export async function notificationSetting(): Promise<NotifySetting> {
  try {
    const answer = await invoke<string>("notify_setting");
    return answer === "enabled" || answer === "disabledForApp" || answer === "disabledForUser" || answer === "disabledByPolicy"
      ? answer
      : "unknown";
  } catch {
    return "unknown";
  }
}
