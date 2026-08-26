import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { normalise, randomCode } from "./voucher-code";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CreateVoucherDto } from "./dto/create-voucher.dto";
import { UpdateVoucherDto } from "./dto/update-voucher.dto";

// The code alphabet, length and the two helpers now live in
// ./voucher-code, shared with the reseller programme so both mint
// identical codes.

/** Exactly the columns the operator's voucher table renders.
 *
 * `recipientEmail` is the notable absentee. It is a customer's address,
 * written only by the reseller programme, and this route is the
 * operator's view of *every* code in the system -- so an unfiltered
 * `findMany` here handed back a list of buyers' email addresses to a
 * screen that has never displayed one. The reseller's own history is
 * where that field belongs, scoped to the codes they issued.
 *
 * `createdAt`/`updatedAt` are gone for the duller reason that no cell
 * shows them; `issuedByAdminId` because the table draws no distinction
 * between a code the operator cut and one a reseller did.
 *
 * `plan` and `_count` keep the shapes the table already reads -- under a
 * `select` a relation is a nested `select` rather than an `include`, but
 * the JSON is identical. */
const VOUCHER_LIST_FIELDS = {
  id: true,
  code: true,
  planId: true,
  maxRedemptions: true,
  redeemedCount: true,
  expiresAt: true,
  isActive: true,
  note: true,
  plan: { select: { id: true, name: true, durationDays: true, priceUsd: true } },
  _count: { select: { redemptions: true } },
} satisfies Prisma.VoucherSelect;

@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
  ) {}

  // ---------------------------------------------------------------- admin

  /** Every code in the system, newest first -- bounded.
   *
   * A voucher outlives the campaign it was cut for: they are switched
   * off rather than deleted, precisely so the record of who redeemed
   * what survives. That makes this table one that only grows, and it was
   * being read in full on every load of the vouchers screen. */
  async list(
    window: ListWindow,
  ): Promise<Page<Prisma.VoucherGetPayload<{ select: typeof VOUCHER_LIST_FIELDS }>>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.voucher.findMany({
        orderBy: { createdAt: "desc" },
        select: VOUCHER_LIST_FIELDS,
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.voucher.count(),
    ]);

    return { items, total };
  }

  async create(dto: CreateVoucherDto) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: dto.planId } });
    if (!plan) {
      throw new NotFoundException("That plan does not exist");
    }

    const code = dto.code ? normalise(dto.code) : await this.generateUniqueCode();
    if (!code) {
      throw new BadRequestException("A voucher code cannot be empty");
    }

    try {
      return await this.prisma.voucher.create({
        data: {
          code,
          planId: dto.planId,
          maxRedemptions: dto.maxRedemptions ?? null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          note: dto.note ?? null,
        },
        include: { plan: { select: { id: true, name: true } } },
      });
    } catch {
      // The unique index is what actually decides this, not a prior
      // read -- two admins generating codes at once would otherwise
      // both pass a lookup and one would fail with a 500.
      throw new ConflictException("A voucher with that code already exists");
    }
  }

  async update(id: string, dto: UpdateVoucherDto) {
    await this.mustExist(id);
    return this.prisma.voucher.update({
      where: { id },
      data: {
        // The plan and the limits are editable; the code is not. A code
        // already handed out cannot be taken back, so changing it would
        // silently break whatever is already printed or sent.
        planId: dto.planId,
        maxRedemptions: dto.maxRedemptions,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: dto.isActive,
        note: dto.note,
      },
      include: { plan: { select: { id: true, name: true } } },
    });
  }

  async remove(id: string) {
    await this.mustExist(id);
    // Redemptions cascade with it. Deleting is for codes that were never
    // used or were a mistake; to stop a live one, set isActive false and
    // keep the record of who redeemed it.
    await this.prisma.voucher.delete({ where: { id } });
    return { deleted: true };
  }

  private async mustExist(id: string) {
    const existing = await this.prisma.voucher.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("That voucher does not exist");
    }
    return existing;
  }

  private async generateUniqueCode(): Promise<string> {
    // Retried rather than assumed unique: 32^12 makes a clash
    // vanishingly unlikely, but "vanishingly" is not "never" and the
    // cost of checking is one indexed lookup.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      const clash = await this.prisma.voucher.findUnique({ where: { code } });
      if (!clash) return code;
    }
    throw new ConflictException("Could not generate a unique code, please try again");
  }

  // ------------------------------------------------------------- customer

  /** What a customer sees before committing: is this code real, and what
   * would it give them. Deliberately does not redeem, so the app can
   * show the plan and let them confirm. */
  async preview(rawCode: string) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: normalise(rawCode) },
      include: { plan: true },
    });
    if (!voucher || !this.isRedeemable(voucher)) {
      throw new NotFoundException("That voucher code is not valid");
    }
    return { code: voucher.code, plan: voucher.plan, expiresAt: voucher.expiresAt };
  }

  /** Spends a voucher for a customer and provisions what it grants. */
  async redeem(customerId: string, rawCode: string) {
    const code = normalise(rawCode);
    const voucher = await this.prisma.voucher.findUnique({ where: { code } });
    if (!voucher || !this.isRedeemable(voucher)) {
      throw new NotFoundException("That voucher code is not valid");
    }

    const already = await this.prisma.voucherRedemption.findUnique({
      where: { voucherId_customerId: { voucherId: voucher.id, customerId } },
    });
    if (already) {
      throw new ConflictException("You have already used this voucher");
    }

    // The claim is a single conditional update, and that is the whole
    // point. Checking the count and then incrementing it lets two
    // customers redeeming simultaneously both pass the check and both
    // get a one-time voucher. Postgres decides here instead.
    const claimed = await this.prisma.voucher.updateMany({
      where: {
        id: voucher.id,
        isActive: true,
        OR: [{ maxRedemptions: null }, { redeemedCount: { lt: voucher.maxRedemptions ?? 0 } }],
        ...(voucher.expiresAt ? { expiresAt: { gt: new Date() } } : {}),
      },
      data: { redeemedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new ConflictException("That voucher has already been fully used");
    }

    // Recorded before provisioning. If the grant below fails, the code
    // stays spent and the operator can see exactly who it went to --
    // the alternative loses the claim and lets a one-time code be
    // redeemed twice.
    const redemption = await this.prisma.voucherRedemption.create({
      data: { voucherId: voucher.id, customerId },
    });

    const subscription = await this.subscriptionsService.create({
      customerId,
      planId: voucher.planId,
    });
    const { created: protocolUsers } = await this.protocolUsersService.provisionAll(subscription.id);

    await this.prisma.voucherRedemption.update({
      where: { id: redemption.id },
      data: { subscriptionId: subscription.id },
    });

    return { subscription, protocolUsers, protocolUser: protocolUsers[0] ?? null };
  }

  /** Whether a code could be redeemed by somebody right now.
   *
   * Advisory only -- the authoritative check is the conditional update
   * in `redeem`, because anything read here can be stale by the time it
   * is acted on. This exists so the customer gets "not valid" rather
   * than "already fully used" for a code that never existed. */
  private isRedeemable(voucher: {
    isActive: boolean;
    expiresAt: Date | null;
    maxRedemptions: number | null;
    redeemedCount: number;
  }) {
    if (!voucher.isActive) return false;
    if (voucher.expiresAt && voucher.expiresAt <= new Date()) return false;
    if (voucher.maxRedemptions !== null && voucher.redeemedCount >= voucher.maxRedemptions) {
      return false;
    }
    return true;
  }
}

