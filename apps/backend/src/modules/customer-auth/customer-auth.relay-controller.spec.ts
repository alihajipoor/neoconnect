/* eslint-disable @typescript-eslint/require-await -- the service stand-ins
   match the real ones' async signatures. */
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { CustomerAuthController } from "./customer-auth.controller";
import type { CustomerAuthService } from "./customer-auth.service";
import type { SocialAuthService } from "./social/social-auth.service";
import type { OauthFlowService } from "./social/oauth-flow.service";
import type { LoginGuardService } from "../login-guard/login-guard.service";
import type { RelayAuthService } from "../relay-auth/relay-auth.service";
import { attachRelayContext, type RelayContext } from "../../common/relay/relay-arrival";

/** The relay's side of the customer-auth routes (docs/relay-last-resort.md). */

const RELAY: RelayContext = { box: "ir-a", asn: 64500, region: "IR", ip: "192.0.2.10", ipKey: "relay:k" };

function build() {
  const order: string[] = [];
  const auth = {
    relayRegister: jest.fn(async () => {
      order.push("account");
      return { accessToken: "a", refreshToken: "r", recoveryCode: "C", relayUnverified: true };
    }),
    login: jest.fn(async () => ({ accessToken: "a", refreshToken: "r" })),
  };
  const reservation = {
    commit: jest.fn(async () => {
      order.push("commit");
    }),
    release: jest.fn(() => order.push("release")),
  };
  const relay = {
    assertSignupOpen: jest.fn(async () => {
      order.push("open");
    }),
    signupPowBits: jest.fn(() => 18),
    reserveSignup: jest.fn(async () => {
      order.push("reserve");
      return reservation;
    }),
    recordSignIn: jest.fn(async () => undefined),
    admitUnverifiedSignIn: jest.fn(async (): Promise<unknown> => null),
  };
  const loginGuard = {
    enforce: jest.fn((): number => 0),
    enforceMinimum: jest.fn(() => order.push("pow")),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };
  const controller = new CustomerAuthController(
    auth as unknown as CustomerAuthService,
    loginGuard as unknown as LoginGuardService,
    {} as SocialAuthService,
    {} as OauthFlowService,
    relay as unknown as RelayAuthService,
  );
  return { controller, auth, relay, loginGuard, reservation, order };
}

const dto = {
  email: "a@example.com",
  emailConfirm: "a@example.com",
  password: "password1",
  challenge: {} as never,
};

function relayReq(): Request {
  const req = { headers: {} } as unknown as Request;
  attachRelayContext(req, RELAY);
  return req;
}

describe("POST /customer-auth/relay-register", () => {
  it("does not exist for a request that did not come in by the relay listener", async () => {
    const { controller, auth, relay } = build();
    await expect(controller.relayRegister(dto, { headers: {} } as unknown as Request, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(relay.assertSignupOpen).not.toHaveBeenCalled();
    expect(auth.relayRegister).not.toHaveBeenCalled();
  });

  it("checks the switch and region, then the work, then the caps, then makes the account", async () => {
    const { controller, order } = build();
    await controller.relayRegister(dto, relayReq(), {});
    expect(order).toEqual(["open", "pow", "reserve", "account", "commit"]);
  });

  it("gives the place back when the account is not made", async () => {
    const { controller, auth, order } = build();
    auth.relayRegister.mockRejectedValueOnce(new ConflictException("taken"));
    await expect(controller.relayRegister(dto, relayReq(), {})).rejects.toBeInstanceOf(ConflictException);
    expect(order).toEqual(["open", "pow", "reserve", "release"]);
  });
});

describe("POST /customer-auth/login over the relay", () => {
  it("counts the caller by keyed hash, lets the service decide on an unverified account, and records the sign-in", async () => {
    const { controller, auth, loginGuard, relay } = build();
    loginGuard.enforce.mockReturnValueOnce(18);
    await controller.login({ email: "a@example.com", password: "password1" } as never, "192.0.2.10", {}, relayReq());
    expect(loginGuard.enforce).toHaveBeenCalledWith("customer", undefined, "a@example.com", "relay:k");
    const options = (auth.login.mock.calls[0] as unknown[])[3] as {
      channel: string;
      admitUnverified: (customerId: string) => unknown;
    };
    expect(options.channel).toBe("RELAY");
    await options.admitUnverified("customer-1");
    // The work this attempt proved, for the sign-up's floor (F4).
    expect(relay.admitUnverifiedSignIn).toHaveBeenCalledWith(RELAY, "customer-1", 18);
    expect(relay.recordSignIn).toHaveBeenCalledWith(RELAY);
  });

  it("does not count a refusal after the right password as a failed guess", async () => {
    const { controller, auth, loginGuard, relay } = build();
    const full = new HttpException({ statusCode: 429, code: "RELAY_SIGNUP_LIMIT", message: "later" }, 429);
    relay.admitUnverifiedSignIn.mockRejectedValueOnce(full);
    auth.login.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[3] as { admitUnverified: (id: string) => Promise<unknown> }).admitUnverified("customer-1");
      return { accessToken: "a", refreshToken: "r" };
    });
    await expect(
      controller.login({ email: "a@example.com", password: "password1" } as never, "192.0.2.10", {}, relayReq()),
    ).rejects.toBe(full);
    expect(loginGuard.recordFailure).not.toHaveBeenCalled();
    expect(relay.recordSignIn).not.toHaveBeenCalled();
  });

  it("puts the relay caller's key, never its address, on a failure", async () => {
    const { controller, auth, loginGuard } = build();
    auth.login.mockRejectedValueOnce(new Error("bad password"));
    await expect(
      controller.login({ email: "a@example.com", password: "x" } as never, "192.0.2.10", {}, relayReq()),
    ).rejects.toThrow();
    expect(loginGuard.recordFailure).toHaveBeenCalledWith("customer", "a@example.com", "relay:k");
  });

  it("is unchanged on the normal routes", async () => {
    const { controller, auth, loginGuard, relay } = build();
    await controller.login(
      { email: "a@example.com", password: "password1" } as never,
      "198.51.100.1",
      {},
      { headers: {} } as unknown as Request,
    );
    expect(loginGuard.enforce).toHaveBeenCalledWith("customer", undefined, "a@example.com", "198.51.100.1");
    expect((auth.login.mock.calls[0] as unknown[])[3]).toEqual({});
    expect(relay.recordSignIn).not.toHaveBeenCalled();
  });
});
