import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import { APP_CALLBACK_URL, OauthFlowService } from "./oauth-flow.service";

/** The browser sign-in flow.
 *
 * Everything here is about the three short-lived secrets the flow
 * hands around -- the state, the authorization code and the handoff --
 * and the ways each of them is worth stealing if it outlives its one
 * use. The happy path is the easy part; these are the cases that turn
 * a convenience feature into an account takeover if they regress.
 */

const CONFIG: Record<string, string> = {
  publicApiUrl: "https://api.example.test/api",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  FACEBOOK_APP_ID: "fb-app-id",
  FACEBOOK_APP_SECRET: "fb-app-secret",
};

function service(overrides: Partial<Record<string, string>> = {}) {
  const values = { ...CONFIG, ...overrides };
  return new OauthFlowService({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe("OauthFlowService", () => {
  describe("start", () => {
    it("sends the browser to the provider with our own redirect_uri", () => {
      const url = new URL(service().start("google", "en"));
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe("google-client-id");
      expect(url.searchParams.get("response_type")).toBe("code");
      // The redirect must be ours and must be built from PUBLIC_API_URL,
      // because the provider compares it byte for byte with the one
      // registered in its console -- and because deriving it from the
      // request would let a spoofed Host header steer the code.
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://api.example.test/api/customer-auth/social/google/callback",
      );
    });

    it("asks Google which account to use rather than reusing the last one", () => {
      // Without prompt=select_account, the second person to sign in on a
      // shared device silently lands in the first person's account.
      const url = new URL(service().start("google", "en"));
      expect(url.searchParams.get("prompt")).toBe("select_account");
    });

    it("asks Facebook for the email scope", () => {
      const url = new URL(service().start("facebook", "en"));
      expect(url.origin + url.pathname).toBe("https://www.facebook.com/v21.0/dialog/oauth");
      expect(url.searchParams.get("scope")).toBe("email");
    });

    it("gives every attempt a different state", () => {
      const svc = service();
      const first = new URL(svc.start("google", "en")).searchParams.get("state");
      const second = new URL(svc.start("google", "en")).searchParams.get("state");
      expect(first).not.toBe(second);
      expect(first).toHaveLength(43); // 32 bytes, base64url
    });

    it("refuses to start when the provider is not configured", () => {
      // A missing client id must not read as a rejected customer.
      expect(() => service({ GOOGLE_OAUTH_CLIENT_ID: undefined }).start("google", "en")).toThrow(
        BadRequestException,
      );
    });
  });

  describe("consumeState", () => {
    it("returns the provider and locale the flow started with", () => {
      const svc = service();
      const state = new URL(svc.start("facebook", "fa")).searchParams.get("state")!;
      expect(svc.consumeState(state)).toMatchObject({ provider: "facebook", locale: "fa" });
    });

    it("burns the state so a replayed callback cannot mint a second session", () => {
      const svc = service();
      const state = new URL(svc.start("google", "en")).searchParams.get("state")!;
      svc.consumeState(state);
      expect(() => svc.consumeState(state)).toThrow(BadRequestException);
    });

    it("rejects a state it never issued", () => {
      expect(() => service().consumeState("not-a-state")).toThrow(BadRequestException);
    });

    it("expires a state that was never used", () => {
      jest.useFakeTimers();
      try {
        const svc = service();
        const state = new URL(svc.start("google", "en")).searchParams.get("state")!;
        jest.advanceTimersByTime(10 * 60 * 1000 + 1);
        expect(() => svc.consumeState(state)).toThrow(BadRequestException);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("handoff", () => {
    const tokens = { accessToken: "access", refreshToken: "refresh" };

    it("returns the session to whoever presents the code", () => {
      const svc = service();
      expect(svc.consumeHandoff(svc.storeHandoff(tokens))).toEqual(tokens);
    });

    it("is single use", () => {
      // The code crosses a custom-scheme URL and browser history. One
      // use means a copy scraped from either is already spent.
      const svc = service();
      const code = svc.storeHandoff(tokens);
      svc.consumeHandoff(code);
      expect(() => svc.consumeHandoff(code)).toThrow(BadRequestException);
    });

    it("expires after two minutes", () => {
      jest.useFakeTimers();
      try {
        const svc = service();
        const code = svc.storeHandoff(tokens);
        jest.advanceTimersByTime(2 * 60 * 1000 + 1);
        expect(() => svc.consumeHandoff(code)).toThrow(BadRequestException);
      } finally {
        jest.useRealTimers();
      }
    });

    it("gives every session a different code", () => {
      const svc = service();
      expect(svc.storeHandoff(tokens)).not.toBe(svc.storeHandoff(tokens));
    });
  });

  /** The handoff bound to the app that started the flow (RFC 7636).
   *
   * On Android any app can claim `neoconnect://social-callback`, so the
   * redirect -- and the handoff code in it -- can land in a malicious
   * app, which then reaches this API as easily as ours does. Before the
   * binding the code alone was the session: these are the account
   * takeover and the account injection that made it a finding. */
  describe("handoff bound to a PKCE challenge", () => {
    const tokens = { accessToken: "access", refreshToken: "refresh" };
    // RFC 7636, Appendix B.
    const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    it("carries the challenge from start through the state", () => {
      const svc = service();
      const state = new URL(svc.start("google", "en", CHALLENGE)).searchParams.get("state")!;
      expect(svc.consumeState(state).challenge).toBe(CHALLENGE);
    });

    it("refuses a malformed challenge at start", () => {
      expect(() => service().start("google", "en", "not-a-challenge")).toThrow(BadRequestException);
      expect(() => service().start("google", "en", `${CHALLENGE}=`)).toThrow(BadRequestException);
    });

    it("hands the session to the app holding the verifier", () => {
      const svc = service();
      expect(svc.consumeHandoff(svc.storeHandoff(tokens, CHALLENGE), VERIFIER)).toEqual(tokens);
    });

    it("refuses an intercepted code presented without the verifier", () => {
      const svc = service();
      const code = svc.storeHandoff(tokens, CHALLENGE);
      expect(() => svc.consumeHandoff(code)).toThrow(BadRequestException);
    });

    it("refuses the wrong verifier, and burns the code doing it", () => {
      const svc = service();
      const code = svc.storeHandoff(tokens, CHALLENGE);
      const wrong = "x".repeat(43);
      expect(() => svc.consumeHandoff(code, wrong)).toThrow(BadRequestException);
      // No second guess for anyone.
      expect(() => svc.consumeHandoff(code, VERIFIER)).toThrow(BadRequestException);
    });

    it("refuses an unbound code presented with a verifier: a flow this app did not start", () => {
      // The injection: an attacker's own sign-in, started without a
      // challenge, delivered to the victim's app, which sends its
      // verifier for a flow it believes is its own.
      const svc = service();
      const code = svc.storeHandoff(tokens);
      expect(() => svc.consumeHandoff(code, VERIFIER)).toThrow(BadRequestException);
    });

    it("still accepts an unbound code with no verifier, for clients released before the binding", () => {
      const svc = service();
      expect(svc.consumeHandoff(svc.storeHandoff(tokens))).toEqual(tokens);
    });

    it("says the same thing for every refusal", () => {
      const svc = service();
      const messages = [
        () => svc.consumeHandoff("never-issued", VERIFIER),
        () => svc.consumeHandoff(svc.storeHandoff(tokens, CHALLENGE)),
        () => svc.consumeHandoff(svc.storeHandoff(tokens, CHALLENGE), "y".repeat(43)),
        () => svc.consumeHandoff(svc.storeHandoff(tokens), VERIFIER),
      ].map((attempt) => {
        try {
          attempt();
          return "accepted";
        } catch (err) {
          return (err as BadRequestException).message;
        }
      });
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).not.toBe("accepted");
    });
  });

  describe("appCallback", () => {
    it("sends the app to the one scheme every client registers", () => {
      expect(service().appCallback({ handoff: "abc" })).toBe(`${APP_CALLBACK_URL}?handoff=abc`);
    });

    it("never carries a token", () => {
      // The whole point of the handoff indirection. If this ever starts
      // putting the session in the URL, the indirection is pointless and
      // a refresh token is in browser history.
      const url = service().appCallback({ handoff: "abc" });
      expect(url).not.toContain("accessToken");
      expect(url).not.toContain("refreshToken");
    });

    it("escapes what it puts in the query", () => {
      const url = service().appCallback({ error: "rejected", detail: "already exists & more" });
      expect(new URL(url).searchParams.get("detail")).toBe("already exists & more");
    });
  });

  describe("exchangeCode", () => {
    afterEach(() => jest.restoreAllMocks());

    it("posts the code with the client secret and returns Google's id_token", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: "the-id-token", access_token: "ignored" }),
      } as Response);

      await expect(service().exchangeCode("google", "the-code")).resolves.toBe("the-id-token");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://oauth2.googleapis.com/token");
      // The body is the URLSearchParams exchangeCode built, so it is read
      // as one rather than stringified through String().
      const body = (init as RequestInit).body as URLSearchParams;
      expect(body.get("code")).toBe("the-code");
      expect(body.get("client_secret")).toBe("google-client-secret");
      expect(body.get("grant_type")).toBe("authorization_code");
    });

    it("returns Facebook's access_token, since Facebook signs nothing", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "the-access-token" }),
      } as Response);
      await expect(service().exchangeCode("facebook", "c")).resolves.toBe("the-access-token");
    });

    it("does not leak the provider's complaint to the customer", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("redirect_uri_mismatch"),
      } as Response);
      await expect(service().exchangeCode("google", "c")).rejects.toThrow(
        /could not complete that sign-in/,
      );
    });

    it("refuses a 200 that carries no token", async () => {
      // A provider that answers OK with an empty body must not become a
      // successful sign-in for an empty subject.
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
      await expect(service().exchangeCode("google", "c")).rejects.toThrow(BadRequestException);
    });
  });
});
