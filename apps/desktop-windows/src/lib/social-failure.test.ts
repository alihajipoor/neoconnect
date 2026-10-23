import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** What the sign-in screen shows when a provider sign-in fails
 * (components/SocialSignIn.tsx): the sentence the flow wrote for the
 * customer, never one generic line over it.
 *
 * Every refusal the provider trip can meet is turned into a sentence in
 * social-auth.ts -- no Apple Account on the iPhone (`nativeError`), a
 * provider with no credentials (`unavailable`), or the backend's own
 * `detail`: a disabled account, an unverified password account holding the
 * address, a provider account with no email. `socialSignIn()` hands that
 * sentence back as a failed result, and the screen shows
 * `socialFailureText(result)`. These run the real social-auth.ts, auth.ts and
 * the screen's wording; only the native calls and the network are stood in for.
 * (The screen's own `catch` is for what throws after that -- a store that
 * would not save the session -- whose text is the platform's, not ours.) */

const native = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => native(cmd, args) }));

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  publicRequest: vi.fn(),
  // The browser's start address: none answered, so the compiled-in one.
  answeringEndpoint: async () => null,
}));
vi.mock("./api-endpoints", () => ({ apiEndpoints: async () => ["https://api.example.net/api"] }));
vi.mock("./attempts", async (original) => ({
  ...(await original<typeof import("./attempts")>()),
  reportAttempt: vi.fn(),
}));
vi.mock("./control-plane-probe", () => ({ probeAddendum: vi.fn() }));
vi.mock("./session", () => ({ setTokens: vi.fn(), getTokens: async () => null }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));

const { socialSignIn } = await import("./auth");
const { socialFailureText } = await import("../components/SocialSignIn");
const { DICTIONARIES } = await import("./i18n");

const en = DICTIONARIES.en;
const t = (key: keyof typeof en) => en[key];

/** What the screen puts in its alert for this result (SocialSignIn.tsx). */
function shown(result: ApiResult<unknown> | null): string | null {
  if (result === null || result.ok) return null;
  return socialFailureText(result, t);
}

beforeEach(() => {
  native.mockReset();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a provider sign-in that fails says why", () => {
  it("tells an iPhone with no Apple Account to sign in to one", async () => {
    native.mockImplementation(async (cmd) => {
      if (cmd === "vpn_sign_in_with_apple") throw new Error("apple-no-account");
      throw new Error(`unexpected ${cmd}`);
    });
    expect(shown(await socialSignIn("apple"))).toBe(en["auth.appleNoAccount"]);
  });

  it("says a provider with no credentials is not available, not that it failed", async () => {
    native.mockImplementation(async (cmd) => {
      if (cmd === "vpn_open_auth_session") return "neoconnect://social-callback?error=unavailable";
      throw new Error(`unexpected ${cmd}`);
    });
    expect(shown(await socialSignIn("google"))).toBe(en["auth.socialUnavailable"]);
  });

  it("shows the backend's own reason, which nothing on the device could know", async () => {
    const detail = "An account with this email already exists. Sign in with your password.";
    native.mockImplementation(async (cmd) => {
      if (cmd === "vpn_open_auth_session") return `neoconnect://social-callback?error=rejected&detail=${encodeURIComponent(detail)}`;
      throw new Error(`unexpected ${cmd}`);
    });
    expect(shown(await socialSignIn("facebook"))).toBe(detail);
  });

  it("falls back to the generic line only when nothing more is known", async () => {
    native.mockImplementation(async (cmd) => {
      if (cmd === "vpn_sign_in_with_apple") throw new Error("something-new");
      throw new Error(`unexpected ${cmd}`);
    });
    expect(shown(await socialSignIn("apple"))).toBe(en["auth.socialFailed"]);
  });

  it("shows nothing for a sheet the customer closed", async () => {
    native.mockImplementation(async (cmd) => {
      if (cmd === "vpn_open_auth_session") return null;
      throw new Error(`unexpected ${cmd}`);
    });
    expect(shown(await socialSignIn("google"))).toBeNull();
  });
});
