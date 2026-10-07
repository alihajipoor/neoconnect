import { CustomerAuthController } from "./customer-auth.controller";
import type { CustomerAuthService } from "./customer-auth.service";
import type { SocialAuthService } from "./social/social-auth.service";
import type { OauthFlowService } from "./social/oauth-flow.service";
import type { LoginGuardService } from "../login-guard/login-guard.service";

/** A Google or Apple sign-up is created already verified, so it never
 * passed through verification -- the only place a password sign-up is
 * granted its trial. With trial mode on, social sign-ups got nothing and
 * no log line said why. */
describe("social sign-in grants a new account what verification would", () => {
  function build(created: boolean) {
    const customer = { id: "cust-1", email: "a@example.com", tokenVersion: 0 };
    const auth = {
      onSocialSignup: jest.fn().mockResolvedValue(undefined),
      issueTokenPair: jest.fn().mockResolvedValue({ accessToken: "a", refreshToken: "r" }),
    };
    const social = {
      verify: jest.fn().mockResolvedValue({ subject: "s", email: "a@example.com", emailVerified: true }),
      resolveCustomer: jest.fn().mockResolvedValue({ customer, created }),
    };
    const oauth = {
      consumeState: jest.fn().mockReturnValue({ provider: "google", locale: "en" }),
      exchangeCode: jest.fn().mockResolvedValue("provider-token"),
      storeHandoff: jest.fn().mockReturnValue("handoff"),
      appCallback: jest.fn().mockReturnValue("neoconnect://done"),
    };
    const controller = new CustomerAuthController(
      auth as unknown as CustomerAuthService,
      {} as unknown as LoginGuardService,
      social as unknown as SocialAuthService,
      oauth as unknown as OauthFlowService,
    );
    return { controller, auth };
  }

  it("on the native route, for a new account, before the session is issued", async () => {
    const { controller, auth } = build(true);

    await controller.social({ provider: "google", token: "t" } as never, {});

    expect(auth.onSocialSignup).toHaveBeenCalledWith("cust-1");
    expect(auth.onSocialSignup.mock.invocationCallOrder[0]).toBeLessThan(
      auth.issueTokenPair.mock.invocationCallOrder[0],
    );
  });

  it("on the browser route, for a new account", async () => {
    const { controller, auth } = build(true);
    const res = { redirect: jest.fn() };

    await controller.socialCallback("google", "code", "state", undefined, res as never);

    expect(auth.onSocialSignup).toHaveBeenCalledWith("cust-1");
    expect(res.redirect).toHaveBeenCalledWith("neoconnect://done");
  });

  it("not for an account that already existed", async () => {
    const { controller, auth } = build(false);

    await controller.social({ provider: "apple", token: "t" } as never, {});

    expect(auth.onSocialSignup).not.toHaveBeenCalled();
  });
});
