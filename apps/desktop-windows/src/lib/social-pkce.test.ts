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
  const VERIFIER = "v".repeat(43);
  const TOKENS = { accessToken: "a", refreshToken: "r" };
  /** What a backend from before the binding answers an exchange carrying
   * `verifier`: the global ValidationPipe's forbidNonWhitelisted refusal,
   * as `failureFrom` in api.ts reads it. */
  const OLD_BACKEND = { ok: false, error: "property verifier should not exist", status: 400 };
  const EXPIRED = { ok: false, error: "This sign-in has expired -- please try again", status: 400 };

  /** socialSignIn with the exchange answering `replies` in turn, and
   * what it was sent. */
  async function signInAgainst(replies: unknown[], verifier: string | null = VERIFIER) {
    vi.resetModules();
    const bodies: unknown[] = [];
    const setTokens = vi.fn();
    vi.doMock("./api", () => ({
      publicRequest: async (_path: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return replies.shift() ?? { ok: false, error: "stood in for" };
      },
      apiRequest: vi.fn(),
    }));
    vi.doMock("./attempts", async (original) => ({
      ...(await original<typeof import("./attempts")>()),
      reportAttempt: vi.fn(),
    }));
    vi.doMock("./social-auth", () => ({
      startSocialSignIn: async () => ({ kind: "handoff", code: "the-code", verifier: verifier ?? undefined }),
    }));
    vi.doMock("./session", () => ({ setTokens }));
    vi.doMock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
    vi.doMock("./i18n", () => ({ currentLanguage: () => "en" }));
    vi.doMock("./control-plane-probe", () => ({ probeAddendum: async () => undefined }));

    const { socialSignIn } = await import("./auth");
    const result = await socialSignIn("google");
    return { result, bodies, setTokens };
  }

  it("posts the verifier with the code", async () => {
    const { bodies } = await signInAgainst([]);
    expect(bodies).toEqual([{ code: "the-code", verifier: VERIFIER }]);
  });

  it("asks once more without it when the backend predates the binding", async () => {
    // A client released before the backend deploy: without this, Google
    // and Facebook sign-in ended in a 400 until the backend went out.
    const { result, bodies, setTokens } = await signInAgainst([OLD_BACKEND, { ok: true, data: TOKENS }]);
    expect(bodies).toEqual([{ code: "the-code", verifier: VERIFIER }, { code: "the-code" }]);
    expect(result).toEqual({ ok: true, data: TOKENS });
    expect(setTokens).toHaveBeenCalledWith(TOKENS);
  });

  it("takes any other refusal as final", async () => {
    // What the new backend says to a wrong verifier, an unbound code
    // presented with one, or a code already spent. Asked again without
    // the verifier, an unbound injected code would be handed over.
    for (const refusal of [EXPIRED, { ...OLD_BACKEND, status: 422 }, { ok: false, error: "Could not reach Neoxify." }]) {
      const { result, bodies } = await signInAgainst([refusal, { ok: true, data: TOKENS }]);
      expect(bodies).toEqual([{ code: "the-code", verifier: VERIFIER }]);
      expect(result).toEqual(refusal);
    }
  });

  it("sends a bare code once when this runtime made no verifier", async () => {
    const { bodies } = await signInAgainst([OLD_BACKEND], null);
    expect(bodies).toEqual([{ code: "the-code" }]);
  });
});
