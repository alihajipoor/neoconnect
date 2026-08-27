import { BadRequestException } from "@nestjs/common";
import { InvoiceStatus, ReferralRewardReason } from "@prisma/client";
import { cursoredFindMany } from "../../../test/cursored";
import { ReferralsService, maskEmail } from "./referrals.service";

/** The reward rules, as configured by default. */
const SETTINGS = {
  id: "s1",
  enabled: true,
  rewardPlanId: "plan-reward" as string | null,
  loyalFriendMonths: 3,
  friendsRequired: 3,
  friendMonths: 1,
  rewardDays: 30,
  updatedAt: new Date(),
};

const DAY = 24 * 60 * 60 * 1000;

/** A paid invoice covering `months` 30-day months. */
function paidInvoice(customerId: string, months: number) {
  const periodStart = new Date("2026-01-01T00:00:00Z");
  return {
    customerId,
    periodStart,
    periodEnd: new Date(periodStart.getTime() + months * 30 * DAY),
  };
}

type IdFilter = { in: string[] };

/** A Prisma double holding just enough state for the credit arithmetic:
 * who invited whom, what they paid for, and what has already been spent.
 *
 * Hand-built rather than mocked call-by-call because the property under
 * test is that the same paid month cannot buy two rewards -- which is
 * about state surviving between calls, exactly what a per-call mock
 * cannot express. */
function fakePrisma(options: {
  friends: string[];
  invoices: ReturnType<typeof paidInvoice>[];
  spent?: Record<string, number>;
}) {
  const credits = new Map<string, number>(Object.entries(options.spent ?? {}));
  const rewards: { referrerId: string; reason: ReferralRewardReason; sourceJson: unknown }[] = [];

  // Declared before the object and given its behaviour after, because a
  // transaction that runs against the same double is inherently
  // self-referential and TypeScript cannot infer a type that includes
  // itself.
  const $transaction = jest.fn<Promise<unknown>, [(tx: unknown) => unknown]>();

  const prisma = {
    rewards,
    credits,
    customer: {
      // Cursor-aware -- the sweep reads referrers in batches.
      findMany: cursoredFindMany(options.friends.map((id) => ({ id }))),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          email: `${where.id}@example.com`,
          referralCode: "abcd1234",
          referredByCustomerId: null,
        }),
      ),
      findFirst: jest.fn((): Promise<{ id: string; status: string } | null> => Promise.resolve(null)),
    },
    invoice: {
      findMany: jest.fn(({ where }: { where: { customerId: IdFilter; status: InvoiceStatus } }) =>
        Promise.resolve(
          options.invoices.filter(
            (i) => where.customerId.in.includes(i.customerId) && where.status === InvoiceStatus.PAID,
          ),
        ),
      ),
    },
    referralCredit: {
      findMany: jest.fn(({ where }: { where: { referredCustomerId: IdFilter } }) =>
        Promise.resolve(
          [...credits.entries()]
            .filter(([id]) => where.referredCustomerId.in.includes(id))
            .map(([referredCustomerId, monthsSpent]) => ({ referredCustomerId, monthsSpent })),
        ),
      ),
      upsert: jest.fn(
        (args: {
          where: { referredCustomerId: string };
          create: { monthsSpent: number };
          update: { monthsSpent?: { increment: number } };
        }) => {
          const id = args.where.referredCustomerId;
          const add = args.update.monthsSpent?.increment ?? args.create.monthsSpent;
          credits.set(id, (credits.get(id) ?? 0) + add);
          return Promise.resolve({});
        },
      ),
    },
    referralReward: {
      create: jest.fn((args: { data: (typeof rewards)[number] }) => {
        rewards.push(args.data);
        return Promise.resolve({ id: `r${rewards.length}`, ...args.data });
      }),
      update: jest.fn(() => Promise.resolve({})),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    subscription: {
      findFirst: jest.fn((): Promise<{ id: string; expireAt: Date } | null> => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    subscriptionPlan: { findUnique: jest.fn(() => Promise.resolve({ name: "Reward" })) },
    $transaction,
  };

  // Runs the callback against this same double, so a transaction
  // behaves like the writes it wraps. That is what makes the "spent
  // months survive between sweeps" assertions meaningful.
  $transaction.mockImplementation((fn) => Promise.resolve(fn(prisma)));

  return prisma;
}

type Fake = ReturnType<typeof fakePrisma>;

function buildService(prisma: Fake, settings: typeof SETTINGS = SETTINGS) {
  const settingsService = { get: jest.fn(() => Promise.resolve(settings)) };
  const subscriptionsService = { create: jest.fn(() => Promise.resolve({ id: "sub-new" })) };
  const protocolUsersService = { provisionAll: jest.fn(() => Promise.resolve({ created: [], revoked: [] })) };
  const emailService = { sendMail: jest.fn(() => Promise.resolve(true)) };

  const service = new ReferralsService(
    prisma as never,
    settingsService as never,
    subscriptionsService as never,
    protocolUsersService as never,
    emailService as never,
  );
  return { service, subscriptionsService, emailService };
}

describe("maskEmail", () => {
  it("keeps an address recognisable without disclosing it", () => {
    // The inviter should be able to tell which friend this is; a
    // stranger who found the referral link should not walk away with a
    // usable address.
    expect(maskEmail("alexander@example.com")).toBe("a••••••r@example.com");
    expect(maskEmail("alexander@example.com")).not.toContain("lexande");
  });

  it("masks a short local part entirely rather than partially", () => {
    // "a•b@x.com" would give away almost everything about a
    // three-letter name, so there is nothing worth keeping.
    expect(maskEmail("bob@example.com")).toBe("•••@example.com");
  });

  it("does not throw on something that is not an address", () => {
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describe("ReferralsService.sweep", () => {
  it("grants a reward when one friend reaches the loyal threshold", async () => {
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 3)] });
    const { service } = buildService(prisma);

    expect(await service.sweep()).toBe(1);
    expect(prisma.rewards[0].reason).toBe(ReferralRewardReason.LOYAL_FRIEND);
  });

  it("grants a reward when enough friends each reach the smaller threshold", async () => {
    const prisma = fakePrisma({
      friends: ["f1", "f2", "f3"],
      invoices: [paidInvoice("f1", 1), paidInvoice("f2", 1), paidInvoice("f3", 1)],
    });
    const { service } = buildService(prisma);

    expect(await service.sweep()).toBe(1);
    expect(prisma.rewards[0].reason).toBe(ReferralRewardReason.SEVERAL_FRIENDS);
  });

  it("does not grant the same reward twice", async () => {
    // The property the whole ReferralCredit table exists for. Without
    // it a friend who has paid for three months earns their inviter a
    // free month on every sweep, forever -- six hours apart, silently,
    // until someone notices the revenue.
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 3)] });
    const { service } = buildService(prisma);

    expect(await service.sweep()).toBe(1);
    expect(await service.sweep()).toBe(0);
    expect(await service.sweep()).toBe(0);
    expect(prisma.rewards).toHaveLength(1);
  });

  it("spends exactly the months a reward cost, leaving the rest", async () => {
    // Five paid months at a threshold of three is one reward now and
    // two months carried forward -- not one reward and a reset to zero,
    // which would quietly confiscate what the customer had earned.
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 5)] });
    const { service } = buildService(prisma);

    await service.sweep();
    expect(prisma.credits.get("f1")).toBe(3);
  });

  it("grants repeatedly when enough has accumulated between runs", async () => {
    // Someone who has not been swept in a long time is owed everything
    // they earned in the meantime, not just the most recent one.
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 7)] });
    const { service } = buildService(prisma);

    expect(await service.sweep()).toBe(2);
    expect(prisma.credits.get("f1")).toBe(6);
  });

  it("ignores time that was never paid for", async () => {
    // Free trials, operator-granted subscriptions and referral rewards
    // themselves all create subscriptions and none of them is revenue.
    // Counting them would let a chain of referrals pay for itself.
    const prisma = fakePrisma({ friends: ["f1", "f2", "f3"], invoices: [] });
    const { service } = buildService(prisma);

    expect(await service.sweep()).toBe(0);
    expect(prisma.rewards).toHaveLength(0);
  });

  it("does nothing while no reward plan is chosen", async () => {
    // Referrals still accumulate -- nothing is lost while the operator
    // decides what the reward should be.
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 6)] });
    const { service } = buildService(prisma, { ...SETTINGS, rewardPlanId: null });

    expect(await service.sweep()).toBe(0);
    expect(prisma.credits.size).toBe(0);
  });

  it("does nothing while the programme is switched off", async () => {
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 6)] });
    const { service } = buildService(prisma, { ...SETTINGS, enabled: false });

    expect(await service.sweep()).toBe(0);
  });

  it("extends an existing subscription on the reward plan rather than adding a second", async () => {
    // "A free month" should mean the customer's service lasts a month
    // longer, not that they now have two subscriptions to understand.
    const expireAt = new Date(Date.now() + 10 * DAY);
    const prisma = fakePrisma({ friends: ["f1"], invoices: [paidInvoice("f1", 3)] });
    prisma.subscription.findFirst = jest.fn(() =>
      Promise.resolve({ id: "sub-existing", expireAt }),
    );
    const { service, subscriptionsService } = buildService(prisma);

    await service.sweep();

    expect(subscriptionsService.create).not.toHaveBeenCalled();
    const call = prisma.subscription.update.mock.calls[0] as unknown as [
      { where: { id: string }; data: { expireAt: Date } },
    ];
    expect(call[0].where.id).toBe("sub-existing");
    // Added to the existing expiry, not to today -- otherwise being
    // rewarded early would throw the remaining time away.
    expect(call[0].data.expireAt.getTime()).toBe(expireAt.getTime() + 30 * DAY);
  });
});

describe("ReferralsService.resolveReferralCode", () => {
  it("accepts no code at all", async () => {
    const prisma = fakePrisma({ friends: [], invoices: [] });
    const { service } = buildService(prisma);
    await expect(service.resolveReferralCode(undefined)).resolves.toBeNull();
    await expect(service.resolveReferralCode("   ")).resolves.toBeNull();
  });

  it("rejects a code that does not exist", async () => {
    // Deliberately an error rather than a silent ignore. A typo that
    // quietly loses someone their friend's reward is worse than one
    // more field to correct, and neither party would ever find out.
    const prisma = fakePrisma({ friends: [], invoices: [] });
    const { service } = buildService(prisma);
    await expect(service.resolveReferralCode("nope")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects any code while the programme is off", async () => {
    const prisma = fakePrisma({ friends: [], invoices: [] });
    const { service } = buildService(prisma, { ...SETTINGS, enabled: false });
    await expect(service.resolveReferralCode("abcd1234")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("resolves a real code to its owner", async () => {
    const prisma = fakePrisma({ friends: [], invoices: [] });
    prisma.customer.findFirst = jest.fn(() => Promise.resolve({ id: "inviter", status: "ACTIVE" }));
    const { service } = buildService(prisma);
    await expect(service.resolveReferralCode(" ABCD1234 ")).resolves.toBe("inviter");
  });

  it("refuses a disabled customer's code", async () => {
    const prisma = fakePrisma({ friends: [], invoices: [] });
    prisma.customer.findFirst = jest.fn(() =>
      Promise.resolve({ id: "inviter", status: "DISABLED" }),
    );
    const { service } = buildService(prisma);
    await expect(service.resolveReferralCode("abcd1234")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
