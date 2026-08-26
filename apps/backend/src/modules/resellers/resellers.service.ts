import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminRole, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import { AppLinksService } from "../app-links/app-links.service";
import { resellerVoucherEmail } from "../email/templates";
import { randomCode } from "../vouchers/voucher-code";

/** Where a recipient goes to redeem. The portal reads ?voucher= and
 * takes them to the plans screen whether or not they already have an
 * account, which is why one link serves both the brand-new person and
 * the existing customer. */
const DEFAULT_WEBSITE = "https://neoxify.net";

/** The nine fields myVouchers already hands back, named at the query
 * instead of after it.
 *
 * The mapping below picked these out of a whole row, so everything else
 * on the table -- `planId`, `note`, `maxRedemptions`, `updatedAt`, and
 * `issuedByAdminId`, which the WHERE clause has already pinned to the
 * caller -- was read from Postgres and then thrown away. Keeping the
 * projection and the mapping in step is the point: adding a column to
 * Voucher now cannot widen this response, and adding a field to the
 * mapping without adding it here fails to compile. */
const RESELLER_VOUCHER_FIELDS = {
  id: true,
  code: true,
  recipientEmail: true,
  createdAt: true,
  expiresAt: true,
  isActive: true,
  redeemedCount: true,
  plan: { select: { id: true, name: true } },
  redemptions: { select: { redeemedAt: true }, take: 1 },
} satisfies Prisma.VoucherSelect;

/** One row of a reseller's history, as the panel reads it. */
export interface ResellerVoucherRow {
  id: string;
  code: string;
  plan: { id: string; name: string };
  recipientEmail: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  isActive: boolean;
  redeemedCount: number;
  redeemedAt: Date | null;
  canRevoke: boolean;
}

@Injectable()
export class ResellersService {
  private readonly logger = new Logger(ResellersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appLinks: AppLinksService,
    private readonly config: ConfigService,
  ) {}

  // ----------------------------------------------------------- balances

  /** The calling reseller's own remaining capacity, one row per plan.
   *
   * Includes plans they have never been granted, at zero, so the panel
   * can show the full picture rather than hiding a plan the operator
   * has simply not topped up yet. */
  async myBalances(adminUserId: string) {
    const [plans, balances] = await Promise.all([
      this.prisma.subscriptionPlan.findMany({
        orderBy: { priceUsd: "asc" },
        select: { id: true, name: true, priceUsd: true, durationDays: true },
      }),
      this.prisma.resellerTokenBalance.findMany({ where: { adminUserId } }),
    ]);

    const byPlan = new Map(balances.map((b) => [b.planId, b.balance]));
    return plans.map((plan) => ({ plan, balance: byPlan.get(plan.id) ?? 0 }));
  }

  // ------------------------------------------------------------ minting

  /**
   * Mint one voucher, spending one token of that plan.
   *
   * The spend is a single conditional UPDATE -- `updateMany` with a
   * `balance > 0` guard -- and not a read followed by a write. Reading
   * first is the race that lets two concurrent generates both see a
   * balance of 1 and both succeed, which hands out capacity nobody paid
   * for. The database decides, once.
   *
   * Wrapped in a transaction with the insert so a failure to create the
   * voucher gives the token back automatically rather than leaving the
   * reseller charged for a code that does not exist.
   *
   * `recipientEmail` is optional on purpose: generating a bare code to
   * read out in person is a supported flow, not a degraded one.
   */
  async generate(adminUserId: string, planId: string, recipientEmail?: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException("That plan does not exist");

    const voucher = await this.prisma.$transaction(async (tx) => {
      const spent = await tx.resellerTokenBalance.updateMany({
        where: { adminUserId, planId, balance: { gt: 0 } },
        data: { balance: { decrement: 1 } },
      });

      if (spent.count === 0) {
        throw new BadRequestException(
          `You have no ${plan.name} tokens left. Ask the operator to top up your balance.`,
        );
      }

      // Retried rather than assumed unique: the collision odds are
      // negligible but the unique index is what actually decides, and a
      // clash inside a transaction would otherwise abort the whole
      // thing and silently cost the token.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = randomCode();
        const clash = await tx.voucher.findUnique({ where: { code } });
        if (clash) continue;

        return tx.voucher.create({
          data: {
            code,
            planId,
            // One customer, one use. A reseller's code is sold to a
            // named person, so an unlimited-use code would be a leak
            // rather than a feature.
            maxRedemptions: 1,
            issuedByAdminId: adminUserId,
            recipientEmail: recipientEmail ?? null,
            note: recipientEmail ? `Reseller code for ${recipientEmail}` : "Reseller code",
          },
          include: { plan: { select: { id: true, name: true } } },
        });
      }

      // Throwing rolls back the decrement, so the token is not lost.
      throw new BadRequestException("Could not generate a unique code, please try again");
    });

    let emailed = false;
    if (recipientEmail) {
      emailed = await this.sendVoucherEmail(voucher.code, plan.name, recipientEmail, null);
    }

    return { ...voucher, emailed };
  }

  // ------------------------------------------------------------ history

  /** The calling reseller's own codes, newest first -- bounded.
   *
   * Scoped on issuedByAdminId, which is the only thing stopping one
   * reseller seeing -- or revoking -- another's. That scope is not a
   * bound, though: a reseller who has been minting codes for a year has
   * every one of them still on the table, because a code is switched off
   * rather than deleted. The count is taken over the same WHERE clause,
   * so it is this reseller's total and never the whole table's. */
  async myVouchers(adminUserId: string, window: ListWindow): Promise<Page<ResellerVoucherRow>> {
    const where: Prisma.VoucherWhereInput = { issuedByAdminId: adminUserId };

    const [vouchers, total] = await this.prisma.$transaction([
      this.prisma.voucher.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: RESELLER_VOUCHER_FIELDS,
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.voucher.count({ where }),
    ]);

    const items = vouchers.map((v) => ({
      id: v.id,
      code: v.code,
      plan: v.plan,
      recipientEmail: v.recipientEmail,
      createdAt: v.createdAt,
      expiresAt: v.expiresAt,
      isActive: v.isActive,
      redeemedCount: v.redeemedCount,
      redeemedAt: v.redemptions[0]?.redeemedAt ?? null,
      // Computed here rather than in the UI so the button state and the
      // rule the server enforces cannot disagree -- a delete control
      // that is enabled and then errors is worse than one that is not
      // offered.
      canRevoke: v.redeemedCount === 0,
    }));

    return { items, total };
  }

  // ------------------------------------------------------------- revoke

  /**
   * Delete an unredeemed code and give the token back.
   *
   * The guard lives in the WHERE clause, not in a prior read: deleting
   * `where { id, issuedByAdminId, redeemedCount: 0 }` means a code
   * redeemed a millisecond ago simply matches nothing, instead of being
   * deleted out from under the customer who just used it. Ownership is
   * in the same clause, so another reseller's id matches nothing either
   * -- no separate authorisation step to forget.
   */
  async revoke(adminUserId: string, voucherId: string) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: voucherId },
      select: { id: true, planId: true, issuedByAdminId: true, redeemedCount: true },
    });
    if (!voucher) throw new NotFoundException("That code does not exist");
    if (voucher.issuedByAdminId !== adminUserId) {
      // Same message as a missing code: whether another reseller's code
      // exists is not this reseller's business.
      throw new NotFoundException("That code does not exist");
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.voucher.deleteMany({
        where: { id: voucherId, issuedByAdminId: adminUserId, redeemedCount: 0 },
      });

      if (deleted.count === 0) {
        throw new BadRequestException(
          "That code has already been redeemed, so it cannot be deleted or refunded.",
        );
      }

      // upsert, not update: the balance row can legitimately be absent
      // if the operator revoked the reseller's remaining capacity after
      // they minted this. The refund is still owed.
      await tx.resellerTokenBalance.upsert({
        where: { adminUserId_planId: { adminUserId, planId: voucher.planId } },
        create: { adminUserId, planId: voucher.planId, balance: 1 },
        update: { balance: { increment: 1 } },
      });
    });

    return { deleted: true, refunded: true };
  }

  // ------------------------------------------------------------- resend

  /** Send an existing code again, optionally to a different address --
   * the common case being a typo in the first one. */
  async resend(adminUserId: string, voucherId: string, overrideEmail?: string) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: voucherId },
      include: { plan: { select: { name: true } } },
    });
    if (!voucher || voucher.issuedByAdminId !== adminUserId) {
      throw new NotFoundException("That code does not exist");
    }

    const to = overrideEmail ?? voucher.recipientEmail;
    if (!to) {
      throw new BadRequestException(
        "This code was generated without an email address. Provide one to send it.",
      );
    }

    const sent = await this.sendVoucherEmail(
      voucher.code,
      voucher.plan.name,
      to,
      voucher.expiresAt,
    );

    // Remember where it actually went, so the history row and a future
    // resend both reflect reality rather than the original intent.
    if (sent && to !== voucher.recipientEmail) {
      await this.prisma.voucher.update({
        where: { id: voucher.id },
        data: { recipientEmail: to },
      });
    }

    return { sent };
  }

  // -------------------------------------------------------------- admin

  /** Every reseller and what they hold. Operator-facing. */
  async listResellers() {
    const resellers = await this.prisma.adminUser.findMany({
      where: { role: AdminRole.RESELLER },
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        createdAt: true,
        resellerBalances: {
          select: { balance: true, plan: { select: { id: true, name: true } } },
        },
        _count: { select: { issuedVouchers: true } },
      },
    });

    return resellers.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.createdAt,
      balances: r.resellerBalances,
      vouchersIssued: r._count.issuedVouchers,
    }));
  }

  /**
   * Set a reseller's balance for one plan to an absolute number.
   *
   * Absolute rather than a delta, because this is driven by a form the
   * operator types into after being paid, and a form that submits twice
   * must not grant twice. "Set to 10" is idempotent; "add 10" is not.
   */
  async setBalance(adminUserId: string, planId: string, balance: number) {
    if (!Number.isInteger(balance) || balance < 0) {
      throw new BadRequestException("A balance must be a whole number, zero or more");
    }

    const reseller = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { role: true },
    });
    if (!reseller) throw new NotFoundException("That account does not exist");
    if (reseller.role !== AdminRole.RESELLER) {
      throw new ForbiddenException("That account is not a reseller");
    }

    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException("That plan does not exist");

    return this.prisma.resellerTokenBalance.upsert({
      where: { adminUserId_planId: { adminUserId, planId } },
      create: { adminUserId, planId, balance },
      update: { balance },
      include: { plan: { select: { id: true, name: true } } },
    });
  }

  // ------------------------------------------------------------ private

  /** The long form, /account/?voucher=CODE, rather than the short /r/CODE.
   *
   * This used to emit /r/CODE, and the reasoning was sound: it gets
   * pasted into chat, read aloud and printed, and a query string reads
   * like a tracking URL. What that reasoning missed is that /r/CODE has
   * never worked on the live site, so every activation email sent so far
   * carried a link that silently landed on the marketing homepage.
   *
   * The redirect it depends on is defined in website/.htaccess, which
   * only Apache reads. neoxify.net is served by nginx, which does not.
   * Measured 2026-08-14, not inferred: GET /r/ABCD2345 returns 200 and
   * the homepage, while GET /account/?voucher=ABCD2345 reaches the
   * portal with the code carried in -- the web portal reads the param in
   * apps/web-portal/src/App.tsx.
   *
   * So this is the form that works on the host we actually run. Going
   * back to /r/CODE means installing website/nginx-website.conf.example
   * on the web host first, and not before. */
  private async activationUrl(code: string): Promise<string> {
    const links = await this.appLinks.get();
    const site = (links.websiteUrl ?? DEFAULT_WEBSITE).replace(/\/$/, "");
    return `${site}/account/?voucher=${encodeURIComponent(code)}`;
  }

  /** Best-effort, like every other send in this codebase: a mail failure
   * must not undo a voucher that was successfully minted. The caller
   * gets a boolean so the UI can offer a resend rather than claiming it
   * arrived. */
  private async sendVoucherEmail(
    code: string,
    planName: string,
    to: string,
    expiresAt: Date | null,
  ): Promise<boolean> {
    try {
      const message = resellerVoucherEmail({
        code,
        planName,
        activationUrl: await this.activationUrl(code),
        publicApiUrl: this.config.get<string>("publicApiUrl"),
        expiresAt,
      });
      return await this.email.sendMail({ to, ...message });
    } catch (err) {
      this.logger.warn(`Could not email voucher to ${to}: ${String(err)}`);
      return false;
    }
  }
}
