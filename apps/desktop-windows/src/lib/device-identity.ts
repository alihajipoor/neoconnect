/** What this device calls itself to the customer's *other* devices.
 *
 * Device slots name where Neoxify is in use -- "Neoxify is in use on a
 * Windows PC since 14:02" -- from two headers the apps send on sign-in,
 * refresh and claim (docs/device-slots.md, "Headers the app sends"):
 *
 *   X-Neoxify-Device-Platform: windows | macos | linux | android | ios
 *   X-Neoxify-Device-Label:    only what the platform does not say -- a
 *                              model -- percent-encoded if not ASCII
 *
 * The platform is always sent. The label is sent only when there is a
 * model to send, and is never the device's kind: "Windows PC" is English,
 * and the device that shows it may be in Persian, so the kind is named
 * by the reader, from the platform, in its own language. Nor is it ever a
 * hostname, a computer name or an account name. It is shown on other
 * devices, and a machine name is personal -- often the owner's own name.
 * The backend drops both as a backstop; not sending them is this file's
 * job.
 *
 * Shared: the Android and iOS client compile this directory through
 * their `@shared` alias, and so does the web portal. The portal is not a
 * device that uses the VPN, so it sends nothing at all -- see
 * `detectDevicePlatform`.
 */

export type DevicePlatform = "windows" | "macos" | "linux" | "android" | "ios";

const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["windows", "macos", "linux", "android", "ios"];

/** A platform as the server sent it (`holders[].platform`, `by.platform`),
 * or null for one this app does not know. Case-insensitive, as the
 * header is. */
export function parseDevicePlatform(value: string | null | undefined): DevicePlatform | null {
  const platform = value?.trim().toLowerCase() ?? "";
  return DEVICE_PLATFORMS.find((p) => p === platform) ?? null;
}

/** English names of device kinds -- what the apps were first built to
 * send as a label, and what the backend now drops (device-info.ts keeps
 * the same list). A kind is never a label: it says only what `platform`
 * says, in one language, and the device that reads it may be in another. */
const DEVICE_KINDS = new Set(
  ["Windows PC", "PC", "Mac", "Linux PC", "Android phone", "Android", "iPhone", "Phone", "Computer"].map((k) =>
    k.toLowerCase(),
  ),
);

/** The part of a label worth showing as it is: a model or the user's own
 * words. Null for a kind ("Windows PC"); the model out of "Android phone
 * (Pixel 7)". The backend's own reading, applied here too so a label from
 * before it existed reads the same, and so this app never sends a kind. */
export function specificDeviceLabel(label: string | null | undefined): string | null {
  const text = label?.trim();
  if (!text) return null;
  if (DEVICE_KINDS.has(text.toLowerCase())) return null;
  const qualified = /^(.+?)\s*\((.+)\)$/.exec(text);
  if (qualified && DEVICE_KINDS.has(qualified[1].trim().toLowerCase())) return specificDeviceLabel(qualified[2]);
  return text;
}

export const DEVICE_PLATFORM_HEADER = "X-Neoxify-Device-Platform";
export const DEVICE_LABEL_HEADER = "X-Neoxify-Device-Label";

/** The backend keeps this many characters of a label. Cut here as well,
 * so what is sent is what is shown. */
export const MAX_DEVICE_LABEL_LENGTH = 48;

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

/** The model, when this device genuinely says which, or null.
 *
 * An iPad is told from an iPhone, and is named "iPad" -- the contract's
 * own example of a model. An Android WebView carries the model in its
 * user agent (`Linux; Android 14; Pixel 7 Build/...`), which is the
 * manufacturer's name for the hardware, the same on every one of them --
 * nothing the owner chose. Nothing for a PC, a Mac or an iPhone: none
 * says which, and a kind is not a model. Nothing either for an Android
 * user agent reduced to `K`, or one this cannot read with confidence.
 */
export function detectDeviceModel(
  platform: DevicePlatform,
  env: DeviceEnvironment = currentEnvironment(),
): string | null {
  if (platform === "ios") {
    const ipad = /ipad/i.test(env.userAgent) || (/macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1);
    return ipad ? "iPad" : null;
  }
  if (platform === "android") return androidModel(env.userAgent);
  return null;
}

/** The model out of an Android user agent's first parenthesis: the part
 * after `Android <version>`, past the WebView's `wv` and an old-style
 * locale, without its `Build/...`. */
function androidModel(userAgent: string): string | null {
  const inside = /\(([^)]*)\)/.exec(userAgent)?.[1];
  if (!inside) return null;
  const parts = inside.split(";").map((part) => part.trim());
  const android = parts.findIndex((part) => /^Android\b/i.test(part));
  if (android < 0) return null;
  for (const part of parts.slice(android + 1)) {
    if (part.toLowerCase() === "wv" || /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(part)) continue;
    const model = part.replace(/\s*Build\/.*$/i, "").trim();
    // `K` is what a reduced user agent says in place of the model. A
    // parenthesis means the first one closed inside the model's name
    // ("moto g(7)"), and what is left of it is not the model.
    if (model.length < 2 || /[()]/.test(model) || !/[a-z0-9]/i.test(model)) return null;
    const clean = cleanDeviceLabel(model);
    return clean === null ? null : specificDeviceLabel(clean);
  }
  return null;
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
 * can name its model ("Galaxy S24"), or a customer's own wording if an
 * app ever lets them choose it. Unset means detected. */
let override: { platform?: DevicePlatform; label?: string } = {};

export function configureDeviceIdentity(next: { platform?: DevicePlatform; label?: string }): void {
  override = { ...next };
}

/** The headers: the platform always, and a label only with a model (or
 * the customer's own words) to put in it.
 *
 * None at all when the platform is unknown -- the web portal, or a
 * webview this does not recognise. Sending neither leaves the device's
 * name as it was, which is the right answer when there is nothing true
 * to say. A platform with no label clears an older label the server
 * held, which is right too: there is nothing more specific to say.
 */
export function deviceHeaders(env?: DeviceEnvironment): Record<string, string> {
  const platform = override.platform ?? detectDevicePlatform(env);
  if (!platform) return {};
  const supplied = override.label !== undefined ? cleanDeviceLabel(override.label) : null;
  const label = specificDeviceLabel(supplied) ?? detectDeviceModel(platform, env);
  return {
    [DEVICE_PLATFORM_HEADER]: platform,
    ...(label !== null ? { [DEVICE_LABEL_HEADER]: encodeDeviceLabel(label) } : {}),
  };
}
