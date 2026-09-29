import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { IdentityProvider } from "@prisma/client";

import { PrismaService } from "../../../prisma/prisma.service";
import { verifyApple, verifyFacebook, verifyGoogle, type VerifiedIdentity } from "./verify";

/** Signing in with Google, Apple or Facebook.
 *
 * The whole flow is: prove the token really came from the provider,
 * find or create the customer behind it, then hand back the same token
 * pair a password login would. Nothing downstream knows or cares how
 * somebody signed in.
 */
@Injectable()
export class SocialAuthService {
  private readonly logger = new Logger(SocialAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      // A misconfigured provider must not look like a rejected user.
      // Without this the customer sees "sign-in failed", tries again,
      // and nothing in the logs says the server was never given a
      // client id.
      this.logger.error(`${key} is not configured; this provider cannot be used`);
      throw new BadRequestException("This sign-in method is not available right now");
    }
    return value;
  }

  async verify(provider: IdentityProvider, token: string): Promise<VerifiedIdentity> {
    try {
      switch (provider) {
        case "GOOGLE":
          return await verifyGoogle(token, [this.required("GOOGLE_OAUTH_CLIENT_ID")]);
        case "APPLE":
          // The bundle identifier, because iOS uses the native sheet.
          // Listed rather than hardcoded so a future macOS or web client
          // can be added without touching this file.
          return await verifyApple(token, this.required("APPLE_SIGNIN_AUDIENCES").split(","));
        case "FACEBOOK":
          return await verifyFacebook(
            token,
            this.required("FACEBOOK_APP_ID"),
            this.required("FACEBOOK_APP_SECRET"),
          );
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // The reason is logged and not returned. "token signed by an
      // unknown key" tells an attacker probing us exactly which check
      // they tripped; the customer only needs to know it did not work.
      this.logger.warn(
        `${provider} sign-in rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException("We could not verify that sign-in");
    }
  }

  /** Finds the customer behind a verified identity, or makes one.
   *
   * Three cases, in order:
   *
   *  1. We have seen this (provider, subject) before -- that is the
   *     customer, whatever the address says now.
   *  2. We have not, but the provider gave a *verified* address that
   *     matches an existing account that has itself verified that
   *     address. Link them, so somebody who signed up with a password
   *     and later taps "Continue with Google" lands in their own
   *     account rather than a second empty one.
   *  3. Otherwise, a new account.
   *
   * The verification requirement in (2) is the security of the whole
   * feature. Linking on an unverified address means anyone who can make
   * a provider account claiming an address can walk into the account
   * that owns it, which is account takeover dressed as convenience.
   */
  async resolveCustomer(provider: IdentityProvider, identity: VerifiedIdentity, locale: string) {
    const existing = await this.prisma.customerIdentity.findUnique({
      where: { provider_subject: { provider, subject: identity.subject } },
      include: { customer: true },
    });

    if (existing) {
      await this.prisma.customerIdentity.update({
        where: { id: existing.id },
        data: { lastUsedAt: new Date(), email: identity.email ?? existing.email },
      });
      if (existing.customer.status !== "ACTIVE") {
        throw new UnauthorizedException("This account is disabled");
      }
      return existing.customer;
    }

    if (identity.email && identity.emailVerified) {
      const byEmail = await this.prisma.customer.findUnique({
        where: { email: identity.email.toLowerCase() },
      });
      if (byEmail) {
        if (byEmail.status !== "ACTIVE") {
          throw new UnauthorizedException("This account is disabled");
        }
        if (!byEmail.emailVerifiedAt) {
          // They signed up with a password and never confirmed the
          // address. Someone else proving the same address through a
          // provider is not evidence that these are the same person, so
          // this is the one case that refuses rather than guessing.
          throw new UnauthorizedException(
            "An account with this email already exists. Sign in with your password to finish setting it up.",
          );
        }
        await this.prisma.customerIdentity.create({
          data: { customerId: byEmail.id, provider, subject: identity.subject, email: identity.email },
        });
        return byEmail;
      }
    }

    // No address, no account. Facebook accounts registered against a
    // phone number have none, and Apple returns one only on the very
    // first consent -- so this is reachable in normal use, not a
    // theoretical branch.
    //
    // The alternative was a placeholder address, and it is worse than it
    // looks: the service emails people their expiry warning, their
    // invoice and their password reset, so an account that cannot
    // receive mail is broken from the moment it is created and only
    // reveals it weeks later when a renewal notice goes nowhere. Better
    // to refuse now and say why.
    if (!identity.email) {
      throw new BadRequestException(
        "That account has no email address. Neoxify needs one to send your subscription and support messages -- please sign up with an email instead.",
      );
    }

    // The address is already proven by the provider, so there is nothing
    // to verify -- mailing a confirmation to an address Google has just
    // vouched for only loses people.
    return this.prisma.customer.create({
      data: {
        email: identity.email.toLowerCase(),
        passwordHash: null,
        locale,
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
        identities: { create: { provider, subject: identity.subject, email: identity.email } },
      },
    });
  }
}
