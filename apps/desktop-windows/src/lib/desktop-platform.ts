// Which desktop shell is running this shared interface. The Windows app,
// the macOS shell and the Linux app all render these same screens, but
// they do not all carry the same features: Linux has no gaming mode, for
// instance, and the macOS shell has none of the helper's features. Each
// app's entry file sets the platform once, before it renders, and the
// screens ask the helpers below instead of assuming Windows. The default
// is "windows" so the app that ships to live users behaves exactly as it
// did before this existed.

export type DesktopPlatform = "windows" | "linux" | "macos";

let current: DesktopPlatform = "windows";

/** Called once by an app's entry file, before the first render. */
export function setDesktopPlatform(p: DesktopPlatform): void {
  current = p;
}

export function desktopPlatform(): DesktopPlatform {
  return current;
}

export function isWindows(): boolean {
  return current === "windows";
}

export function isLinux(): boolean {
  return current === "linux";
}

// Per-app split tunnelling (Custom mode): the Windows service's packet
// redirect, and on Linux the helper's control groups (cgroup v2).
export function supportsCustomMode(): boolean {
  return current === "windows" || current === "linux";
}

// The game catalogue inside Custom mode: adding a game by name, its
// program groups, and a game's own exit carried as an extra exit on the
// same connection. The catalogue names Windows programs, so it means
// nothing on Linux, where Custom mode is the chosen programs alone.
export function supportsGameCatalogue(): boolean {
  return current === "windows";
}

// Gaming mode rides on Windows-only machinery, and Linux does not have it.
export function supportsGaming(): boolean {
  return current === "windows";
}

// Repair and Diagnostics: Windows network resets through the service, and
// on Linux the helper's own sweep of what Neoxify can leave behind.
export function supportsRepair(): boolean {
  return current === "windows" || current === "linux";
}

// The reconnect hold: Windows Filtering Platform filters kept across a
// drop, and on Linux the leak-protection nftables table with the hold's
// contents swapped in.
export function supportsReconnectHold(): boolean {
  return current === "windows" || current === "linux";
}

// Windows installs its updates through Tauri's updater. Linux hands a
// signed package to its helper, which installs it with the system's
// package manager (lib/linux-update.ts). The macOS shell can only say a
// new version exists and send the customer to the download page.
export function supportsSelfUpdate(): boolean {
  return current === "windows" || current === "linux";
}

// IKEv2 goes through the Windows system client, and on Linux through the
// distribution's strongSwan, which the helper drives.
export function offersIkev2(): boolean {
  return true;
}
