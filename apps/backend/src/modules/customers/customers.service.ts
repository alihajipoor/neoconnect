import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import { CustomerStatus, PaymentStatus, Prisma, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { deleteUserPayload } from "../protocol-users/command-target";
import { DeviceSlotsService } from "../device-slots/device-slots.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

const SAFE_SELECT = {
  id: true,
  email: true,
  telegramId: true,
  referralCode: true,
  status: true,
  locale: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** What deleting an account needs of each credential: where it lives,
 * who it is, which inbound it is on, and (for WireGuard) its address --
 * see deleteUserPayload. */
const DELETION_SELECT = {
  id: true,
  nodeId: true,
  protocol: true,
  externalUserId: true,
  credentialsJson: true,
  protocolConfig: { select: { transport: true, inboundTag: true } },
} satisfies Prisma.ProtocolUserSelect;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
    private readonly protocolUsers: ProtocolUsersService,
    private readonly deviceSlots: DeviceSlotsService,
  ) {}

  /** Every customer, a page at a time.
   *
   * The projection was already safe -- `SAFE_SELECT` keeps `passwordHash`,
   * `tokenVersion` and the one-time codes out -- but the row count was
   * the whole table, ordered newest first, on the two panel pages an
   * operator opens most.
   *
   * `total` matters here more than on any other list in this API. The
   * overview dashboard prints the customer count as a headline figure,
   * and it used to get it from `customers.length` on the unpaginated
   * response. A default window without a real count would have turned
   * that card into "however many rows fit on a page" -- a number that
   * looks correct, is not, and nothing in the UI would have flagged.
   */
  async list(window: ListWindow): Promise<Page<Prisma.CustomerGetPayload<{ select: typeof SAFE_SELECT }>>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        select: SAFE_SELECT,
        orderBy: { createdAt: "desc" },
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.customer.count(),
    ]);
    return { items, total };
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!customer) {
      throw new NotFoundException("Customer not found");
    }
    return customer;
  }

  async create(dto: CreateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("A customer with this email already exists");
    }
    const passwordHash = await argon2.hash(dto.password);
    const referralCode = randomBytes(4).toString("hex");
    return this.prisma.customer.create({
      data: {
        email: dto.email,
        passwordHash,
        telegramId: dto.telegramId,
        referralCode,
      },
      select: SAFE_SELECT,
    });
  }

  /** Sets the language this customer is written to in.
   *
   * Deliberately not routed through update() above: that one revokes
   * every session when it sees a password, and a customer tapping a
   * language switch must not be signed out of their own app. Narrow on
   * purpose -- the caller is the customer themselves, and the only field
   * they are trusted with about their own row is this one.
   */
  async setLocale(id: string, locale: "en" | "fa") {
    await this.get(id);
    return this.prisma.customer.update({ where: { id }, data: { locale }, select: SAFE_SELECT });
  }

  /** A password in the DTO is hashed and swapped for the raw value before
   * it can reach the database, and every existing session for that
   * customer is revoked via tokenVersion.
   *
   * The revocation is the point, not a side effect: an admin resetting a
   * password is usually responding to "someone else may be in my
   * account", and leaving already-issued refresh tokens working would
   * defeat the reset entirely. Same reason the self-serve reset bumps it.
   */
  async update(id: string, dto: UpdateCustomerDto) {
    const current = await this.get(id);

    const { password, ...rest } = dto;
    const data: Prisma.CustomerUpdateInput = { ...rest };
    if (password) {
      data.passwordHash = await argon2.hash(password);
      data.tokenVersion = { increment: 1 };
    }

    // Every save as DISABLED, not only the change to it: an account
    // disabled before setting the status revoked anything still has its
    // credentials on the nodes (the re-assert no longer puts them back,
    // but nothing took them off), and saving it again is how an operator
    // finishes that. Every step of disable() is safe to repeat.
    const disabling = rest.status === CustomerStatus.DISABLED;
    const enabling = rest.status === CustomerStatus.ACTIVE && current.status !== CustomerStatus.ACTIVE;
    if (disabling) return this.disable(id, data);

    if (!password) {
      const updated = await this.prisma.customer.update({ where: { id }, data, select: SAFE_SELECT });
      if (enabling) await this.catchUpRoutes(id);
      return updated;
    }

    // The sessions are revoked in the same transaction as the password,
    // so they succeed or fail together; see applyNewPassword in
    // CustomerAuthService for why.
    const [updated] = await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data, select: SAFE_SELECT }),
      this.prisma.customerSession.updateMany({
        where: { customerId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // The refresh tokens stop with tokenVersion; the device credentials
    // those sessions were issued are taken back here. Best effort: the
    // password is already written, and the hourly sweep finishes what
    // this does not, since the sessions are already revoked. The
    // subscription's shared credentials are NOT touched in phase 1 --
    // anyone holding a copy keeps a working tunnel (see
    // docs/per-device-credentials.md, "Transition").
    try {
      await this.protocolUsers.endSessions(id);
    } catch (err) {
      this.logger.error(
        `Password set for customer ${id}, but their device credentials could not be taken back yet: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // And their device slots, as the customer's own password change and
    // reset do: a device just signed out must not go on showing as "in
    // use" to the next device that connects. Every device here -- the
    // admin's request is none of them. Never throws.
    await this.deviceSlots.releaseOtherSessions(id);
    if (enabling) await this.catchUpRoutes(id);
    return updated;
  }

  /** Setting a customer to DISABLED, which is what the panel's Status
   * control and remove()'s refusal both tell an operator to do to cut
   * someone off.
   *
   * It used to write the column and nothing else. The app kept
   * refreshing its tokens, kept fetching its credentials, could still
   * switch route and be given new ones, and every credential stayed on its
   * node -- the 60 s re-assert kept them there -- until the subscription
   * ran out. Only a new password or social sign-in was refused, so the
   * panel showed an account as Disabled that still had a working tunnel.
   *
   * Now, as a password reset does, every session is revoked with the
   * status in one transaction (refresh also refuses a non-ACTIVE account),
   * the device credentials are taken back, every shared credential is
   * switched off on its node, and the device slots go.
   *
   * The credential rows keep their status (see switchOffCustomer). A
   * disabled customer's rows are not live (liveCredentialWhere), so
   * setting the account ACTIVE again brings back exactly the ones still
   * ACTIVE at the next re-assert, within a minute, and a credential the
   * quota or an operator switched off on its own stays off. */
  private async disable(id: string, data: Prisma.CustomerUpdateInput) {
    const [updated] = await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id },
        data: { ...data, tokenVersion: { increment: 1 } },
        select: SAFE_SELECT,
      }),
      this.prisma.customerSession.updateMany({
        where: { customerId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // Best effort from here, each step on its own: the account is already
    // disabled and signed out, and what the nodes are not told now the
    // re-assert no longer puts back -- an engine restart drops it.
    try {
      await this.protocolUsers.endSessions(id);
    } catch (err) {
      this.logger.error(
        `Customer ${id} disabled, but their device credentials could not be taken back yet: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      const { failed } = await this.protocolUsers.switchOffCustomer(id);
      if (failed > 0) {
        this.logger.error(`Customer ${id} disabled, but ${failed} credential(s) could not be switched off yet`);
      }
    } catch (err) {
      this.logger.error(
        `Customer ${id} disabled, but their credentials could not be switched off: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await this.deviceSlots.releaseCustomer(id);
    return updated;
  }

  /** A customer made ACTIVE again picks up the routes added while it was
   * disabled (provisionAll adds nothing to a disabled account). Its
   * existing credentials need nothing: the re-assert restores them. Never
   * throws -- the status is already written. */
  private async catchUpRoutes(id: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId: id, status: SubscriptionStatus.ACTIVE },
      select: { id: true },
    });
    for (const subscription of subscriptions) {
      await this.protocolUsers.provisionAll(subscription.id).catch((err: unknown) => {
        this.logger.error(
          `Customer ${id} re-enabled, but subscription ${subscription.id} could not be provisioned: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  /** Deletes a customer along with everything that exists solely to serve
   * them: their provisioned VPN credentials (torn down on the node
   * first, not just dropped from the database), their sessions, and
   * their subscriptions.
   *
   * Previously this was a bare `customer.delete()`, which meant any
   * customer who had ever had a subscription -- i.e. all of them -- hit
   * a foreign key violation and a raw 500 with nothing explaining why.
   * Same class of bug the Nodes/Plans/ProtocolConfigs services already
   * guard against; this one was simply missed.
   *
   * Payment history is the deliberate exception. A customer with real
   * transactions is refused rather than deleted, because those rows are
   * financial records that must survive: an operator wanting to cut off
   * access should disable the account, which is what the message says.
   * That also keeps this from being an easy way to erase an audit
   * trail. */
  async remove(id: string) {
    await this.get(id);

    // Only money that actually moved counts. Blocking on every row meant
    // an abandoned checkout -- a customer who pressed Card, changed their
    // mind, and left a PENDING row behind -- made the account permanently
    // undeletable, which is what an operator hit trying to clear out test
    // accounts. A payment that never cleared, or that failed, records
    // nothing worth preserving against deletion.
    //
    // CONFIRMED and REFUNDED both stay protected: a refund is precisely
    // the case where the trail matters most.
    const settledCount = await this.prisma.paymentTransaction.count({
      where: { customerId: id, status: { in: [PaymentStatus.CONFIRMED, PaymentStatus.REFUNDED] } },
    });
    if (settledCount > 0) {
      throw new BadRequestException(
        `Cannot delete this customer -- they have ${settledCount} completed payment(s), which are financial records and must be kept. ` +
          "Set their status to DISABLED instead: that signs them out everywhere and switches off their VPN access.",
      );
    }

    // DELETE_USER went to every node, and the device slots were wiped,
    // before a transaction that then always failed on a foreign key for a
    // customer with a support ticket, a voucher redemption or a referral
    // row: the panel got a raw 500, the database still had the customer,
    // and their devices were cut off until a re-assert put the
    // credentials back. The transaction now removes those rows too, and
    // the slots go only once it has committed.
    //
    // The DELETE_USERs still go first, deliberately (the same order as
    // SubscriptionsService.remove): if the transaction fails for some
    // other reason, the rows survive and the re-assert restores the
    // credentials within a minute or two. The other way round, a command
    // that failed after the commit would leave a working credential on a
    // node with no row anywhere to say so.
    //
    // Under the customer lock, so no device of this customer is minting
    // credentials of its own between the read below and the transaction
    // -- a row created in that window would be deleted without any
    // DELETE_USER and stay live on its node. See withCustomerLock. A
    // fetch queued behind this finds its session gone (cascaded with the
    // customer) and is refused.
    await this.protocolUsers.withCustomerLock(id, async () => {
      const [protocolUsers, subscriptions] = await Promise.all([
        this.prisma.protocolUser.findMany({
          where: { subscription: { customerId: id } },
          select: DELETION_SELECT,
        }),
        this.prisma.subscription.findMany({ where: { customerId: id }, select: { id: true } }),
      ]);

      // Tell each node to drop the user before the row disappears.
      // Aimed at the user's own inbound (see command-target.ts):
      // untargeted, a WebSocket or relay customer's delete landed on the
      // default inbound and was acked while their credential went on
      // working.
      for (const user of protocolUsers) {
        await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", deleteUserPayload(user, user.protocolConfig));
      }

      // Ordered by dependency, innermost first. Invoices and payment
      // transactions are included now that an unsettled attempt no longer
      // blocks deletion -- without them this would fail on a foreign key
      // and surface as a raw 500, the precise failure the guard above was
      // written to avoid. Nothing here can be a settled payment: that case
      // was already refused.
      await this.prisma.$transaction([
        // Usage records outlive the ProtocolUser by design (see the
        // UsageRecord model), but they belong to this customer's
        // subscriptions, so they go here.
        this.prisma.usageRecord.deleteMany({ where: { subscription: { customerId: id } } }),
        // Before the transactions they reference.
        this.prisma.invoice.deleteMany({ where: { customerId: id } }),
        this.prisma.paymentTransaction.deleteMany({ where: { customerId: id } }),
        // The rows that point at the customer with no ON DELETE, and so
        // refused the delete. Each exists to serve this customer: their
        // support conversations (messages cascade), the codes they
        // redeemed (Voucher.redeemedCount is its own counter, so a code
        // does not get a use back), the rewards they earned as a referrer,
        // and the record of what their own payments credited whoever
        // referred them.
        this.prisma.supportTicket.deleteMany({ where: { customerId: id } }),
        this.prisma.voucherRedemption.deleteMany({ where: { customerId: id } }),
        this.prisma.referralReward.deleteMany({ where: { referrerId: id } }),
        this.prisma.referralCredit.deleteMany({ where: { referredCustomerId: id } }),
        this.prisma.protocolUser.deleteMany({ where: { subscription: { customerId: id } } }),
        this.prisma.subscription.deleteMany({ where: { customerId: id } }),
        this.prisma.customer.delete({ where: { id } }),
      ]);

      // Their device slots, once the delete has committed, by the
      // subscription ids read above: the rows they would be found by are
      // gone. Never throws.
      for (const subscription of subscriptions) {
        await this.deviceSlots.releaseSubscription(subscription.id);
      }
    });
  }

  /** The customer deleting their own account.
   *
   * Deliberately not `remove()` above, which refuses when a settled
   * payment exists. That refusal is right for an operator clearing out
   * an account -- a paid invoice is a financial record -- but it cannot
   * apply here: **both app stores require account deletion to be
   * available**, so "you have paid us, therefore you may not leave" is
   * not an answer we are allowed to give. Apple 5.1.1(v) and Play's data
   * deletion policy both make it a condition of being listed at all.
   *
   * So this anonymises rather than deletes. The customer stops existing
   * in every sense they can observe -- they cannot sign in, their
   * address is gone, their credentials stop working -- while the invoice
   * and payment rows survive with nothing personal attached to them.
   * That is the shape that satisfies both the store requirement and the
   * accounting one, which is why it is not simply `remove()` with the
   * guard taken out.
   *
   * Remaining paid time is forfeited. Blocking deletion until a
   * subscription expires is not an option for the same reason as above.
   * The client must say so plainly before the customer confirms.
   */
  async deleteOwnAccount(id: string) {
    await this.get(id);

    // Unique, so it cannot collide with a real address or with another
    // deleted account, and `.invalid` is reserved by RFC 2606 precisely
    // so it can never be a deliverable domain. A future bug that tries
    // to email this address fails loudly instead of reaching a stranger
    // who happens to own the mailbox.
    const anonymisedEmail = `deleted-${randomUUID()}@deleted.invalid`;

    // Hashed rather than set to a sentinel string: argon2.verify throws
    // on input that is not a valid hash, so a sentinel would turn a
    // login attempt against a deleted account into a 500 rather than a
    // clean rejection. Before taking the lock below, so the lock is held
    // for database work only.
    const unusablePassword = await argon2.hash(randomBytes(32).toString("hex"));

    // Under the customer lock, so no device of this customer is minting
    // credentials of its own between the read and the transaction. See
    // withCustomerLock: without it a fetch in that window left either a
    // live credential with no row, or fresh ACTIVE credentials on the
    // CANCELLED subscription served to a session nothing had revoked.
    const revoked = await this.protocolUsers.withCustomerLock(id, async () => {
      // Every credential on every node, first and outside the
      // transaction. This is the part that actually matters: a customer
      // whose row is gone but whose WireGuard peer is still configured on
      // the node keeps a working tunnel indefinitely, and nothing would
      // ever report it.
      //
      // Note the plural. Since failover began provisioning a credential on
      // every route the plan allows, one customer holds several, spread
      // across different nodes -- so this is N deletions, not one, and
      // treating it as one would leave working credentials behind on every
      // node but the first.
      const protocolUsers = await this.prisma.protocolUser.findMany({
        where: { subscription: { customerId: id } },
        select: DELETION_SELECT,
      });

      for (const user of protocolUsers) {
        await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", deleteUserPayload(user, user.protocolConfig));
      }

      await this.prisma.$transaction([
        // The rows the nodes were just told to forget.
        this.prisma.protocolUser.deleteMany({ where: { subscription: { customerId: id } } }),
        // Every signed-in device. tokenVersion below stops the refresh
        // tokens; this stops the access tokens still in their fifteen
        // minutes from fetching or minting anything (both check the
        // session). The rows stay -- that check reads them -- and nothing
        // prunes them afterwards (the sweep only visits sessions still
        // holding credentials, and these have just lost theirs), so what a
        // device called itself goes, from every session the account ever
        // had: a label can be the customer's own name for their device.
        this.prisma.customerSession.updateMany({
          where: { customerId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        this.prisma.customerSession.updateMany({
          where: { customerId: id },
          data: { label: null, platform: null },
        }),
        // The Google, Apple and Facebook links: the provider's subject and
        // the real address it gave. Left behind, they were personal data
        // kept past a deletion the app promises removes it, and every
        // later "Continue with Google" by the same person found this
        // disabled row by subject and was refused for ever -- they could
        // never sign up again with that account.
        this.prisma.customerIdentity.deleteMany({ where: { customerId: id } }),
        // Ends the subscription without deleting it -- the invoices below
        // point at it, and an invoice for a subscription that no longer
        // exists is worse than useless to an accountant.
        this.prisma.subscription.updateMany({
          where: { customerId: id },
          data: { status: SubscriptionStatus.CANCELLED },
        }),
        this.prisma.customer.update({
          where: { id },
          data: {
            email: anonymisedEmail,
            passwordHash: unusablePassword,
            telegramId: null,
            referralCode: null,
            status: CustomerStatus.DISABLED,
            // Kills every outstanding refresh token immediately. Without
            // this the app keeps working until the access token expires,
            // which is a deleted account still carrying traffic.
            tokenVersion: { increment: 1 },
            emailVerifiedAt: null,
            emailVerificationCode: null,
            emailVerificationCodeExpiresAt: null,
            passwordResetCode: null,
            passwordResetCodeExpiresAt: null,
          },
        }),
      ]);
      return protocolUsers.length;
    });

    // Every device slot of the account: nobody is using it any more.
    // Never throws.
    await this.deviceSlots.releaseCustomer(id);

    return { deleted: true, credentialsRevoked: revoked };
  }
}
