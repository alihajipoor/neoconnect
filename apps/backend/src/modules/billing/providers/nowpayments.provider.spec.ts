import { createHmac } from "node:crypto";
import { NowPaymentsProvider } from "./nowpayments.provider";

const IPN_SECRET = "test-ipn-secret";

/** Signs the way NowPayments documents it: HMAC-SHA512 over the JSON body
 * with keys sorted alphabetically at every level. Written independently of
 * the provider's own sorting so the test would catch the provider changing
 * its mind about key order, rather than agreeing with itself. */
function signLikeNowPayments(body: Record<string, unknown>): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHmac("sha512", IPN_SECRET).update(JSON.stringify(sortDeep(body))).digest("hex");
}

describe("NowPaymentsProvider.verifyIpnSignature", () => {
  let provider: NowPaymentsProvider;

  beforeEach(() => {
    const paymentSettings = { nowPayments: jest.fn().mockResolvedValue({ apiKey: "k", ipnSecret: IPN_SECRET }) };
    const config = { get: jest.fn() };
    provider = new NowPaymentsProvider(config as never, paymentSettings as never);
  });

  // Deliberately declared out of alphabetical order: a real IPN arrives in
  // whatever order NowPayments serialises it, so this is what proves the
  // deep sort is doing its job rather than the payload happening to match.
  const body = {
    payment_status: "finished",
    order_id: "txn-1",
    price_amount: 12.5,
    outcome: { currency: "usdt", amount: 12.4 },
    actually_paid: 12.5,
  };

  it("accepts a correctly signed payload", async () => {
    await expect(provider.verifyIpnSignature(body, signLikeNowPayments(body))).resolves.toBe(true);
  });

  it("rejects a payload whose contents were altered after signing", async () => {
    const signature = signLikeNowPayments(body);
    const tampered = { ...body, price_amount: 9999 };
    await expect(provider.verifyIpnSignature(tampered, signature)).resolves.toBe(false);
  });

  it("rejects a signature of the wrong length instead of throwing", async () => {
    // timingSafeEqual throws on mismatched lengths, so a truncated or
    // empty signature has to be handled before it reaches the comparison
    // -- otherwise a forged header turns a rejection into a 500.
    await expect(provider.verifyIpnSignature(body, "")).resolves.toBe(false);
    await expect(provider.verifyIpnSignature(body, "abc123")).resolves.toBe(false);
  });

  it("rejects a well-formed signature made with the wrong secret", async () => {
    const wrong = createHmac("sha512", "not-the-secret").update(JSON.stringify(body)).digest("hex");
    await expect(provider.verifyIpnSignature(body, wrong)).resolves.toBe(false);
  });
});
