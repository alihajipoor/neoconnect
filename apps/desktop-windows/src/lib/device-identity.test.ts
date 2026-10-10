import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** What a device calls itself to the customer's other devices, and that
 * sign-in sends it (docs/device-slots.md, "Headers the app sends").
 *
 * The rules the label exists to keep: a model or nothing -- never the
 * device's kind, which the reader names in its own language, and never
 * a hostname or a computer's own name, which is shown on another device
 * and is often its owner's name. The platform is always sent. */

const publicRequest = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<unknown>>>();
vi.mock("./api", () => ({
  publicRequest: (path: string, init?: RequestInit) => publicRequest(path, init),
  apiRequest: vi.fn(),
  LEAD_MS: 1_500,
  SLOW_ANSWER_MS: 20_000,
}));
vi.mock("./api-endpoints", () => ({ attemptedEndpoints: async () => undefined }));
vi.mock("./attempts", async (original) => {
  const real = await original<typeof import("./attempts")>();
  return { ...real, reportAttempt: vi.fn() };
});
vi.mock("./pow", () => ({
  raceChallengeFor: async () => ({ reached: true, answered: [{ base: "https://api.example.net/api", ms: 100 }] }),
}));
vi.mock("./session", () => ({ setTokens: vi.fn() }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
vi.mock("./i18n", () => ({ currentLanguage: () => "en" }));
vi.mock("./social-auth", () => ({ startSocialSignIn: async () => ({ kind: "apple-token", token: "t" }) }));

const {
  cleanDeviceLabel,
  configureDeviceIdentity,
  detectDeviceModel,
  detectDevicePlatform,
  deviceHeaders,
  encodeDeviceLabel,
} = await import("./device-identity");
const { login, socialSignIn } = await import("./auth");

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

const app = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints, nativeRuntime: true });

afterEach(() => {
  configureDeviceIdentity({});
  publicRequest.mockReset();
});

describe("which device this is", () => {
  it("tells the platforms apart", () => {
    expect(detectDevicePlatform(app(WINDOWS_UA))).toBe("windows");
    expect(detectDevicePlatform(app(ANDROID_UA))).toBe("android");
    expect(detectDevicePlatform(app(IPHONE_UA))).toBe("ios");
    expect(detectDevicePlatform(app(MAC_UA))).toBe("macos");
    // iPadOS says Macintosh; the touchscreen gives it away.
    expect(detectDevicePlatform(app(MAC_UA, 5))).toBe("ios");
    expect(detectDeviceModel("ios", app(MAC_UA, 5))).toBe("iPad");
  });

  /** The web portal signs in through these same files. A browser tab is
   * not a device that uses the VPN, and must not appear as one. */
  it("is nobody in the web portal", () => {
    expect(detectDevicePlatform({ userAgent: WINDOWS_UA, maxTouchPoints: 0, nativeRuntime: false })).toBeNull();
    expect(deviceHeaders({ userAgent: WINDOWS_UA, maxTouchPoints: 0, nativeRuntime: false })).toEqual({});
  });

  /** "Windows PC" is English, and the device that shows it may be in
   * Persian: the kind is the reader's to name, from the platform. */
  it("sends the platform alone when there is no model, never the device's kind", () => {
    expect(deviceHeaders(app(WINDOWS_UA))).toEqual({ "X-Neoxify-Device-Platform": "windows" });
    expect(deviceHeaders(app(MAC_UA))).toEqual({ "X-Neoxify-Device-Platform": "macos" });
    expect(deviceHeaders(app(IPHONE_UA))).toEqual({ "X-Neoxify-Device-Platform": "ios" });
  });

  it("sends a model when the platform genuinely says which", () => {
    expect(deviceHeaders(app(ANDROID_UA))).toEqual({
      "X-Neoxify-Device-Platform": "android",
      "X-Neoxify-Device-Label": "Pixel 7",
    });
    expect(deviceHeaders(app(MAC_UA, 5))).toEqual({
      "X-Neoxify-Device-Platform": "ios",
      "X-Neoxify-Device-Label": "iPad",
    });
  });
});

describe("an Android model, out of the WebView's user agent", () => {
  const model = (ua: string) => detectDeviceModel("android", app(ua));

  it("reads the model, without its build", () => {
    expect(model(ANDROID_UA)).toBe("Pixel 7");
    expect(
      model("Mozilla/5.0 (Linux; Android 13; SM-S901B Build/TP1A.220624.014; wv) AppleWebKit/537.36 Chrome/116.0 Mobile Safari/537.36"),
    ).toBe("SM-S901B");
    // No build, no WebView marker.
    expect(model("Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36")).toBe("Redmi Note 11");
    // The old form, with a locale before the model.
    expect(model("Mozilla/5.0 (Linux; U; Android 4.0.3; ko-kr; LG-L160L Build/IML74K) AppleWebKit/534.30")).toBe(
      "LG-L160L",
    );
  });

  /** Nothing is better than something wrong: a missing label names the
   * device by its kind, in the reader's language. */
  it("sends nothing it cannot read with confidence", () => {
    // A reduced user agent says K in place of the model.
    expect(model("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36")).toBeNull();
    // A model with a parenthesis of its own closes the first one early.
    expect(model("Mozilla/5.0 (Linux; Android 10; moto g(7) power Build/QPOS30.52; wv) AppleWebKit/537.36")).toBeNull();
    expect(model("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36")).toBeNull();
    expect(model("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBeNull();
    expect(model("")).toBeNull();
    // A kind is not a model, whatever slot it arrives in.
    expect(model("Mozilla/5.0 (Linux; Android 14; Android Build/X; wv) AppleWebKit/537.36")).toBeNull();
    // Nor is anything shaped like a hostname.
    expect(model("Mozilla/5.0 (Linux; Android 14; ali-phone.local Build/X; wv) AppleWebKit/537.36")).toBeNull();
  });
});

describe("a label an app supplies", () => {
  it("is used when it is fit to show, as a phone model is", () => {
    configureDeviceIdentity({ label: "Galaxy S24" });
    expect(deviceHeaders(app(ANDROID_UA))["X-Neoxify-Device-Label"]).toBe("Galaxy S24");
  });

  it("is cut to its model when it comes qualified by a kind, and dropped when it is only a kind", () => {
    configureDeviceIdentity({ label: "Android phone (Pixel 7)" });
    expect(deviceHeaders(app(ANDROID_UA))["X-Neoxify-Device-Label"]).toBe("Pixel 7");
    configureDeviceIdentity({ label: "Windows PC" });
    expect(deviceHeaders(app(WINDOWS_UA))).toEqual({ "X-Neoxify-Device-Platform": "windows" });
  });

  it("is refused when it looks like a hostname or a machine name", () => {
    expect(cleanDeviceLabel("ali-laptop.local")).toBeNull();
    expect(cleanDeviceLabel("DESKTOP-7H3K2L9")).toBeNull();
    expect(cleanDeviceLabel("  ")).toBeNull();
    configureDeviceIdentity({ label: "DESKTOP-7H3K2L9" });
    expect(deviceHeaders(app(WINDOWS_UA))).toEqual({ "X-Neoxify-Device-Platform": "windows" });
  });

  it("is cleaned and cut to the server's length", () => {
    expect(cleanDeviceLabel("My\u0000  phone\n")).toBe("My phone");
    expect(cleanDeviceLabel("x".repeat(80))).toHaveLength(48);
  });

  it("is percent-encoded when it is not plain ASCII, which a header cannot carry", () => {
    expect(encodeDeviceLabel("Pixel 7")).toBe("Pixel 7");
    expect(encodeDeviceLabel("گوشی من")).toBe(encodeURIComponent("گوشی من"));
    // The server decodes any label holding a %xx, so a literal one is
    // encoded too rather than arriving changed.
    expect(encodeDeviceLabel("100%25 mine")).toBe("100%2525%20mine");
  });
});

describe("sign-in names the device", () => {
  it("sends the headers with the password sign-in", async () => {
    configureDeviceIdentity({ platform: "windows" });
    publicRequest.mockResolvedValue({ ok: false, error: "Wrong email or password.", status: 401 });
    await login("someone@example.com", "pw");
    expect(publicRequest.mock.calls[0][0]).toBe("/customer-auth/login");
    expect(publicRequest.mock.calls[0][1]?.headers).toEqual({ "X-Neoxify-Device-Platform": "windows" });
  });

  it("sends the headers with a provider's token", async () => {
    configureDeviceIdentity({ platform: "ios" });
    publicRequest.mockResolvedValue({ ok: false, error: "no", status: 400 });
    await socialSignIn("apple");
    expect(publicRequest.mock.calls[0][0]).toBe("/customer-auth/social");
    expect(publicRequest.mock.calls[0][1]?.headers).toMatchObject({ "X-Neoxify-Device-Platform": "ios" });
  });
});
