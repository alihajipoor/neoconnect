import { liveCredentialWhere } from "./live-credentials";

/** What the 60 s re-assert puts back on a node. A credential whose own
 * status is ACTIVE is not enough: provisionAll used to mint ACTIVE rows on
 * PENDING, CANCELLED, EXPIRED and SUSPENDED subscriptions, and the
 * re-assert then kept every one of them on its node, every minute. */
describe("liveCredentialWhere", () => {
  it("counts only credentials of ACTIVE subscriptions as live", () => {
    expect(liveCredentialWhere(new Date(0))).toMatchObject({
      status: "ACTIVE",
      subscription: { status: "ACTIVE" },
    });
  });
});
