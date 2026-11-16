// Which desktop shell is running this shared interface. The Windows app,
// the macOS shell and the Linux app all render these same screens, but
// they do not all carry the same features: the Linux first version, for
// instance, has no per-app split tunnelling. Each app's entry file sets
// the platform once, before it renders, and the screens ask the helpers
// below instead of assuming Windows. The default is "windows" so the app
// that ships to live users behaves exactly as it did before this existed.

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

// Per-app split tunnelling (Custom mode) needs the Windows packet filter
// the service drives; the Linux helper has no equivalent yet.
export function supportsCustomMode(): boolean {
  return current === "windows";
}

// Gaming mode rides on the same Windows-only machinery.
export function supportsGaming(): boolean {
  return current === "windows";
}

// Repair and Diagnostics run Windows network resets through the service.
export function supportsRepair(): boolean {
  return current === "windows";
}

// The reconnect hold keeps Windows Filtering Platform filters across a
// drop; the Linux helper does not implement it in the first version.
export function supportsReconnectHold(): boolean {
  return current === "windows";
}

// Only the Windows build installs its own updates. Elsewhere the app can
// say a new version exists and send the customer to the download page.
export function supportsSelfUpdate(): boolean {
  return current === "windows";
}

// IKEv2 goes through the Windows system client; Linux has no route for
// it in the first version, so it is simply never offered there.
export function offersIkev2(): boolean {
  return current !== "linux";
}
