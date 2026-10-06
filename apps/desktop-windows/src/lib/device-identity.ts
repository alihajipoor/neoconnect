/** What this device calls itself to the customer's *other* devices.
 *
 * Device slots name where Neoxify is in use -- "Neoxify is in use on
 * Windows PC since 14:02" -- and the name comes from two headers the
 * apps send on sign-in, refresh and claim (docs/device-slots.md,
 * "Headers the app sends"):
 *
 *   X-Neoxify-Device-Platform: windows | macos | linux | android | ios
 *   X-Neoxify-Device-Label:    a generic name, percent-encoded if not ASCII
 *
 * The label is generic on purpose and never a hostname, a computer name
 * or an account name. It is shown on other devices, and a machine name
 * is personal -- often the owner's own name. The backend drops anything
 * hostname-shaped as a backstop; not sending one is this file's job.
 *
 * Shared: the Android and iOS client compile this directory through
 * their `@shared` alias, and so does the web portal. The portal is not a
 * device that uses the VPN, so it sends nothing at all -- see
 * `detectDevicePlatform`.
 */

export type DevicePlatform = "windows" | "macos" | "linux" | "android" | "ios";

export const DEVICE_PLATFORM_HEADER = "X-Neoxify-Device-Platform";
export const DEVICE_LABEL_HEADER = "X-Neoxify-Device-Label";

/** The backend keeps this many characters of a label. Cut here as well,
 * so what is sent is what is shown. */
export const MAX_DEVICE_LABEL_LENGTH = 48;

/** The names the backend itself uses for a platform sent without a
 * label, so a device reads the same whichever side named it. iPad is the
 * one addition: "iPhone" would be wrong on one, and it is no more
 * personal than the platform. */
const GENERIC_LABELS: Record<DevicePlatform, string> = {
  windows: "Windows PC",
  macos: "Mac",
  linux: "Linux PC",
  android: "Android phone",
  ios: "iPhone",
};

export function genericDeviceLabel(platform: DevicePlatform): string {
  return GENERIC_LABELS[platform];
}

export interface DeviceEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  /** Whether this is one of the apps (a Tauri runtime) rather than the
   * web portal, which reuses these files in an ordinary browser tab. */
  nativeRuntime: boolean;
}

function currentEnvironment(): DeviceEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    userAgent: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    nativeRuntime: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  };
}

/** Which platform this is, or null when this is not a device that uses
 * the VPN.
 *
 * The same user-agent tests `attempts.ts` and `social-auth.ts` use, for
 * the same reason: every client runs in a system webview, and a wrong
 * guess costs a less accurate name rather than a broken connection.
 *
 * Null outside a native runtime. The web portal signs in through these
 * same files, and naming a browser tab "Windows PC" would put a device
 * on the customer's list that never used the VPN.
 */
export function detectDevicePlatform(env: DeviceEnvironment = currentEnvironment()): DevicePlatform | null {
  if (!env.nativeRuntime) return null;
  const ua = env.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPadOS reports itself as a Mac; only a touchscreen gives it away.
  if (/macintosh|mac os x/i.test(ua)) return env.maxTouchPoints > 1 ? "ios" : "macos";
  if (/windows/i.test(ua)) return "windows";
  if (/linux|x11/i.test(ua)) return "linux";
  return null;
}

/** The generic label for the platform this is. */
export function detectDeviceLabel(
  platform: DevicePlatform,
  env: DeviceEnvironment = currentEnvironment(),
): string {
  if (platform === "ios") {
    const ipad = /ipad/i.test(env.userAgent) || (/macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1);
    return ipad ? "iPad" : "iPhone";
  }
  return genericDeviceLabel(platform);
}

/** A label fit to send, or null if this one must not be.
 *
 * Control characters out, whitespace collapsed, cut to the backend's
 * length. Refuses anything that looks like a hostname or one of
 * Windows' generated machine names -- the same test the backend applies,
 * applied first, because what is never sent cannot be shown.
 */
export function cleanDeviceLabel(raw: string): string | null {
  const text = [...raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()]
    .slice(0, MAX_DEVICE_LABEL_LENGTH)
    .join("")
    .trim();
  if (text === "") return null;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(text)) return null;
  if (/^(desktop|laptop|win)-[a-z0-9]{5,}$/i.test(text)) return null;
  return text;
}

/** The label as a header value.
 *
 * HTTP header values are Latin-1, so anything outside printable ASCII is
 * percent-encoded, which the backend decodes. A literal `%` is encoded
 * too: the backend decodes any label that contains a `%xx`, so an ASCII
 * label carrying one would otherwise arrive changed.
 */
export function encodeDeviceLabel(label: string): string {
  return /^[\x20-\x7e]*$/.test(label) && !label.includes("%") ? label : encodeURIComponent(label);
}

/** Set by an app that knows better than the user agent -- a phone that
 * can name its model ("Android phone (Pixel 7)"), or a customer's own
 * wording if an app ever lets them choose it. Unset means detected. */
let override: { platform?: DevicePlatform; label?: string } = {};

export function configureDeviceIdentity(next: { platform?: DevicePlatform; label?: string }): void {
  override = { ...next };
}

/** The two headers, or none.
 *
 * None when the platform is unknown -- the web portal, or a webview this
 * does not recognise. Sending neither leaves the device's name as it
 * was, which is the right answer when there is nothing true to say.
 */
export function deviceHeaders(env?: DeviceEnvironment): Record<string, string> {
  const platform = override.platform ?? detectDevicePlatform(env);
  if (!platform) return {};
  const label =
    (override.label !== undefined ? cleanDeviceLabel(override.label) : null) ?? detectDeviceLabel(platform, env);
  return {
    [DEVICE_PLATFORM_HEADER]: platform,
    [DEVICE_LABEL_HEADER]: encodeDeviceLabel(label),
  };
}
