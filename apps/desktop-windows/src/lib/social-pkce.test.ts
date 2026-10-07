import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The client half of the PKCE binding on the social sign-in handoff.
 *
 * The handoff code crosses `neoconnect://social-callback`, which on
 * Android any app can claim. The server now binds the code to the
 * challenge the app started with (OauthFlowService.consumeHandoff); what
 * is pinned here is that the app makes a real S256 pair, sends the
 * challenge out with the start URL, and sends the matching verifier --
 * and nothing else -- with the exchange. Run against no provider and no
 * server; the native session is stood in for. */

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

const { pkcePair, startSocialSignIn, startUrl } = await import("./social-auth");

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

beforeEach(() => {
  invoke.mockReset();
  // Android, the platform where the scheme can be claimed by another app.
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14)", maxTouchPoints: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pkcePair", () => {
  it("makes an RFC 7636 S256 pair", async () => {
    const pair = await pkcePair();
    expect(pair).not.toBeNull();
    expect(pair!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair!.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair!.challenge).toBe(s256(pair!.verifier));
  });

  it("makes a fresh secret every time", async () => {
    const [a, b] = await Promise.all([pkcePair(), pkcePair()]);
    expect(a!.verifier).not.toBe(b!.verifier);
  });
});

describe("startUrl", () => {
  it("carries the challenge when there is one, and is unchanged when there is not", () => {
    expect(startUrl("google", "fa", "abc_DEF-123")).toMatch(/\/customer-auth\/social\/google\/start\?locale=fa&challenge=abc_DEF-123$/);
    expect(startUrl("google", "fa")).toMatch(/\/start\?locale=fa$/);
  });
});

describe("startSocialSignIn", () => {
  it("returns the verifier whose challenge went out with the start URL", async () => {
    let opened = "";
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "vpn_open_auth_session") throw new Error(`unexpected ${cmd}`);
      opened = String(args?.url);
      return "neoconnect://social-callback?handoff=the-code";
    });

    const outcome = await startSocialSignIn("google", "en");
    const challenge = new URL(opened).searchParams.get("challenge");
    expect(outcome).toMatchObject({ kind: "handoff", code: "the-code" });
    expect(outcome?.kind === "handoff" ? outcome.verifier : undefined).toBeDefined();
    expect(challenge).toBe(s256((outcome as { verifier: string }).verifier));
  });

  it("puts no secret in the URL it opens", async () => {
    let opened = "";
    invoke.mockImplementation(async (_cmd, args) => {
      opened = String(args?.url);
      return "neoconnect://social-callback?handoff=the-code";
    });
    const outcome = (await startSocialSignIn("facebook", "en")) as { verifier: string };
    expect(opened).not.toContain(outcome.verifier);
  });
});

describe("the exchange", () => {
  it("posts the verifier with the code", async () => {
    vi.resetModules();
    const bodies: unknown[] = [];
    vi.doMock("./api", () => ({
      publicRequest: async (_path: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return { ok: false, error: "stood in for" };
      },
      apiRequest: vi.fn(),
    }));
    vi.doMock("./attempts", async (original) => ({
      ...(await original<typeof import("./attempts")>()),
      reportAttempt: vi.fn(),
    }));
    vi.doMock("./social-auth", () => ({
      startSocialSignIn: async () => ({ kind: "handoff", code: "the-code", verifier: "v".repeat(43) }),
    }));
    vi.doMock("./session", () => ({ setTokens: vi.fn() }));
    vi.doMock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
    vi.doMock("./i18n", () => ({ currentLanguage: () => "en" }));
    vi.doMock("./control-plane-probe", () => ({ probeAddendum: async () => undefined }));

    const { socialSignIn } = await import("./auth");
    await socialSignIn("google");
    expect(bodies).toEqual([{ code: "the-code", verifier: "v".repeat(43) }]);
  });
});
