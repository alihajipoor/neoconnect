import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomersService } from "../customers/customers.service";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { FreeTrialSettingsService } from "../free-trial-settings/free-trial-settings.service";
import { CustomerAccessTokenPayload, CustomerRefreshTokenPayload } from "./types";

export interface CustomerTokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly freeTrialSettingsService: FreeTrialSettingsService,
  ) {}

  /** Creates the Customer via the same service/logic the admin-facing
   * CustomersService.create() already uses (argon2 hash, referralCode,
   * duplicate-email ConflictException) -- no separate signup logic to
   * keep in sync. If free trial mode is currently on, also grants a
   * trial subscription + auto-provisions real connection credentials on
   * the admin-configured trial route, so a native client's first-run
   * flow gets a fully working VPN account in one call. */
  async register(dto: CreateCustomerDto) {
    const customer = await this.customersService.create(dto);
    // Freshly created -- schema default is 0, no need to re-fetch.
    const tokens = await this.issueTokenPair({ id: customer.id, email: customer.email, tokenVersion: 0 });
    const trial = await this.grantFreeTrialIfEnabled(customer.id);
    return { ...tokens, trial };
  }

  private async grantFreeTrialIfEnabled(customerId: string) {
    const settings = await this.freeTrialSettingsService.get();
    if (!settings.enabled || !settings.trialPlanId || !settings.trialRouteId) {
      return null;
    }

    const subscription = await this.subscriptionsService.create({
      customerId,
      planId: settings.trialPlanId,
    });
    const protocolUser = await this.protocolUsersService.create({
      subscriptionId: subscription.id,
      routeId: settings.trialRouteId,
    });

    return { subscription, protocolUser };
  }

  async validateCredentials(email: string, password: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const valid = await argon2.verify(customer.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (customer.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is disabled");
    }
    return customer;
  }

  async login(email: string, password: string): Promise<CustomerTokenPair> {
    const customer = await this.validateCredentials(email, password);
    return this.issueTokenPair(customer);
  }

  async issueTokenPair(customer: { id: string; email: string; tokenVersion: number }): Promise<CustomerTokenPair> {
    const accessPayload: CustomerAccessTokenPayload = { sub: customer.id, email: customer.email };
    const refreshPayload: CustomerRefreshTokenPayload = { sub: customer.id, tokenVersion: customer.tokenVersion };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get<string>("customerJwt.accessSecret"),
      expiresIn: this.config.get<string>("customerJwt.accessTtl"),
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get<string>("customerJwt.refreshSecret"),
      expiresIn: this.config.get<string>("customerJwt.refreshTtl"),
    });

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<CustomerTokenPair> {
    let payload: CustomerRefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerRefreshTokenPayload>(refreshToken, {
        secret: this.config.get<string>("customerJwt.refreshSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const customer = await this.prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer || customer.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }

    return this.issueTokenPair(customer);
  }

  /** Invalidates all outstanding refresh tokens for this customer. */
  async revokeAllSessions(customerId: string): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { tokenVersion: { increment: 1 } },
    });
  }
}
