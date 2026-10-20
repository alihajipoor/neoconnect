import { invoke } from "@tauri-apps/api/core";

/** "Open Neoxify when I sign in to Windows" (src-tauri/src/autostart.rs).
 *
 * Windows holds the answer, not the app: the switch is read from the Run
 * key every time Settings opens, so it says what Windows will do -- off
 * when the customer switched Neoxify off in Task Manager's Startup apps,
 * or when the value names an install somewhere else. A write answers with
 * what Windows says afterwards, which is what the switch then shows. */
export interface AutostartBinding {
  read: () => Promise<boolean>;
  write: (enabled: boolean) => Promise<boolean>;
}

export const windowsAutostart: AutostartBinding = {
  read: () => invoke<boolean>("autostart_state"),
  write: (enabled) => invoke<boolean>("set_autostart", { enabled }),
};

