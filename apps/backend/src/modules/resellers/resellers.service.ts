import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminRole, CustomerStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import { AppLinksService } from "../app-links/app-links.service";
import { resellerVoucherEmail, toLocale } from "../email/templates";
import { randomCode } from "../vouchers/voucher-code";
import { VouchersService } from "../vouchers/vouchers.service";

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

/** How long a second identical activation is refused for. Long enough
 * for a double click, a double submit or an impatient retry; short
 * enough that a reseller who really does mean two is not kept waiting. */
export const REPEAT_WINDOW_MS = 30_000;

/** The note on a code `activate` minted. Operator-facing like every
 * other note, and also how a repeat of the same activation is
 * recognised -- no code `generate` mints carries it. */
function activationNote(email: string): string {
  return `Activated by reseller for ${email}`;
}

/** The machine-readable `code` of a refusal that carries one. */
function codeOf(err: HttpException): unknown {
  const body = err.getResponse();
  return typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
}

/** Why redeem failed, as a sentence a reseller may be shown. Only a
 * refusal written to be shown is passed on: anything else is a fault
 * whose own text may quote a query. */
function reasonOf(err: unknown): string {
  if (!(err instanceof HttpException)) return "Something went wrong on our side.";
  return /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
}

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
    private readonly vouchers: VouchersService,
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
        // isActive so the workspace can say a retired plan's tokens cannot
        // be spent -- generate refuses them -- rather than hide a balance
        // the reseller paid for.
        select: { id: true, name: true, priceUsd: true, durationDays: true, isActive: true },
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
    // Before the token is spent. A code for a retired plan cannot be
    // redeemed, so minting one would cost the reseller a token for
    // something their customer cannot use.
    if (!plan.isActive) {
      throw new BadRequestException(
        `${plan.name} is no longer offered, so codes for it cannot be redeemed. Your ${plan.name} tokens are unchanged.`,
      );
    }

    const voucher = await this.mint(adminUserId, plan, {
      recipientEmail: recipientEmail ?? null,
      note: recipientEmail ? `Reseller code for ${recipientEmail}` : "Reseller code",
    });

    let emailed = false;
    if (recipientEmail) {
      emailed = await this.sendVoucherEmail(voucher.code, plan.name, recipientEmail, null);
    }

    return { ...voucher, emailed };
  }

  /** The spend and the code, in one transaction: what `generate` and
   * `activate` both mean by "mint".
   *
   * `refuse` runs inside that transaction, after the spend and before
   * anything is created, and refuses by throwing -- which rolls the
   * spend back. */
  private mint(
    adminUserId: string,
    plan: { id: string; name: string },
    fields: { recipientEmail: string | null; note: string },
    refuse?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const spent = await tx.resellerTokenBalance.updateMany({
        where: { adminUserId, planId: plan.id, balance: { gt: 0 } },
        data: { balance: { decrement: 1 } },
      });

      // After the spend, not before it: see refuseRepeat. And before the
      // balance is judged, so the second of two submissions against a
      // last token is told it is a repeat rather than that the tokens
      // ran out.
      if (refuse) await refuse(tx);

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
            planId: plan.id,
            // One customer, one use. A reseller's code is sold to a
            // named person, so an unlimited-use code would be a leak
            // rather than a feature.
            maxRedemptions: 1,
            issuedByAdminId: adminUserId,
            recipientEmail: fields.recipientEmail,
            note: fields.note,
          },
          include: { plan: { select: { id: true, name: true } } },
        });
      }

      // Throwing rolls back the decrement, so the token is not lost.
      throw new BadRequestException("Could not generate a unique code, please try again");
    });
  }

  // --------------------------------------------------------- activation

  /**
   * Put a plan straight onto a customer's account, spending one token.
   *
   * Exactly "mint one code and redeem it for that customer", and built
   * that way on purpose: the code is redeemed through
   * VouchersService.redeem, the same call the customer's own redeem
   * route makes, so whatever that path enforces and provisions applies
   * here without a second copy of it. It exists because a customer
   * cannot always redeem a code themselves -- the App Store build has no
   * screen to type one into.
   *
   * What the customer's route gets from its session, this has to ask
   * for, because nobody is signed in as the customer here:
   *
   *   - the account must be ACTIVE. Sign-in refuses a disabled account,
   *     so one never reaches redeem; redeem itself does not look.
   *   - an account whose address is unconfirmed is `restricted`, as it is
   *     on the customer's route: such an account either cannot sign in at
   *     all or is limited to single-use codes for a relay-only plan
   *     (docs/relay-last-resort.md, F1). redeem enforces that; this only
   *     tells it which kind of account it has.
   *
   * All or nothing, without one transaction. redeem writes through the
   * shared client, creates the subscription and then talks to the nodes,
   * and none of that can run inside a transaction of ours. So the code is
   * minted first (the spend and the insert together, as `generate` does),
   * redeemed, and if redeem refuses, taken back through `revoke` -- which
   * deletes it and refunds the token together. A crash between those
   * steps leaves an ordinary unused code in the reseller's own list,
   * addressed to that customer, which they can delete for the refund: a
   * token is never gone without something to show for it, and never
   * spent twice.
   *
   * The one case this cannot undo is redeem failing after it has claimed
   * the code -- the subscription could not be created, or was created and
   * could not be set up on the servers. That is redeem's own rule (a
   * claimed code stays spent, with the record of who it went to), revoke
   * rightly refuses a redeemed code, and the reseller is told exactly
   * that instead of being told nothing happened.
   */
  async activate(adminUserId: string, planId: string, customerEmail: string) {
    // Already done by the DTO; repeated because the lookup below is an
    // exact match and this method does not know who called it.
    const email = customerEmail.trim().toLowerCase();

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: planId },
      select: { id: true, name: true, isActive: true },
    });
    if (!plan) throw new NotFoundException("That plan does not exist");
    if (!plan.isActive) {
      throw new BadRequestException(
        `${plan.name} is no longer offered, so it cannot be activated. Your ${plan.name} tokens are unchanged.`,
      );
    }

    const customer = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true, status: true, emailVerifiedAt: true },
    });
    if (!customer) throw new NotFoundException("No account uses that email address");
    if (customer.status !== CustomerStatus.ACTIVE) {
      throw new BadRequestException(
        `The account for ${email} is disabled, so a plan cannot be activated on it. Your ${plan.name} tokens are unchanged.`,
      );
    }

    const note = activationNote(email);
    const voucher = await this.mint(adminUserId, plan, { recipientEmail: email, note }, (tx) =>
      this.refuseRepeat(tx, adminUserId, plan, email, note),
    );

    let redeemed: Awaited<ReturnType<VouchersService["redeem"]>>;
    try {
      redeemed = await this.vouchers.redeem(customer.id, voucher.code, {
        restricted: !customer.emailVerifiedAt,
      });
    } catch (refusal) {
      const reason = reasonOf(refusal);
      const outcome = await this.takeBack(adminUserId, voucher.id);

      if (outcome === "claimed") {
        this.logger.error(
          `Reseller ${adminUserId}: activation of plan ${plan.id} on customer ${customer.id} failed after code ${voucher.id} was claimed: ${String(refusal)}`,
        );
        throw new InternalServerErrorException(
          `${plan.name} could not be fully set up for ${email}: ${reason} ` +
            `The code made for it was used, so one ${plan.name} token was spent and it shows as redeemed in your list. ` +
            `Do not try again -- ask the operator to check this account.`,
        );
      }
      if (outcome === "left") {
        throw new InternalServerErrorException(
          `${plan.name} was not activated for ${email}: ${reason} ` +
            `The code made for it could not be removed just now. It is in your list as unused -- delete it there to get your token back.`,
        );
      }

      // Refused and undone. redeem's wording for the unconfirmed-address
      // rule is written to the customer ("your email", "this code"); the
      // reseller is somebody else and never saw a code.
      if (refusal instanceof ForbiddenException && codeOf(refusal) === "VOUCHER_NOT_ALLOWED") {
        throw new BadRequestException(
          `The owner of ${email} has not confirmed that address yet, and until they do ${plan.name} cannot be put on the account. ` +
            `Ask them to confirm it and try again. Your ${plan.name} tokens are unchanged.`,
        );
      }
      // Anything else redeem refused with keeps its status and its
      // reason, and gains the two things the reseller needs to know.
      const status = refusal instanceof HttpException ? refusal.getStatus() : 500;
      if (status >= 500) {
        this.logger.error(
          `Reseller ${adminUserId}: activation of plan ${plan.id} on customer ${customer.id} failed and was undone: ${String(refusal)}`,
        );
      }
      throw new HttpException(
        `${plan.name} was not activated for ${email}: ${reason} Your ${plan.name} tokens are unchanged.`,
        status,
      );
    }

    // Named fields only. redeem also returns the connection credentials
    // it provisioned, which belong to the customer and to nobody else.
    return {
      activated: true,
      plan: { id: plan.id, name: plan.name },
      customerEmail: email,
      voucherId: voucher.id,
      code: voucher.code,
      subscriptionId: redeemed.subscription.id,
      expiresAt: redeemed.subscription.expireAt,
    };
  }

  /** Refuses a second identical activation -- same reseller, same plan,
   * same customer -- inside `REPEAT_WINDOW_MS` of the first. A form that
   * submits twice must not spend twice.
   *
   * The first one's code is the record: it carries the reseller, the
   * plan, the address and a note only `activate` writes, and a refused
   * activation deletes its code, so what is found here either went
   * through or is still going.
   *
   * Run inside the mint transaction and after the spend, which is what
   * makes it hold for two requests at once and not only for one after
   * the other. Both spend from the same balance row, so the second waits
   * on the first's row lock until it commits, and its read here -- a new
   * statement, under Postgres's default READ COMMITTED -- then sees the
   * first one's code. Looking before the spend would let both look
   * before either had written anything. */
  private async refuseRepeat(
    tx: Prisma.TransactionClient,
    adminUserId: string,
    plan: { id: string; name: string },
    email: string,
    note: string,
  ) {
    const repeat = await tx.voucher.findFirst({
      where: {
        issuedByAdminId: adminUserId,
        planId: plan.id,
        recipientEmail: email,
        note,
        createdAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (repeat) {
      // "Made", not "done": the first may still be on its way through.
      throw new ConflictException(
        `An activation of ${plan.name} for ${email} was already made in the last ${REPEAT_WINDOW_MS / 1000} seconds, ` +
          `so this one was not carried out and no token was spent. If you meant to add a second one, wait a moment and try again.`,
      );
    }
  }

  /** Undoes the mint after redeem refused, through `revoke`, and says how
   * that went: `refunded` (the code is gone and the token is back),
   * `claimed` (redeem had already counted the code, so it stays spent),
   * or `left` (unused, still in the reseller's list, still theirs to
   * delete for the refund). Never throws. */
  private async takeBack(adminUserId: string, voucherId: string): Promise<"refunded" | "claimed" | "left"> {
    try {
      await this.revoke(adminUserId, voucherId);
      return "refunded";
    } catch (err) {
      const row = await this.prisma.voucher
        .findUnique({ where: { id: voucherId }, select: { redeemedCount: true } })
        .catch(() => null);
      if (row && row.redeemedCount > 0) return "claimed";
      this.logger.error(`Reseller ${adminUserId}: code ${voucherId} could not be taken back: ${String(err)}`);
      return "left";
    }
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
        locale: await this.localeFor(to),
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

  /** The one send in this codebase whose recipient may not have an
   * account, which is the whole point of it -- a reseller hands a
   * subscription to somebody who has never heard of us.
   *
   * So there is nothing to read a locale off unless the address already
   * belongs to a customer, which happens whenever a reseller renews
   * somebody they have sold to before. That case is worth catching: it
   * is a customer we already know reads Persian, and sending them
   * English again would be a regression we introduced knowingly.
   *
   * A genuine stranger gets English. The alternative is guessing from
   * the reseller, and a reseller's own language is not evidence about
   * their customer's -- resellers here sell across borders. Flagged as a
   * gap rather than papered over: if this matters, the right fix is for
   * the panel to let the reseller pick the language when they mint the
   * code, which is a UI change and not this one.
   */
  private async localeFor(email: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { email },
      select: { locale: true },
    });
    return toLocale(customer?.locale);
  }
}
