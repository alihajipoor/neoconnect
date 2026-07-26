import { PaymentSettingsService } from "../../payment-settings/payment-settings.service";
import { Injectable } from "@nestjs/common";
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

  /** Creates a crypto payment (USDT/TRC20) via NowPayments' API -- a
   * pay-to address and amount the app/website can render directly (QR
   * code, copy button), not a hosted invoice page redirect. Iranian
   * customers who can't use international cards are the reason this
   * provider exists at all -- see project scope notes. */
  async createPayment(amountUsd: number, orderId: string): Promise<NowPaymentsPayment> {
    const res = await fetch(`${NOWPAYMENTS_API_BASE}/payment`, {
      method: "POST",
      headers: { "x-api-key": (await this.requireApiKey()), "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: amountUsd,
        price_currency: "usd",
        pay_currency: "usdttrc20",
        order_id: orderId,
      }),
    });
    if (!res.ok) {
      throw new Error(`NowPayments createPayment failed: ${res.status} ${await res.text()}`);
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
