/** What a signed-in device calls itself, read from the two headers the
 * apps send (docs/device-slots.md, "Headers"):
 *
 *   X-Neoxify-Device-Platform: windows | macos | linux | android | ios
 *   X-Neoxify-Device-Label:    a generic name -- "Windows PC",
 *                              "Android phone (Pixel 7)" -- ASCII, or
 *                              UTF-8 percent-encoded
 *
 * Shown to the customer's OTHER devices ("Neoxify is in use on Windows
 * PC since 14:02"), so it is treated as untrusted display text: control
 * characters stripped, whitespace collapsed, length capped. It must
 * never be a hostname -- a machine name is personal, and frequently the
 * owner's own name -- so anything that looks like one is dropped in
 * favour of the platform's generic label. That check is a backstop; not
 * sending one is the client's obligation. */
export interface DeviceInfo {
  label: string | null;
  platform: DevicePlatform | null;
}

export const DEVICE_PLATFORMS = ["windows", "macos", "linux", "android", "ios"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_LABEL_HEADER = "x-neoxify-device-label";
export const DEVICE_PLATFORM_HEADER = "x-neoxify-device-platform";

/** Longest label kept, in characters. Enough for "Android phone (Galaxy
 * S24 Ultra)"; a card in another device's UI has to hold it. */
export const MAX_LABEL_LENGTH = 48;

/** The name used when a device sends a platform and no label. */
const GENERIC_LABELS: Record<DevicePlatform, string> = {
  windows: "Windows PC",
  macos: "Mac",
  linux: "Linux PC",
  android: "Android phone",
  ios: "iPhone",
};

type HeaderBag = Record<string, string | string[] | undefined>;

export function deviceInfoFrom(headers: HeaderBag | undefined): DeviceInfo {
  const platform = parsePlatform(first(headers?.[DEVICE_PLATFORM_HEADER]));
  const label = parseLabel(first(headers?.[DEVICE_LABEL_HEADER]));
  return { label: label ?? (platform ? GENERIC_LABELS[platform] : null), platform };
}

/** True when the request said anything about the device -- so a request
 * without the headers never blanks out what an earlier one recorded. */
export function hasDeviceInfo(info: DeviceInfo): boolean {
  return info.label !== null || info.platform !== null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePlatform(raw: string | undefined): DevicePlatform | null {
  const value = raw?.trim().toLowerCase();
  return (DEVICE_PLATFORMS as readonly string[]).includes(value ?? "") ? (value as DevicePlatform) : null;
}

function parseLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  let text = raw;
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // Not valid percent-encoding: taken as it came.
    }
  }
  // Control and format characters (including bidi overrides, which could
  // make one label render as another) out; whitespace runs to one space.
  text = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = [...text].slice(0, MAX_LABEL_LENGTH).join("").trim();
  if (text === "" || looksLikeHostname(text)) return null;
  return text;
}

/** A dotted name with no spaces ("ali-laptop.local", "host.example.com"),
 * or Windows' generated machine names ("DESKTOP-7H3K2L9", "LAPTOP-AB12CD3"). */
function looksLikeHostname(text: string): boolean {
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(text)) return true;
  if (/^(desktop|laptop|win)-[a-z0-9]{5,}$/i.test(text)) return true;
  return false;
}
