import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import type { PrismaService } from "../../../prisma/prisma.service";
import { SocialAuthService } from "./social-auth.service";
import type { VerifiedIdentity } from "./verify";

/** The rules for turning a verified provider identity into a customer.
 *
 * These are the security of the feature. Getting the linking wrong does
 * not break anything visibly -- it hands one person another person's
 * account, silently, and only the victim ever notices. */
describe("resolving a customer from a social identity", () => {
  const verified: VerifiedIdentity = {
    subject: "sub-123",
    email: "Ali@Example.com",
    emailVerified: true,
  };

  function serviceWith(prisma: Record<string, unknown>) {
    return new SocialAuthService(
      prisma as unknown as PrismaService,
      { get: () => "configured" } as unknown as ConfigService,
    );
  }

  function prismaDouble(over: Record<string, unknown> = {}) {
    return {
      customerIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn(),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: "new", ...data }),
        ),
      },
      ...over,
    };
  }

  it("returns the customer already behind this provider subject", async () => {
    const prisma = prismaDouble({
      customerIdentity: {
        findUnique: jest.fn().mockResolvedValue({
          id: "identity-1",
          customer: { id: "existing", status: "ACTIVE", email: "ali@example.com", emailVerifiedAt: new Date() },
          email: "old@example.com",
        }),
        update: jest.fn(),
        create: jest.fn(),
      },
    });
    const { customer, created } = await serviceWith(prisma).resolveCustomer("GOOGLE", verified, "en");
    expect(customer.id).toBe("existing");
    expect(created).toBe(false);
    // The account is found by subject, so a changed address does not
    // fork it into a second one.
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it("links to an existing account when both sides have verified the address", async () => {
    const prisma = prismaDouble({
      customer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "existing", status: "ACTIVE", emailVerifiedAt: new Date() }),
        create: jest.fn(),
      },
    });
    const { customer, created } = await serviceWith(prisma).resolveCustomer("GOOGLE", verified, "en");
    expect(customer.id).toBe("existing");
    expect(created).toBe(false);
    expect(prisma.customerIdentity.create).toHaveBeenCalled();
    // Looked up lowercased: providers are inconsistent about case and
    // the column is not case-insensitive.
    expect(prisma.customer.findUnique).toHaveBeenCalledWith({
      where: { email: "ali@example.com" },
    });
  });

  it("refuses to link when the provider has not verified the address", async () => {
    const prisma = prismaDouble({
      customer: {
        findUnique: jest.fn().mockResolvedValue({ id: "victim", status: "ACTIVE" }),
        create: jest.fn(() => Promise.resolve({ id: "new" })),
      },
    });
    await expect(
      serviceWith(prisma).resolveCustomer("FACEBOOK", { ...verified, emailVerified: false }, "en"),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Never even looked for an account to attach to: an unverified
    // address is not evidence of anything.
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(prisma.customerIdentity.create).not.toHaveBeenCalled();
  });

  /** It used to create the account unverified, and the controller then
   * issued a full session: the one route that broke the rule that no
   * account is signed in before its address is proven. */
  it("creates no account from an address the provider has not verified", async () => {
    const prisma = prismaDouble();
    await expect(
      serviceWith(prisma).resolveCustomer("GOOGLE", { ...verified, emailVerified: false }, "en"),
    ).rejects.toThrow(/has not verified its email address/);
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it("refuses a session to an account this route once made unverified, until the provider vouches", async () => {
    const identityRow = {
      id: "identity-1",
      customer: { id: "old", status: "ACTIVE", email: "ali@example.com", emailVerifiedAt: null },
    };
    const prisma = prismaDouble({
      customerIdentity: { findUnique: jest.fn().mockResolvedValue(identityRow), update: jest.fn(), create: jest.fn() },
    });
    await expect(
      serviceWith(prisma).resolveCustomer("GOOGLE", { ...verified, emailVerified: false }, "en"),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Verified by the provider now, for the same address: proven.
    const update = jest.fn().mockResolvedValue({ ...identityRow.customer, emailVerifiedAt: new Date() });
    const later = prismaDouble({
      customerIdentity: { findUnique: jest.fn().mockResolvedValue(identityRow), update: jest.fn(), create: jest.fn() },
      customer: { findUnique: jest.fn(), create: jest.fn(), update },
    });
    const { customer } = await serviceWith(later).resolveCustomer("GOOGLE", verified, "en");
    expect(update).toHaveBeenCalledWith({ where: { id: "old" }, data: { emailVerifiedAt: expect.any(Date) } });
    expect(customer.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("refuses to link into an account that never confirmed its own address", async () => {
    const prisma = prismaDouble({
      customer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "victim", status: "ACTIVE", emailVerifiedAt: null }),
        create: jest.fn(),
      },
    });
    // Somebody signed up with this address and never proved it was
    // theirs. A provider proving it now says nothing about whether they
    // are the same person.
    await expect(serviceWith(prisma).resolveCustomer("GOOGLE", verified, "en")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.customerIdentity.create).not.toHaveBeenCalled();
  });

  it("refuses a disabled account rather than signing it back in", async () => {
    const prisma = prismaDouble({
      customerIdentity: {
        findUnique: jest.fn().mockResolvedValue({
          id: "identity-1",
          customer: { id: "banned", status: "SUSPENDED" },
        }),
        update: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(serviceWith(prisma).resolveCustomer("GOOGLE", verified, "en")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("creates a new account, lowercased and already verified", async () => {
    const prisma = prismaDouble();
    const { customer: made, created } = await serviceWith(prisma).resolveCustomer("APPLE", verified, "fa");
    const customer = made as unknown as {
      email: string;
      passwordHash: null;
      locale: string;
      emailVerifiedAt: Date | null;
    };
    // Reported, so the caller can grant what a verified sign-up is owed.
    expect(created).toBe(true);
    expect(customer.email).toBe("ali@example.com");
    expect(customer.passwordHash).toBeNull();
    expect(customer.locale).toBe("fa");
    // The provider already proved the address; mailing a confirmation
    // to it would only lose people.
    expect(customer.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("refuses an identity with no email rather than inventing one", async () => {
    const prisma = prismaDouble();
    // Reachable in normal use: Facebook accounts registered against a
    // phone have no address, and Apple sends one only on first consent.
    await expect(
      serviceWith(prisma).resolveCustomer("FACEBOOK", { subject: "s", email: null, emailVerified: false }, "en"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});
