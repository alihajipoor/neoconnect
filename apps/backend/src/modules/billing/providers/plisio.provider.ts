import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentSettingsService } from "../../payment-settings/payment-settings.service";

const PLISIO_API_BASE = "https://api.plisio.net/api/v1";

/**
 * Plisio, alongside NowPayments rather than replacing it.
 *
 * Added because NowPayments enforces a per-currency minimum that sits
 * above the cheapest plan -- a $3.99 Starter could not be paid in crypto
 * at all, which for the Iranian audience means it could not be paid.
 *
 * Shaped differently from NowPayments in one way that reaches the UI:
 * Plisio returns a hosted `invoice_url` rather than a pay-to address and
 * amount. That makes it behave like Stripe (send the customer to a page)
 * and NOT like NowPayments (render an address to send coins to), which
 * the Plans screen has to branch on correctly or the customer gets an
 * empty panel.
 */
export interface PlisioInvoice {
  /** Plisio's own id for the invoice; stored as the provider reference. */
  txnId: string;
  /** Hosted payment page. The customer is sent here. */
  invoiceUrl: string;
  /** What Plisio expects, as a string, in the invoice's currency. */
  totalSum: string;
}

/** Every status Plisio's own SDK enumerates (plisio_enums.OperationStatus). */
export type PlisioStatus =
  | "new"
  | "pending"
  | "expired"
  | "completed"
  | "mismatch"
  | "error"
  | "cancelled"
  | "cancelled_duplicate";

@Injectable()
export class PlisioProvider {
  private readonly logger = new Logger(PlisioProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly paymentSettings: PaymentSettingsService,
  ) {}

  /** Panel first, environment second -- same precedence as NowPayments,
   * so a deployed box keeps working before anyone retypes the key. */
  private async requireApiKey(): Promise<string> {
    const configured = await this.paymentSettings.plisio();
    const apiKey = configured?.apiKey ?? this.config.get<string>("billing.plisioApiKey");
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Crypto payments are not configured. Add a Plisio API key in Settings > Payments.",
      );
    }
    return apiKey;
  }

  /**
   * Create a hosted invoice.
   *
   * GET, not POST -- Plisio's API takes everything as query parameters,
   * including the key. That is their design, not a mistake here.
   *
   * `order_number` must be unique per order or Plisio rejects it; we
   * pass the PaymentTransaction id, which already is.
   */
  async createInvoice(params: {
    orderNumber: string;
    orderName: string;
    amountUsd: string;
    email?: string;
    callbackUrl: string;
    successUrl?: string;
    failUrl?: string;
    expireMinutes?: number;
  }): Promise<PlisioInvoice> {
    const query = new URLSearchParams({
      api_key: await this.requireApiKey(),
      order_number: params.orderNumber,
      order_name: params.orderName,
      source_currency: "USD",
      source_amount: params.amountUsd,
      // json=true is REQUIRED for anything that is not PHP. Without it
      // Plisio posts PHP-serialised data to the callback, which nothing
      // here can parse -- and the failure looks like "payments silently
      // never confirm" rather than an error.
      callback_url: `${params.callbackUrl}${params.callbackUrl.includes("?") ? "&" : "?"}json=true`,
      ...(params.email ? { email: params.email } : {}),
      ...(params.successUrl ? { success_invoice_url: params.successUrl } : {}),
      ...(params.failUrl ? { fail_invoice_url: params.failUrl } : {}),
      ...(params.expireMinutes ? { expire_min: String(params.expireMinutes) } : {}),
    });

    const res = await fetch(`${PLISIO_API_BASE}/invoices/new?${query.toString()}`);
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      data?: { txn_id?: string; invoice_url?: string; invoice_total_sum?: string; message?: string };
    } | null;

    if (!res.ok || body?.status === "error" || !body?.data?.invoice_url) {
      const message = body?.data?.message;
      // Logged, not surfaced: Plisio's messages are aimed at the
      // integrator and can name the merchant account.
      this.logger.error(`Plisio invoice creation failed (${res.status}): ${message ?? "no message"}`);

      // The one case worth telling the customer precisely, because it is
      // actionable by them rather than by us.
      if (typeof message === "string" && /minimum|too small|less than/i.test(message)) {
        throw new BadRequestException(
          "This amount is below the minimum we can accept in crypto. Please pay by card, or choose a larger plan.",
        );
      }
      throw new ServiceUnavailableException(
        "Crypto payments are temporarily unavailable. Please try again shortly, or pay by card.",
      );
    }

    return {
      txnId: String(body.data.txn_id ?? params.orderNumber),
      invoiceUrl: body.data.invoice_url,
      totalSum: String(body.data.invoice_total_sum ?? ""),
    };
  }

  /**
   * Verify a callback really came from Plisio.
   *
   * Transcribed from Plisio's own Node SDK (Plisio/plisio-sdk-nodejs,
   * verifyCallbackData) rather than inferred, because every step is
   * load-bearing and two of them are not guessable:
   *
   *   1. remove verify_hash
   *   2. sort the remaining keys alphabetically
   *   3. coerce expire_utc to a String
   *   4. decodeURIComponent tx_urls
   *   5. JSON.stringify
   *   6. HMAC-SHA1 with the API KEY (not a separate IPN secret), hex
   *
   * Steps 3 and 4 are the ones that would silently break this: a numeric
   * expire_utc or an encoded tx_urls produces a different string and
   * therefore a different hash, so every genuine callback would be
   * rejected and no payment would ever confirm.
   *
   * Getting this wrong the other way is worse -- accepting a forged
   * "completed" is somebody minting free subscriptions by POSTing to the
   * webhook -- which is why this is transcribed and not approximated.
   */
  async verifyCallback(payload: Record<string, unknown>): Promise<boolean> {
    const provided = payload.verify_hash;
    if (typeof provided !== "string" || provided.length === 0) return false;

    // Copied rather than mutated: the caller still needs the payload,
    // and Plisio's SDK deletes the key in place because it owns the
    // object. Deleting from ours would strip the field before the
    // handler could log it.
    const rest: Record<string, unknown> = { ...payload };
    delete rest.verify_hash;

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(rest).sort()) sorted[key] = rest[key];

    if ("expire_utc" in sorted) sorted.expire_utc = String(sorted.expire_utc);
    if ("tx_urls" in sorted) sorted.tx_urls = decodeURIComponent(String(sorted.tx_urls));

    const expected = createHmac("sha1", await this.requireApiKey())
      .update(JSON.stringify(sorted))
      .digest("hex");

    // Length-checked first: timingSafeEqual throws on a mismatch rather
    // than returning false.
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * What a status means for the subscription.
   *
   * `mismatch` is deliberately NOT paid. It means the amount received
   * did not match the invoice -- Plisio applies the underpayment
   * tolerance configured on the site before ever reporting it, so a
   * mismatch that reaches us is outside that tolerance. Activating on it
   * would hand out a plan for whatever the customer chose to send.
   * Treated as needing a human, not as a failure either, because their
   * money did arrive.
   */
  classify(status: string): "paid" | "pending" | "failed" | "review" {
    switch (status as PlisioStatus) {
      case "completed":
        return "paid";
      case "new":
      case "pending":
        return "pending";
      case "mismatch":
        return "review";
      case "expired":
      case "error":
      case "cancelled":
      case "cancelled_duplicate":
        return "failed";
      default:
        // An unknown status must not be read as success. Plisio can add
        // one at any time and the safe default is "keep waiting".
        this.logger.warn(`Unknown Plisio status "${status}" -- treating as pending`);
        return "pending";
    }
  }
}
