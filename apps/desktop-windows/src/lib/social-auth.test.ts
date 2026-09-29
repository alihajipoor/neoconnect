import { afterEach, describe, expect, it, vi } from "vitest";

import { appleSignInAvailable, readCallback, socialSignInAvailable } from "./social-auth";

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

/** Where the buttons are offered at all.
 *
 * The web portal reuses these same screens from
 * apps/desktop-windows/src, on ordinary shared hosting. Every route back
 * from a provider ends at `neoconnect://social-callback`, and nothing in
 * a browser can claim a custom scheme — so offering the buttons there
 * would open a provider, succeed, and strand the customer on a URL their
 * browser cannot open.
 *
 * The portal is the reason this guard exists, and it is invisible from
 * the desktop and mobile apps: a change here typechecks and passes their
 * tests while breaking a live commerce surface. That is what these pin.
 */
describe("where provider sign-in is offered", () => {
  const setRuntime = (present: boolean) => {
    const win = present ? { __TAURI_INTERNALS__: {} } : {};
    vi.stubGlobal("window", win);
  };

  afterEach(() => vi.unstubAllGlobals());

  it("is not offered without the Tauri runtime", () => {
    // i.e. the web portal.
    setRuntime(false);
    expect(socialSignInAvailable()).toBe(false);
  });

  it("is offered inside the app", () => {
    setRuntime(true);
    expect(socialSignInAvailable()).toBe(true);
  });

  it("never offers Apple without the runtime, whatever the user agent says", () => {
    // The portal opened on an iPhone is still the portal: iOS is true
    // and there is no native sheet to open. Checking the platform alone
    // would put a dead button in front of exactly those customers.
    setRuntime(false);
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5 });
    expect(appleSignInAvailable()).toBe(false);
  });

  it("offers Apple on iOS inside the app", () => {
    setRuntime(true);
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5 });
    expect(appleSignInAvailable()).toBe(true);
  });

  it("does not offer Apple on Android inside the app", () => {
    setRuntime(true);
    vi.stubGlobal("navigator", { userAgent: "Android", maxTouchPoints: 5 });
    expect(appleSignInAvailable()).toBe(false);
  });
});
