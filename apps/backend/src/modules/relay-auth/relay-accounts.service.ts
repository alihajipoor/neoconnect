import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { hashRecoveryCode, newRecoveryCode, recoveryCodeMatches } from "../customer-auth/recovery-code";
import { forgetVerified } from "../../common/guards/customer-jwt-auth.guard";

/** Support's side of recovery codes. */
@Injectable()
export class RelayAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async moveAddress(customerId: string, recoveryCode: string, email: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, recoveryCodeHash: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    if (!recoveryCodeMatches(recoveryCode, customer.recoveryCodeHash)) {
      throw new BadRequestException("That recovery code does not match this account");
    }
    const taken = await this.prisma.customer.findUnique({ where: { email }, select: { id: true } });
    if (taken && taken.id !== customerId) throw new ConflictException("A customer with this email already exists");

    const next = newRecoveryCode();
    // The new address is unproven, so the account is unverified until its
    // owner confirms it -- whatever it was before.
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        email,
        emailVerifiedAt: null,
        emailVerificationCode: null,
        emailVerificationCodeExpiresAt: null,
        passwordResetCode: null,
        passwordResetCodeExpiresAt: null,
        relayMailAt: null,
        recoveryCodeHash: hashRecoveryCode(next),
        recoveryCodeSetAt: new Date(),
      },
    });
    forgetVerified(customerId);
    return { email, recoveryCode: next };
  }
}
