import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "../protocol-users/credentials-crypto";
import { UpdatePaymentSettingsDto } from "./dto/update-payment-settings.dto";

/** What a provider needs to actually run, once decrypted. */
export interface StripeCredentials {
  secretKey: string;
  webhookSecret?: string;
  publishableKey?: string;
}

export interface NowPaymentsCredentials {
  apiKey: string;
  ipnSecret?: string;
}

/** Plisio needs only the API key: it signs callbacks with that same key
 * rather than a separate IPN secret. */
export interface PlisioCredentials {
  apiKey: string;
}

@Injectable()
export class PaymentSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The singleton row, created on first read. Same lazily-initialised
   * shape as EmailSettings -- no seed step to forget, and a fresh install
   * has working (disabled) settings rather than a null to guard against
   * everywhere. */
  private async row() {
    const existing = await this.prisma.paymentSettings.findFirst();
    if (existing) return existing;
    return this.prisma.paymentSettings.create({ data: {} });
  }

  /** Admin-facing view. Secrets are never returned, only whether each one
   * is set -- an admin needs to know a key is configured, not what it is,
   * and echoing it back would put a live payment key in the browser and in
   * every proxy log between here and there. */
  async get() {
    const row = await this.row();
    return {
      id: row.id,
      stripeEnabled: row.stripeEnabled,
      stripePublishableKey: row.stripePublishableKey,
      stripeSecretKeySet: Boolean(row.stripeSecretKeyEncrypted),
      stripeWebhookSecretSet: Boolean(row.stripeWebhookSecretEncrypted),
      nowPaymentsEnabled: row.nowPaymentsEnabled,
      nowPaymentsApiKeySet: Boolean(row.nowPaymentsApiKeyEncrypted),
      nowPaymentsIpnSecretSet: Boolean(row.nowPaymentsIpnSecretEncrypted),
      plisioEnabled: row.plisioEnabled,
      plisioApiKeySet: Boolean(row.plisioApiKeyEncrypted),
      updatedAt: row.updatedAt,
    };
  }

  /** A blank secret leaves the stored one alone rather than clearing it,
   * so saving the form after editing only the publishable key cannot
   * silently take payments down. */
  async update(dto: UpdatePaymentSettingsDto) {
    const row = await this.row();

    await this.prisma.paymentSettings.update({
      where: { id: row.id },
      data: {
        stripeEnabled: dto.stripeEnabled,
        stripePublishableKey: dto.stripePublishableKey,
        ...(dto.stripeSecretKey
          ? { stripeSecretKeyEncrypted: encryptCredentials({ v: dto.stripeSecretKey }) }
          : {}),
        ...(dto.stripeWebhookSecret
          ? { stripeWebhookSecretEncrypted: encryptCredentials({ v: dto.stripeWebhookSecret }) }
          : {}),
        nowPaymentsEnabled: dto.nowPaymentsEnabled,
        ...(dto.nowPaymentsApiKey
          ? { nowPaymentsApiKeyEncrypted: encryptCredentials({ v: dto.nowPaymentsApiKey }) }
          : {}),
        plisioEnabled: dto.plisioEnabled,
        ...(dto.plisioApiKey
          ? { plisioApiKeyEncrypted: encryptCredentials({ v: dto.plisioApiKey }) }
          : {}),
        ...(dto.nowPaymentsIpnSecret
          ? { nowPaymentsIpnSecretEncrypted: encryptCredentials({ v: dto.nowPaymentsIpnSecret }) }
          : {}),
      },
    });

    return this.get();
  }

  /** Decrypted Stripe credentials, or null when cards are switched off or
   * not configured. Null rather than a partially-filled object so a caller
   * cannot accidentally attempt a charge with a missing key. */
  async stripe(): Promise<StripeCredentials | null> {
    const row = await this.row();
    if (!row.stripeEnabled || !row.stripeSecretKeyEncrypted) return null;
    return {
      secretKey: decryptCredentials(row.stripeSecretKeyEncrypted).v,
      webhookSecret: row.stripeWebhookSecretEncrypted
        ? decryptCredentials(row.stripeWebhookSecretEncrypted).v
        : undefined,
      publishableKey: row.stripePublishableKey ?? undefined,
    };
  }

  async nowPayments(): Promise<NowPaymentsCredentials | null> {
    const row = await this.row();
    if (!row.nowPaymentsEnabled || !row.nowPaymentsApiKeyEncrypted) return null;
    return {
      apiKey: decryptCredentials(row.nowPaymentsApiKeyEncrypted).v,
      ipnSecret: row.nowPaymentsIpnSecretEncrypted
        ? decryptCredentials(row.nowPaymentsIpnSecretEncrypted).v
        : undefined,
    };
  }

  /** Which providers a customer can actually pay with right now.
   *
   * The app should only offer buttons that can work: a customer pressing
   * "Card" and getting an error because nothing was ever configured is the
   * exact failure this replaces.
   */
  async availableProviders(): Promise<("STRIPE" | "NOWPAYMENTS")[]> {
    const row = await this.row();
    const available: ("STRIPE" | "NOWPAYMENTS")[] = [];
    if (row.stripeEnabled && row.stripeSecretKeyEncrypted) available.push("STRIPE");
    if (row.nowPaymentsEnabled && row.nowPaymentsApiKeyEncrypted) available.push("NOWPAYMENTS");
    return available;
  }

  /** Null when disabled or unconfigured, so callers fail closed rather
   * than attempting a request with an empty key. */
  async plisio(): Promise<PlisioCredentials | null> {
    const row = await this.row();
    if (!row.plisioEnabled || !row.plisioApiKeyEncrypted) return null;
    return { apiKey: decryptCredentials(row.plisioApiKeyEncrypted).v };
  }
}
