import { describe, expect, it } from "vitest";

import { readCallback } from "./social-auth";

/** What comes back at the end of a provider sign-in.
 *
 * The distinction these pin down is the one that is easy to get wrong
 * and unpleasant when it is: a customer who pressed Cancel has not had
 * anything go wrong, and must not be shown an error. Every other
 * outcome has to be loud, because a silent failure here looks to the
 * customer like a button that does nothing.
 */
describe("readCallback", () => {
  it("returns the handoff code on success", () => {
    expect(readCallback("neoconnect://social-callback?handoff=abc123")).toEqual({
      kind: "handoff",
      code: "abc123",
    });
  });

  it("treats a cancellation as neither a result nor an error", () => {
    // null, not a throw. The customer knows what they just did.
    expect(readCallback("neoconnect://social-callback?error=cancelled")).toBeNull();
  });

  it("surfaces a message the server wrote for this customer", () => {
    // resolveCustomer refuses for reasons somebody can act on -- an
    // existing unverified account on the same address, a provider
    // account with no email. Those travel; a generic failure does not.
    const url =
      "neoconnect://social-callback?error=rejected&detail=" +
      encodeURIComponent("An account with this email already exists.");
    expect(() => readCallback(url)).toThrow("An account with this email already exists.");
  });

  it("falls back to a generic message when the server sent no detail", () => {
    expect(() => readCallback("neoconnect://social-callback?error=failed")).toThrow(
      /did not work/,
    );
  });

  it("says so when the provider is not configured at all", () => {
    // Distinct from a failure: nothing the customer does fixes it, and
    // the other buttons still work. This is also the case that used to
    // render Nest's JSON error page inside the sign-in browser, whose
    // only exit is a dismissal the app then reported as nothing at all.
    expect(() => readCallback("neoconnect://social-callback?error=unavailable")).toThrow(
      /not available right now/,
    );
  });

  it("refuses a callback that carries nothing at all", () => {
    // Neither a handoff nor an error. Something is wrong and the button
    // must not silently do nothing.
    expect(() => readCallback("neoconnect://social-callback")).toThrow(/did not work/);
  });

  it("does not mistake an empty handoff for a session", () => {
    expect(() => readCallback("neoconnect://social-callback?handoff=")).toThrow(/did not work/);
  });
});
