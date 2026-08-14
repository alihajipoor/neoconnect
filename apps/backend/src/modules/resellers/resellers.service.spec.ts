import { ResellersService } from "./resellers.service";

/**
 * The activation link a reseller's customer receives.
 *
 * This exists because the link was broken in production and nothing
 * caught it. The service emitted the short form, https://neoxify.net/r/
 * CODE, whose redirect is defined in website/.htaccess -- a file only
 * Apache reads. neoxify.net is served by nginx, which does not read it,
 * so every activation email carried a link that landed on the marketing
 * homepage with no code and no error. Measured 2026-08-14: GET
 * /r/ABCD2345 returns 200 and the homepage.
 *
 * So the assertion here is deliberately about the *shape of the URL* and
 * not about "some link is present". A test that only checked for a
 * non-empty string would have passed throughout the entire outage.
 */
describe("ResellersService activation links", () => {
  /** Captures what would have been handed to the mail transport. */
  function build(websiteUrl?: string) {
    const sendMail = jest.fn().mockResolvedValue(true);
    const service = new ResellersService(
      {} as any,
      { sendMail } as any,
      { get: jest.fn().mockResolvedValue(websiteUrl ? { websiteUrl } : {}) } as any,
      { get: jest.fn().mockReturnValue(undefined) } as any,
    );
    return { service, sendMail };
  }

  it("sends a link the live host actually resolves", async () => {
    const { service, sendMail } = build();

    await service["sendVoucherEmail"]("ABCD2345EFGH", "Pro", "buyer@example.com", null);

    const sent = sendMail.mock.calls[0][0];
    expect(sent.text).toContain("https://neoxify.net/account/?voucher=ABCD2345EFGH");
  });

  it("does not emit the /r/ short form while no host rewrites it", async () => {
    // Guards the regression directly. Restoring /r/CODE means installing
    // website/nginx-website.conf.example on the web host first -- at
    // which point this expectation is the thing to revisit, deliberately,
    // rather than a link quietly breaking again.
    const { service, sendMail } = build();

    await service["sendVoucherEmail"]("ABCD2345EFGH", "Pro", "buyer@example.com", null);

    const sent = sendMail.mock.calls[0][0];
    expect(sent.text).not.toContain("/r/ABCD2345EFGH");
    expect(sent.html).not.toContain("/r/ABCD2345EFGH");
  });

  it("honours a configured website URL and strips its trailing slash", async () => {
    // A trailing slash left on the configured value would produce
    // //account/, which is a protocol-relative path in a browser, not a
    // path on this site.
    const { service, sendMail } = build("https://staging.neoxify.net/");

    await service["sendVoucherEmail"]("ABCD2345EFGH", "Pro", "buyer@example.com", null);

    const sent = sendMail.mock.calls[0][0];
    expect(sent.text).toContain("https://staging.neoxify.net/account/?voucher=ABCD2345EFGH");
  });

  it("percent-encodes a code rather than letting it break out of the query", async () => {
    // Codes are minted from A-Z2-9 so this cannot happen today. It is
    // asserted because the value is interpolated straight into a URL, and
    // the day something else is passed here the failure would be silent.
    const { service, sendMail } = build();

    await service["sendVoucherEmail"]("AB&CD=EF", "Pro", "buyer@example.com", null);

    const sent = sendMail.mock.calls[0][0];
    expect(sent.text).toContain("?voucher=AB%26CD%3DEF");
  });
});
