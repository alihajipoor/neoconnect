import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import { CustomerAuthController } from "./customer-auth.controller";
import type { CustomerAuthService } from "./customer-auth.service";
import type { SocialAuthService } from "./social/social-auth.service";
import { SOCIAL_REFUSALS } from "./social/social-auth.service";
import { OauthFlowService, WEB_CALLBACK_URL } from "./social/oauth-flow.service";
import type { RelayAuthService } from "../relay-auth/relay-auth.service";
import type { LoginGuardService } from "../login-guard/login-guard.service";

/** The browser sign-in's two routes, with the real OauthFlowService, for
 * both destinations: the web portal's new one and the apps' unchanged
 * one. The provider exchange and the account rules are stood in for --
 * they are the same code for both, tested on their own. */

const CONFIG: Record<string, string> = {
  publicApiUrl: "https://api.example.test/api",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  FACEBOOK_APP_ID: "fb-app-id",
  FACEBOOK_APP_SECRET: "fb-app-secret",
};
// RFC 7636, Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const TOKENS = { accessToken: "access", refreshToken: "refresh" };

function build(resolve: () => Promise<unknown> = () => Promise.resolve({ customer: { id: "c1" }, created: false })) {
  const flow = new OauthFlowService({ get: (key: string) => CONFIG[key] } as unknown as ConfigService);
  jest.spyOn(flow, "exchangeCode").mockResolvedValue("provider-token");
  const auth = {
    onSocialSignup: jest.fn().mockResolvedValue(undefined),
    issueTokenPair: jest.fn().mockResolvedValue(TOKENS),
  };
  const social = {
    verify: jest.fn().mockResolvedValue({ subject: "s", email: "a@example.com", emailVerified: true }),
    resolveCustomer: jest.fn().mockImplementation(resolve),
  };
  const controller = new CustomerAuthController(
    auth as unknown as CustomerAuthService,
    {} as unknown as LoginGuardService,
    social as unknown as SocialAuthService,
    flow,
    {} as unknown as RelayAuthService,
  );
  return { controller, flow, auth };
}

/** Runs /start and returns where the browser was sent. */
function start(controller: CustomerAuthController, client: string | undefined, challenge: string | null = CHALLENGE) {
  const res = { redirect: jest.fn() };
  controller.socialStart("google", "en", challenge ?? undefined, client, res as never);
  return res.redirect.mock.calls[0]?.[0] as string;
}

/** Runs the callback for a state and returns where the browser was sent. */
async function callback(controller: CustomerAuthController, state: string | undefined, error?: string) {
  const res = { redirect: jest.fn() };
  await controller.socialCallback("google", "auth-code", state, error, res as never);
  return res.redirect.mock.calls[0][0] as string;
}

const fragment = (url: string) => new URLSearchParams(new URL(url).hash.slice(1));
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("browser sign-in from the web portal", () => {
  it("refuses a client it does not know, without storing or redirecting anything", () => {
    const { controller } = build();
    for (const client of ["", "https://evil.example/", "Web", "ios"]) {
      const res = { redirect: jest.fn() };
      expect(() => controller.socialStart("google", "en", CHALLENGE, client, res as never)).toThrow(
        BadRequestException,
      );
      expect(res.redirect).not.toHaveBeenCalled();
    }
  });

  it("finishes at the portal with the handoff in the fragment, collectable only with the verifier", async () => {
    const { controller, flow } = build();
    const url = await callback(controller, stateOf(start(controller, "web")));

    expect(url.startsWith(`${WEB_CALLBACK_URL}#`)).toBe(true);
    expect(new URL(url).search).toBe("");
    const code = fragment(url).get("handoff")!;
    expect(code).toBeTruthy();
    expect(url).not.toContain(TOKENS.refreshToken);
    expect(flow.consumeHandoff(code, VERIFIER)).toEqual(TOKENS);
  });

  it("does not accept a web handoff without the verifier", async () => {
    const { controller, flow } = build();
    const code = fragment(await callback(controller, stateOf(start(controller, "web")))).get("handoff")!;
    expect(() => flow.consumeHandoff(code)).toThrow(BadRequestException);
  });

  it("sends a web start without a challenge back to the portal as invalid", () => {
    const { controller } = build();
    const url = start(controller, "web", null);
    expect(url.startsWith(WEB_CALLBACK_URL)).toBe(true);
    expect(fragment(url).get("error")).toBe("invalid");
  });

  it("sends a provider with no credentials back to the portal as unavailable", () => {
    const { controller, flow } = build();
    jest.spyOn(flow, "start").mockImplementation(() => {
      throw new BadRequestException(SOCIAL_REFUSALS.unavailable);
    });
    expect(fragment(start(controller, "web")).get("error")).toBe("unavailable");
  });

  it("brings a declined consent screen back to the portal", async () => {
    const { controller } = build();
    const url = await callback(controller, stateOf(start(controller, "web")), "access_denied");
    expect(url.startsWith(WEB_CALLBACK_URL)).toBe(true);
    expect(fragment(url).get("error")).toBe("cancelled");
  });

  it("says an expired web sign-in expired, on the portal", async () => {
    const { controller, flow } = build();
    const state = stateOf(start(controller, "web"));
    flow.consumeState(state);
    expect(fragment(await callback(controller, state)).get("error")).toBe("expired");
  });

  it.each([
    [new UnauthorizedException(SOCIAL_REFUSALS.disabled), "disabled"],
    [new UnauthorizedException(SOCIAL_REFUSALS.exists), "exists"],
    [new BadRequestException(SOCIAL_REFUSALS.noEmail), "no-email"],
    [new BadRequestException("Your Google account has not verified its email address. Please verify it with Google, or sign up with your email instead."), "unverified"],
    [new Error("database down"), "failed"],
  ])("lands a refusal on the portal as a short code (%#)", async (err, code) => {
    const { controller } = build(() => Promise.reject(err));
    const url = await callback(controller, stateOf(start(controller, "web")));
    expect(url.startsWith(WEB_CALLBACK_URL)).toBe(true);
    expect(fragment(url).get("error")).toBe(code);
    expect(fragment(url).get("detail")).toBeNull();
  });

  it("grants a new account its trial on the web route too", async () => {
    const { controller, auth } = build(() => Promise.resolve({ customer: { id: "c-new" }, created: true }));
    await callback(controller, stateOf(start(controller, "web")));
    expect(auth.onSocialSignup).toHaveBeenCalledWith("c-new");
  });
});

describe("browser sign-in from the apps is unchanged", () => {
  it("finishes at the app scheme with the handoff in the query", async () => {
    const { controller, flow } = build();
    const url = await callback(controller, stateOf(start(controller, undefined)));
    const parsed = new URL(url);
    expect(url.startsWith("neoconnect://social-callback?handoff=")).toBe(true);
    expect(flow.consumeHandoff(parsed.searchParams.get("handoff")!, VERIFIER)).toEqual(TOKENS);
  });

  it("still lets a client from before the binding start without a challenge", async () => {
    const { controller, flow } = build();
    const url = await callback(controller, stateOf(start(controller, undefined, null)));
    expect(flow.consumeHandoff(new URL(url).searchParams.get("handoff")!)).toEqual(TOKENS);
  });

  it("treats client=app as the apps", () => {
    const { controller } = build();
    expect(start(controller, "app")).toContain("https://accounts.google.com/");
  });

  it("still sends the apps the sentence for a refusal", async () => {
    const { controller } = build(() => Promise.reject(new UnauthorizedException(SOCIAL_REFUSALS.disabled)));
    const url = new URL(await callback(controller, stateOf(start(controller, undefined))));
    expect(url.protocol).toBe("neoconnect:");
    expect(url.searchParams.get("error")).toBe("rejected");
    expect(url.searchParams.get("detail")).toBe(SOCIAL_REFUSALS.disabled);
  });

  it("still sends the apps cancelled, invalid and the expired-link sentence", async () => {
    const { controller } = build();
    expect(new URL(await callback(controller, stateOf(start(controller, undefined)), "access_denied")).searchParams.get("error")).toBe("cancelled");
    expect(new URL(await callback(controller, undefined)).searchParams.get("error")).toBe("invalid");
    const expired = new URL(await callback(controller, "never-issued"));
    expect(expired.protocol).toBe("neoconnect:");
    expect(expired.searchParams.get("error")).toBe("rejected");
    expect(expired.searchParams.get("detail")).toBe("This sign-in link has expired -- please try again");
  });
});
