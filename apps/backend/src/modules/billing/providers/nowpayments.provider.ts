import { PaymentSettingsService } from "../../payment-settings/payment-settings.service";
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";

const NOWPAYMENTS_API_BASE = "https://api.nowpayments.io/v1";

export interface NowPaymentsPayment {
  paymentId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
}

@Injectable()
export class NowPaymentsProvider {
  private readonly logger = new Logger(NowPaymentsProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly paymentSettings: PaymentSettingsService,
  ) {}

  /** Panel first, environment second -- the env fallback keeps the
   * already-deployed configuration working rather than taking crypto
   * payments down until someone retypes the key into the panel. */
  private async requireApiKey(): Promise<string> {
    const configured = await this.paymentSettings.nowPayments();
    const apiKey = configured?.apiKey ?? this.config.get<string>("billing.nowpaymentsApiKey");
    if (!apiKey) {
      throw new Error("NowPayments is not configured -- add an API key in Settings > Payments");
    }
    return apiKey;
  }

  /** Where NowPayments should post payment status callbacks.
   *
   * Derived from the same PUBLIC_API_URL that already builds the links in
   * verification emails, so there is one public address to configure per
   * deployment instead of two that can silently disagree. Returns
   * undefined when unset -- a local dev box has no address NowPayments
   * could reach anyway, and sending a localhost URL would be worse than
   * sending none. */
  private ipnCallbackUrl(): string | undefined {
    const base = this.config.get<string>("publicApiUrl");
    if (!base) return undefined;
    return `${base.replace(/\/$/, "")}/billing/webhooks/nowpayments`;
  }

  /** Creates a crypto payment (USDT/TRC20) via NowPayments' API -- a
   * pay-to address and amount the app/website can render directly (QR
   * code, copy button), not a hosted invoice page redirect. Iranian
   * customers who can't use international cards are the reason this
   * provider exists at all -- see project scope notes. */
  async createPayment(amountUsd: number, orderId: string): Promise<NowPaymentsPayment> {
    const callbackUrl = this.ipnCallbackUrl();
    const res = await fetch(`${NOWPAYMENTS_API_BASE}/payment`, {
      method: "POST",
      headers: { "x-api-key": (await this.requireApiKey()), "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: amountUsd,
        price_currency: "usd",
        pay_currency: "usdttrc20",
        order_id: orderId,
        // Sent per payment rather than relying on the IPN URL configured
        // in the NowPayments dashboard. Whether that dashboard setting is
        // applied as a fallback for API-created payments is not something
        // we can confirm without a real crypto payment, and the failure
        // mode if it isn't is the worst one available: the customer pays,
        // no callback ever arrives, and the subscription silently never
        // activates. Naming it explicitly removes the question.
        ...(callbackUrl ? { ipn_callback_url: callbackUrl } : {}),
      }),
    });
    if (!res.ok) {
      const raw = await res.text();
      // The customer-facing messages below deliberately drop the
      // provider's wording, so keep the real response here or the only
      // record of why a payment failed is gone.
      this.logger.error(`NowPayments createPayment failed: ${res.status} ${raw}`);

      // NowPayments enforces a per-currency minimum that sits above some
      // plan prices, and its rejection is a normal business outcome, not
      // a server fault. Left as a bare Error it surfaced to customers as
      // "Internal server error" with no hint that the answer is simply
      // "pay by card or pick a bigger plan" -- observed in production on
      // the $10 plan, where the crypto equivalent lands just under the
      // limit once conversion is applied.
      let code: string | undefined;
      try {
        code = (JSON.parse(raw) as { code?: string }).code;
      } catch {
        // Not JSON -- fall through to the generic message below.
      }
      if (code === "AMOUNT_MINIMAL_ERROR") {
        throw new BadRequestException(
          "This plan costs less than the minimum we can accept in crypto. Please pay by card, or choose a larger plan.",
        );
      }

      throw new ServiceUnavailableException(
        "Crypto payments are temporarily unavailable. Please try again shortly, or pay by card.",
      );
    }
    const body = (await res.json()) as {
      payment_id: number | string;
      pay_address: string;
      pay_amount: number;
      pay_currency: string;
    };
    return {
      paymentId: String(body.payment_id),
      payAddress: body.pay_address,
      payAmount: body.pay_amount,
      payCurrency: body.pay_currency,
    };
  }

  async getPaymentStatus(paymentId: string): Promise<{ paymentStatus: string }> {
    const res = await fetch(`${NOWPAYMENTS_API_BASE}/payment/${paymentId}`, {
      headers: { "x-api-key": (await this.requireApiKey()) },
    });
    if (!res.ok) {
      throw new Error(`NowPayments getPaymentStatus failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { payment_status: string };
    return { paymentStatus: body.payment_status };
  }

  /** NowPayments signs IPN callbacks as HMAC-SHA512 over the JSON body
   * with keys sorted alphabetically at every nesting level -- computed
   * from the parsed payload, unlike Stripe's raw-byte signature, since
   * that's what NowPayments' own IPN spec defines. */
  async verifyIpnSignature(body: unknown, signature: string): Promise<boolean> {
    const configured = await this.paymentSettings.nowPayments();
    const ipnSecret = configured?.ipnSecret ?? this.config.get<string>("billing.nowpaymentsIpnSecret");
    if (!ipnSecret) {
      throw new Error("No NowPayments IPN secret configured -- add one in Settings > Payments");
    }
    const sorted = sortKeysDeep(body);
    const expected = createHmac("sha512", ipnSecret).update(JSON.stringify(sorted)).digest("hex");

    // Constant-time comparison: `===` on strings returns as soon as two
    // bytes differ, which leaks how much of a forged signature was
    // correct and makes the rest guessable one byte at a time. This
    // guards the endpoint that decides whether a payment is real, so it
    // is worth the care. timingSafeEqual throws on a length mismatch,
    // hence the explicit check -- and length is not a secret here, since
    // a SHA-512 hex digest is always 128 characters.
    const expectedBuf = Buffer.from(expected, "utf8");
    const givenBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== givenBuf.length) return false;
    return timingSafeEqual(expectedBuf, givenBuf);
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
