import { BadRequestException } from "@nestjs/common";
import { CustomerAuthController } from "./customer-auth.controller";
import { CustomerAuthService } from "./customer-auth.service";
import { LoginGuardService } from "../login-guard/login-guard.service";
import { verificationEmail } from "../email/templates";

/** The link in the verification email is the one thing a customer
 * interacts with before they have an account they can use, and the
 * previous version of it was unclickable in Gmail and Yahoo. What the
 * email points at, and what that page does, are both pinned here. */
describe("email verification link", () => {
  function controllerWith(verify: jest.Mock) {
    // The login guard is irrelevant to these cases -- they exercise the
    // verification landing page, which is reached from an emailed link
    // and never goes near a credential check.
    return new CustomerAuthController(
      { verifyEmail: verify } as unknown as CustomerAuthService,
      { enforce: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() } as unknown as LoginGuardService,
    );
  }

  describe("the link the email contains", () => {
    it("points at an https page when the public API address is known", () => {
      // Webmail strips custom URI schemes, so the button has to be a
      // normal https link to be clickable at all.
      const { html } = verificationEmail("tok-123", "123456", "https://panel.example.com/api");
      expect(html).toContain("https://panel.example.com/api/customer-auth/verify-email/open?token=tok-123");
      expect(html).not.toContain('href="neoconnect://');
    });

    it("tolerates a trailing slash on the configured address", () => {
      const { html } = verificationEmail("tok-123", "123456", "https://panel.example.com/api/");
      expect(html).toContain("https://panel.example.com/api/customer-auth/verify-email/open?token=tok-123");
    });

    it("falls back to the app link when no public address is configured", () => {
      // Worse, but not broken: the 6-digit code is the primary path and
      // works regardless.
      const { html } = verificationEmail("tok-123", "123456", undefined);
      expect(html).toContain("neoconnect://verify-email?token=tok-123");
    });

    it("always shows the code, which works in every mail client", () => {
      const { html } = verificationEmail("tok-123", "123456", "https://panel.example.com/api");
      expect(html).toContain("1 2 3 4 5 6");
    });
  });

  describe("the page that link opens", () => {
    it("verifies the account before rendering, so no app is needed", async () => {
      const verify = jest.fn().mockResolvedValue({ alreadyVerified: false, trial: null });
      const html = await controllerWith(verify).verifyEmailLanding("tok-123");

      expect(verify).toHaveBeenCalledWith("tok-123");
      expect(html).toContain("Email verified");
      // Opening the app is offered afterwards, not required.
      expect(html).toContain("neoconnect://verify-email?token=tok-123");
    });

    it("says so plainly when the address was already confirmed", async () => {
      const verify = jest.fn().mockResolvedValue({ alreadyVerified: true, trial: null });
      const html = await controllerWith(verify).verifyEmailLanding("tok-123");

      expect(html).toContain("Already verified");
    });

    it("explains an expired link instead of showing a stack trace", async () => {
      const verify = jest.fn().mockRejectedValue(new BadRequestException("Invalid or expired verification link"));
      const html = await controllerWith(verify).verifyEmailLanding("tok-123");

      expect(html).toContain("Invalid or expired verification link");
      expect(html).toContain("6-digit code");
    });

    it("handles a link that lost its token in transit", async () => {
      const verify = jest.fn();
      const html = await controllerWith(verify).verifyEmailLanding("");

      expect(verify).not.toHaveBeenCalled();
      expect(html).toContain("missing its verification token");
    });

    it("escapes the token into the app link rather than interpolating it raw", async () => {
      const verify = jest.fn().mockResolvedValue({ alreadyVerified: false, trial: null });
      const html = await controllerWith(verify).verifyEmailLanding('a"b&c');

      expect(html).not.toContain('token=a"b&c');
      expect(html).toContain("token=a%22b%26c");
    });
  });
});
