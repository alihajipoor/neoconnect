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

describe("NowPaymentsProvider.createPayment", () => {
  const settings = { nowPayments: jest.fn().mockResolvedValue({ apiKey: "k", ipnSecret: IPN_SECRET }) };

  function build(publicApiUrl?: string) {
    const config = { get: jest.fn((key: string) => (key === "publicApiUrl" ? publicApiUrl : undefined)) };
    return new NowPaymentsProvider(config as never, settings as never);
  }

  function mockFetch() {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ payment_id: 1, pay_address: "T...", pay_amount: 10, pay_currency: "usdttrc20" }),
    });
    global.fetch = fetchMock as never;
    return fetchMock;
  }

  function sentBody(fetchMock: jest.Mock) {
    return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
  }

  // The regression this guards: without ipn_callback_url, a customer can
  // pay and no callback ever arrives, so the subscription never activates
  // and nothing anywhere reports an error.
  it("tells NowPayments where to send the IPN callback", async () => {
    const fetchMock = mockFetch();
    await build("https://connect.neoxify.com/api").createPayment(10, "txn-1");
    expect(sentBody(fetchMock).ipn_callback_url).toBe(
      "https://connect.neoxify.com/api/billing/webhooks/nowpayments",
    );
  });

  it("does not double up the slash when the base URL has a trailing one", async () => {
    const fetchMock = mockFetch();
    await build("https://connect.neoxify.com/api/").createPayment(10, "txn-1");
    expect(sentBody(fetchMock).ipn_callback_url).toBe(
      "https://connect.neoxify.com/api/billing/webhooks/nowpayments",
    );
  });

  it("omits the callback entirely when no public URL is configured", async () => {
    const fetchMock = mockFetch();
    await build(undefined).createPayment(10, "txn-1");
    expect(sentBody(fetchMock)).not.toHaveProperty("ipn_callback_url");
  });

  // Seen in production on the $10 plan: NowPayments rejected the payment
  // because the converted crypto amount fell under its minimum, and the
  // bare Error surfaced to the customer as "Internal server error" with
  // nothing to act on.
  it("explains a below-minimum price instead of failing as a server error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "AMOUNT_MINIMAL_ERROR", message: "Crypto amount 9.98 is less than minimal" }),
        ),
    }) as never;

    await expect(build("https://x/api").createPayment(10, "txn-1")).rejects.toMatchObject({
      status: 400,
      response: { message: expect.stringContaining("minimum") },
    });
  });

  it("reports an unexpected provider failure as unavailable, not as a bad request", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("upstream exploded"),
    }) as never;

    // 503 rather than 400: the customer did nothing wrong, and the
    // difference decides whether "try again" is sensible advice.
    await expect(build("https://x/api").createPayment(10, "txn-1")).rejects.toMatchObject({ status: 503 });
  });
});

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
