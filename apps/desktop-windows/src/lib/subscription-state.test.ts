import { describe, expect, it } from "vitest";
import { endedNotice, type SubscriptionStatus } from "./subscription-state";

describe("endedNotice", () => {
  it("says nothing while the plan still works", () => {
    expect(endedNotice("ACTIVE", false)).toBeNull();
  });

  it("stays silent for the states the dashboard never shows", () => {
    // PENDING and CANCELLED are filtered out before the dashboard sees
    // them; those customers get the "no subscription" card and its own
    // route to a plan, which this must not duplicate.
    expect(endedNotice("PENDING", false)).toBeNull();
    expect(endedNotice("CANCELLED", false)).toBeNull();
  });

  it("offers a way to renew when the data runs out", () => {
    const notice = endedNotice("SUSPENDED", false);
    expect(notice).toEqual({
      titleKey: "dash.outOfData",
      bodyKey: "dash.renewHint",
      showPlansButton: true,
    });
  });

  it("offers a way to renew when the term ends", () => {
    const notice = endedNotice("EXPIRED", false);
    expect(notice?.titleKey).toBe("dash.planExpired");
    expect(notice?.showPlansButton).toBe(true);
  });

  it("never offers to sell inside a store build", () => {
    // The failure this guards against gets an app removed, not merely
    // rejected, so it is asserted for both ended states rather than one.
    for (const status of ["SUSPENDED", "EXPIRED"] as SubscriptionStatus[]) {
      const notice = endedNotice(status, true);
      expect(notice?.showPlansButton).toBe(false);
      expect(notice?.bodyKey).toBe("dash.renewStore");
    }
  });

  it("still explains the state in a store build", () => {
    // Hiding the button alone would leave a customer staring at a plan
    // that does not work with nothing telling them why.
    expect(endedNotice("SUSPENDED", true)).not.toBeNull();
  });
});
