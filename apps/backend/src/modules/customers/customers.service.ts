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
    await this.get(id);

    const { password, ...rest } = dto;
    const data: Prisma.CustomerUpdateInput = { ...rest };
    if (password) {
      data.passwordHash = await argon2.hash(password);
      data.tokenVersion = { increment: 1 };
    }

    if (!password) {
      return this.prisma.customer.update({ where: { id }, data, select: SAFE_SELECT });
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
    return updated;
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
          "Set their status to DISABLED instead to revoke access.",
      );
    }

    // Their device slots, while the subscriptions they are keyed on still
    // exist to be found. Never throws.
    await this.deviceSlots.releaseCustomer(id);

    // Under the customer lock, so no device of this customer is minting
    // credentials of its own between the read below and the transaction
    // -- a row created in that window would be deleted without any
    // DELETE_USER and stay live on its node. See withCustomerLock. A
    // fetch queued behind this finds its session gone (cascaded with the
    // customer) and is refused.
    await this.protocolUsers.withCustomerLock(id, async () => {
      const protocolUsers = await this.prisma.protocolUser.findMany({
        where: { subscription: { customerId: id } },
        select: DELETION_SELECT,
      });

      // Tell each node to drop the user before the row disappears --
      // otherwise the credential keeps working on the engine while the
      // panel believes the customer is gone. Aimed at the user's own
      // inbound (see command-target.ts): untargeted, a WebSocket or relay
      // customer's delete landed on the default inbound and was acked
      // while their credential went on working.
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
        this.prisma.protocolUser.deleteMany({ where: { subscription: { customerId: id } } }),
        this.prisma.subscription.deleteMany({ where: { customerId: id } }),
        this.prisma.customer.delete({ where: { id } }),
      ]);
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
