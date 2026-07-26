import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { PaymentStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

const SAFE_SELECT = {
  id: true,
  email: true,
  telegramId: true,
  referralCode: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

  list() {
    return this.prisma.customer.findMany({ select: SAFE_SELECT, orderBy: { createdAt: "desc" } });
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

    return this.prisma.customer.update({ where: { id }, data, select: SAFE_SELECT });
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

    const protocolUsers = await this.prisma.protocolUser.findMany({
      where: { subscription: { customerId: id } },
      select: { id: true, nodeId: true, protocol: true, externalUserId: true },
    });

    // Tell each node to drop the user before the row disappears --
    // otherwise the credential keeps working on the engine while the
    // panel believes the customer is gone.
    for (const user of protocolUsers) {
      await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", {
        protocol: user.protocol,
        externalUserId: user.externalUserId,
      });
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
  }
}
