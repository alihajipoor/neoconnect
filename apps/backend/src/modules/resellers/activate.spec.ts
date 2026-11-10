/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { VouchersService } from "../vouchers/vouchers.service";
import { REPEAT_WINDOW_MS, ResellersService } from "./resellers.service";

/**
 * POST /reseller/activate: a reseller puts a plan straight onto a
 * customer's account.
 *
 * It is "mint one code and redeem it for that customer", so these run
 * the real ResellersService against the real VouchersService.redeem over
 * one in-memory database. A mocked redeem would only prove that it was
 * called; what matters is what is left afterwards -- the balance, the
 * codes, the subscription -- and whether a refusal leaves any of it
 * changed.
 */

const PRO = { id: "plan-pro", name: "Pro", isActive: true, relayOnly: false };
const ULTIMATE = { id: "plan-ultimate", name: "Ultimate", isActive: true, relayOnly: true };

interface VoucherRow {
  id: string;
  code: string;
  planId: string;
  maxRedemptions: number | null;
  redeemedCount: number;
  expiresAt: Date | null;
  isActive: boolean;
  note: string | null;
  issuedByAdminId: string | null;
  recipientEmail: string | null;
  createdAt: Date;
}

type Args = Record<string, any>;

function world(start: { balances?: Record<string, number> } = {}) {
  const plans = [PRO, ULTIMATE].map((p) => ({ ...p }));
  const customers = [
    { id: "cust-1", email: "buyer@example.com", status: "ACTIVE", emailVerifiedAt: new Date(0) as Date | null },
    { id: "cust-2", email: "unconfirmed@example.com", status: "ACTIVE", emailVerifiedAt: null as Date | null },
    { id: "cust-3", email: "disabled@example.com", status: "DISABLED", emailVerifiedAt: new Date(0) as Date | null },
    { id: "cust-4", email: "another@example.com", status: "ACTIVE", emailVerifiedAt: new Date(0) as Date | null },
  ];
  /** `${adminUserId}:${planId}` -> tokens. */
  const balances = new Map(Object.entries(start.balances ?? { "reseller-1:plan-pro": 3 }));
  const vouchers: VoucherRow[] = [];
  const redemptions: { id: string; voucherId: string; customerId: string; subscriptionId: string | null }[] = [];
  const subscriptions: { id: string; customerId: string; planId: string; expireAt: Date }[] = [];
  let ids = 0;

  const withPlan = (v: VoucherRow) => ({ ...v, plan: plans.find((p) => p.id === v.planId)! });

  /** The Prisma calls `activate`, `revoke` and `redeem` make, and no
   * others. `undo` is the open transaction's, when there is one: each
   * write records how to take itself back. */
  function client(undo: (() => void)[] | null) {
    return {
      subscriptionPlan: {
        findUnique: async ({ where }: Args) => plans.find((p) => p.id === where.id) ?? null,
      },
      customer: {
        // An exact match, as the unique column is.
        findUnique: async ({ where }: Args) => customers.find((c) => c.email === where.email) ?? null,
      },
      resellerTokenBalance: {
        updateMany: async ({ where }: Args) => {
          const key = `${where.adminUserId}:${where.planId}`;
          const held = balances.get(key) ?? 0;
          if (held <= 0) return { count: 0 };
          balances.set(key, held - 1);
          undo?.push(() => balances.set(key, (balances.get(key) ?? 0) + 1));
          return { count: 1 };
        },
        upsert: async ({ where }: Args) => {
          const { adminUserId, planId } = where.adminUserId_planId;
          const key = `${adminUserId}:${planId}`;
          balances.set(key, (balances.get(key) ?? 0) + 1);
          undo?.push(() => balances.set(key, (balances.get(key) ?? 0) - 1));
          return {};
        },
      },
      voucher: {
        findUnique: async ({ where }: Args) => {
          const row = vouchers.find((v) => (where.id ? v.id === where.id : v.code === where.code));
          return row ? withPlan(row) : null;
        },
        findFirst: async ({ where }: Args) =>
          vouchers.find(
            (v) =>
              v.issuedByAdminId === where.issuedByAdminId &&
              v.planId === where.planId &&
              v.recipientEmail === where.recipientEmail &&
              v.note === where.note &&
              v.createdAt >= where.createdAt.gte,
          ) ?? null,
        create: async ({ data }: Args) => {
          const row: VoucherRow = {
            id: `v-${(ids += 1)}`,
            redeemedCount: 0,
            expiresAt: null,
            isActive: true,
            createdAt: new Date(Date.now()),
            ...data,
          };
          vouchers.push(row);
          undo?.push(() => vouchers.splice(vouchers.indexOf(row), 1));
          return withPlan(row);
        },
        // redeem's claim: counted only while a use is left.
        updateMany: async ({ where }: Args) => {
          const row = vouchers.find((v) => v.id === where.id);
          if (!row || !row.isActive) return { count: 0 };
          if (row.maxRedemptions !== null && row.redeemedCount >= row.maxRedemptions) return { count: 0 };
          row.redeemedCount += 1;
          return { count: 1 };
        },
        // revoke's delete: only its own, and only while unredeemed.
        deleteMany: async ({ where }: Args) => {
          const at = vouchers.findIndex(
            (v) => v.id === where.id && v.issuedByAdminId === where.issuedByAdminId && v.redeemedCount === 0,
          );
          if (at === -1) return { count: 0 };
          const [row] = vouchers.splice(at, 1);
          undo?.push(() => vouchers.push(row));
          return { count: 1 };
        },
      },
      voucherRedemption: {
        findUnique: async ({ where }: Args) => {
          const { voucherId, customerId } = where.voucherId_customerId;
          return redemptions.find((r) => r.voucherId === voucherId && r.customerId === customerId) ?? null;
        },
        create: async ({ data }: Args) => {
          const row = { id: `red-${(ids += 1)}`, subscriptionId: null, ...data };
          redemptions.push(row);
          return row;
        },
        update: async ({ where, data }: Args) =>
          Object.assign(redemptions.find((r) => r.id === where.id)!, data),
      },
    };
  }

  /** One transaction at a time, and a throw undoes what it wrote.
   *
   * The queue stands in for the lock Postgres takes on the balance row:
   * two activations by one reseller for one plan both update that row,
   * so the second waits until the first commits. Whether Postgres really
   * does that is not something a stand-in can show. */
  let queue: Promise<unknown> = Promise.resolve();
  const prisma = {
    ...client(null),
    $transaction: (work: (tx: ReturnType<typeof client>) => Promise<unknown>) => {
      const run = queue.then(async () => {
        const undo: (() => void)[] = [];
        try {
          return await work(client(undo));
        } catch (err) {
          undo.reverse().forEach((step) => step());
          throw err;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };

  const subscriptionsService = {
    create: jest.fn(async ({ customerId, planId }: Args) => {
      const row = { id: `sub-${(ids += 1)}`, customerId, planId, expireAt: new Date(Date.now() + 30 * 86_400_000) };
      subscriptions.push(row);
      return row;
    }),
  };
  const protocolUsers = {
    provisionAll: jest.fn(async () => ({ created: [{ id: "pu-1", credentials: { password: "the customer's" } }] })),
  };
  const email = { sendMail: jest.fn(async () => true) };

  const redeemer = new VouchersService(prisma as never, subscriptionsService as never, protocolUsers as never);
  const redeem = jest.spyOn(redeemer, "redeem");
  const service = new ResellersService(prisma as never, email as never, {} as never, {} as never, redeemer);

  return {
    service,
    redeemer,
    redeem,
    email,
    subscriptionsService,
    protocolUsers,
    plans,
    vouchers,
    redemptions,
    subscriptions,
    balance: (adminUserId: string, planId: string) => balances.get(`${adminUserId}:${planId}`) ?? 0,
  };
}

describe("a reseller activating a plan on a customer's account", () => {
  let now: number;

  beforeEach(() => {
    now = Date.parse("2026-11-10T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  it("spends exactly one token and puts the plan on the account through redeem", async () => {
    const w = world();

    const result = await w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    expect(w.balance("reseller-1", PRO.id)).toBe(2);

    // The customer's own redeem path, with the code just minted -- and
    // everything behind it: the subscription and the provisioning.
    expect(w.redeem).toHaveBeenCalledTimes(1);
    expect(w.redeem).toHaveBeenCalledWith("cust-1", w.vouchers[0].code, { restricted: false });
    expect(w.subscriptionsService.create).toHaveBeenCalledWith({ customerId: "cust-1", planId: PRO.id });
    expect(w.subscriptions).toHaveLength(1);
    expect(w.protocolUsers.provisionAll).toHaveBeenCalledWith(w.subscriptions[0].id);

    // One code, the reseller's own, used once, by this customer. That is
    // what puts it in their list as redeemed like any other.
    expect(w.vouchers).toHaveLength(1);
    expect(w.vouchers[0]).toMatchObject({
      issuedByAdminId: "reseller-1",
      planId: PRO.id,
      maxRedemptions: 1,
      redeemedCount: 1,
      recipientEmail: "buyer@example.com",
      note: "Activated by reseller for buyer@example.com",
    });
    expect(w.redemptions).toEqual([
      expect.objectContaining({ voucherId: w.vouchers[0].id, customerId: "cust-1", subscriptionId: w.subscriptions[0].id }),
    ]);

    expect(result).toEqual({
      activated: true,
      plan: { id: PRO.id, name: "Pro" },
      customerEmail: "buyer@example.com",
      voucherId: w.vouchers[0].id,
      code: w.vouchers[0].code,
      subscriptionId: w.subscriptions[0].id,
      expiresAt: w.subscriptions[0].expireAt,
    });
    // redeem hands back the customer's connection credentials. They are
    // not the reseller's to see.
    expect(JSON.stringify(result)).not.toContain("the customer's");
    // And nobody is mailed a code that is already used.
    expect(w.email.sendMail).not.toHaveBeenCalled();
  });

  it("finds the account the way sign-in does, whatever the capitals and spaces", async () => {
    const w = world();

    const result = await w.service.activate("reseller-1", PRO.id, "  Buyer@Example.COM ");

    expect(result.customerEmail).toBe("buyer@example.com");
    expect(w.redemptions[0].customerId).toBe("cust-1");
    expect(w.vouchers[0].recipientEmail).toBe("buyer@example.com");
  });

  it("spends nothing for an address no account uses", async () => {
    const w = world();

    const attempt = w.service.activate("reseller-1", PRO.id, "nobody@example.com");

    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt).rejects.toThrow("No account uses that email address");
    expect(w.balance("reseller-1", PRO.id)).toBe(3);
    expect(w.vouchers).toHaveLength(0);
    expect(w.redeem).not.toHaveBeenCalled();
  });

  it("spends nothing and leaves no code when redeem refuses", async () => {
    // The refusal is redeem's own, not one written for this test: an
    // account whose address is unconfirmed may only redeem a single-use
    // code for a relay-only plan, and Pro is not one.
    const w = world();

    const attempt = w.service.activate("reseller-1", PRO.id, "unconfirmed@example.com");

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/has not confirmed that address yet/);
    expect(w.redeem).toHaveBeenCalledWith("cust-2", expect.any(String), { restricted: true });
    expect(w.balance("reseller-1", PRO.id)).toBe(3);
    // Not switched off or left for later: gone, so there is nothing to
    // redeem and nothing to tidy up.
    expect(w.vouchers).toHaveLength(0);
    expect(w.redemptions).toHaveLength(0);
    expect(w.subscriptions).toHaveLength(0);
  });

  it("gives the token back when the plan is retired between the check and the redeem", async () => {
    const w = world();
    w.redeem.mockImplementationOnce((customerId, code, options) => {
      w.plans.find((p) => p.id === PRO.id)!.isActive = false;
      return VouchersService.prototype.redeem.call(w.redeemer, customerId, code, options);
    });

    const attempt = w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    // redeem's reason and redeem's status, and what it means for them.
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    await expect(attempt).rejects.toThrow(/Pro was not activated for buyer@example.com: .*no longer offered.* Your Pro tokens are unchanged./);

    expect(w.balance("reseller-1", PRO.id)).toBe(3);
    expect(w.vouchers).toHaveLength(0);
    expect(w.subscriptions).toHaveLength(0);
  });

  it("still puts a relay-only plan on an account whose address is unconfirmed", async () => {
    // The other half of the same rule. Refusing every plan to such an
    // account would be a rule redeem does not have.
    const w = world({ balances: { "reseller-1:plan-ultimate": 1 } });

    await w.service.activate("reseller-1", ULTIMATE.id, "unconfirmed@example.com");

    expect(w.balance("reseller-1", ULTIMATE.id)).toBe(0);
    expect(w.subscriptions).toEqual([expect.objectContaining({ customerId: "cust-2", planId: ULTIMATE.id })]);
  });

  it("refuses a disabled account before anything is minted", async () => {
    // Sign-in is what keeps a disabled account away from redeem, and
    // nobody signs in here.
    const w = world();

    await expect(w.service.activate("reseller-1", PRO.id, "disabled@example.com")).rejects.toThrow(/is disabled/);

    expect(w.balance("reseller-1", PRO.id)).toBe(3);
    expect(w.vouchers).toHaveLength(0);
    expect(w.redeem).not.toHaveBeenCalled();
  });

  it("is refused when the reseller has no tokens of that plan left", async () => {
    const w = world({ balances: { "reseller-1:plan-pro": 0 } });

    const attempt = w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/no Pro tokens left/);
    expect(w.balance("reseller-1", PRO.id)).toBe(0);
    expect(w.vouchers).toHaveLength(0);
    expect(w.redeem).not.toHaveBeenCalled();
    expect(w.subscriptions).toHaveLength(0);
  });

  it("refuses the same activation again inside 30 seconds, and allows it after", async () => {
    const w = world({ balances: { "reseller-1:plan-pro": 3, "reseller-1:plan-ultimate": 1 } });
    await w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    now += REPEAT_WINDOW_MS - 1_000;
    const repeat = w.service.activate("reseller-1", PRO.id, "Buyer@example.com");

    await expect(repeat).rejects.toBeInstanceOf(ConflictException);
    await expect(repeat).rejects.toThrow(/An activation of Pro for buyer@example.com was already made in the last 30 seconds.*no token was spent/);
    expect(w.balance("reseller-1", PRO.id)).toBe(2);
    expect(w.vouchers).toHaveLength(1);
    expect(w.subscriptions).toHaveLength(1);

    // A different customer, or a different plan, is not a repeat.
    await w.service.activate("reseller-1", PRO.id, "another@example.com");
    await w.service.activate("reseller-1", ULTIMATE.id, "buyer@example.com");
    expect(w.balance("reseller-1", PRO.id)).toBe(1);
    expect(w.balance("reseller-1", ULTIMATE.id)).toBe(0);

    // And a second one for the same customer, on purpose, goes through
    // once the window has passed.
    now += 2_000;
    await w.service.activate("reseller-1", PRO.id, "buyer@example.com");
    expect(w.balance("reseller-1", PRO.id)).toBe(0);
    expect(w.subscriptions).toHaveLength(4);
  });

  it("refuses the second of two submitted at once", async () => {
    // The double click. The check sits inside the mint transaction and
    // after the spend, so the second transaction -- held behind the
    // first on the balance row -- finds the first one's code. A check
    // made before the transaction would let both through here.
    const w = world();

    const results = await Promise.allSettled([
      w.service.activate("reseller-1", PRO.id, "buyer@example.com"),
      w.service.activate("reseller-1", PRO.id, "buyer@example.com"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictException);
    expect(w.balance("reseller-1", PRO.id)).toBe(2);
    expect(w.vouchers).toHaveLength(1);
    expect(w.subscriptions).toHaveLength(1);
  });

  it("says a repeat is a repeat even when the first took the last token", async () => {
    const w = world({ balances: { "reseller-1:plan-pro": 1 } });
    await w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    await expect(w.service.activate("reseller-1", PRO.id, "buyer@example.com")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(w.balance("reseller-1", PRO.id)).toBe(0);
  });

  it("cannot spend another reseller's tokens", async () => {
    // The balance is found by the caller's own id, from their token --
    // there is no id in the request to point at somebody else's.
    const w = world({ balances: { "reseller-1:plan-pro": 3 } });

    await expect(w.service.activate("reseller-2", PRO.id, "buyer@example.com")).rejects.toThrow(
      /no Pro tokens left/,
    );

    expect(w.balance("reseller-1", PRO.id)).toBe(3);
    expect(w.balance("reseller-2", PRO.id)).toBe(0);
    expect(w.vouchers).toHaveLength(0);
    expect(w.subscriptions).toHaveLength(0);
  });

  it("says so, and takes nothing back, when redeem fails after it has claimed the code", async () => {
    // redeem's rule, not this feature's: once the code is counted it
    // stays spent, with the record of who it went to. Here the
    // subscription exists and only the servers failed, so refunding the
    // token would be giving the plan away. What must not happen is the
    // reseller being told nothing happened.
    const w = world();
    const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    w.protocolUsers.provisionAll.mockRejectedValueOnce(
      new BadRequestException("The Pro plan's selected routes are all unavailable right now."),
    );

    const attempt = w.service.activate("reseller-1", PRO.id, "buyer@example.com");

    await expect(attempt).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(attempt).rejects.toThrow(/one Pro token was spent.*Do not try again/);
    expect(w.balance("reseller-1", PRO.id)).toBe(2);
    expect(w.vouchers).toEqual([expect.objectContaining({ redeemedCount: 1 })]);
    expect(w.subscriptions).toHaveLength(1);
    // Left where the operator will be sent to look.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("was claimed"));
  });
});
