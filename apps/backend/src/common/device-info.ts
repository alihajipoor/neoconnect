/** What a signed-in device calls itself, read from the two headers the
 * apps send (docs/device-slots.md, "Headers"):
 *
 *   X-Neoxify-Device-Platform: windows | macos | linux | android | ios
 *   X-Neoxify-Device-Label:    what the platform does not say -- a model
 *                              ("Pixel 7") or the user's own name for the
 *                              device -- ASCII, or UTF-8 percent-encoded
 *
 * Shown to the customer's OTHER devices ("Neoxify is in use on Windows
 * PC since 14:02"), so it is treated as untrusted display text: control
 * characters stripped, whitespace collapsed, length capped. It must
 * never be a hostname -- a machine name is personal, and frequently the
 * owner's own name -- so anything that looks like one is dropped. That
 * check is a backstop; not sending one is the client's obligation.
 *
 * The device's KIND is never a label. "Windows PC" or "Android phone" is
 * English, and the device reading it may be in Persian: the reader names
 * the kind from `platform` in its own language. So a generic platform
 * name is dropped (label null), "Android phone (Pixel 7)" -- what the
 * apps were first built to send -- is kept as "Pixel 7", and a device
 * that sends a platform alone has no label at all. */
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

/** English names of device kinds, as the apps sent them for a device with
 * nothing more specific to say. Never stored or shown as a label: they
 * say only what `platform` says, in one language. */
const GENERIC_LABELS = new Set(
  ["Windows PC", "PC", "Mac", "Linux PC", "Android phone", "Android", "iPhone", "Phone", "Computer"].map((l) =>
    l.toLowerCase(),
  ),
);

type HeaderBag = Record<string, string | string[] | undefined>;

export function deviceInfoFrom(headers: HeaderBag | undefined): DeviceInfo {
  const platform = parsePlatform(first(headers?.[DEVICE_PLATFORM_HEADER]));
  const label = specificLabel(parseLabel(first(headers?.[DEVICE_LABEL_HEADER])));
  return { label, platform };
}

/** The part of a label worth showing as sent: a model or the user's own
 * words. Null for a generic kind ("Windows PC"); the model out of "Android
 * phone (Pixel 7)". Applied to what is read back too, so a label stored
 * before this existed is shown the same way. */
export function specificLabel(label: string | null | undefined): string | null {
  const text = label?.trim();
  if (!text) return null;
  if (GENERIC_LABELS.has(text.toLowerCase())) return null;
  const qualified = /^(.+?)\s*\((.+)\)$/.exec(text);
  if (qualified && GENERIC_LABELS.has(qualified[1].trim().toLowerCase())) {
    return specificLabel(qualified[2]);
  }
  return text;
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
