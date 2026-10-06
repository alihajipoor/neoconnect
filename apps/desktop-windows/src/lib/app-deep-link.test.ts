import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A verify-email link opened while somebody is signed in.
 *
 * The handler verified the token and then switched to the sign-in screen
 * unconditionally -- over a session nothing had ended, with the tunnel
 * still up and the Dashboard's polls stopped. App.tsx needs a Tauri
 * runtime, so the order is pinned from source, as the Dashboard's wiring
 * is in connection-evidence.test.ts. */
describe("the verify-email deep link", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("async function handleDeepLinkUrl(");
  const handler = app.slice(start, app.indexOf("\n  }\n", start));

  it("leaves a signed-in app where it is", () => {
    expect(start).toBeGreaterThan(0);
    const verified = handler.indexOf("await verifyEmailByToken(token)");
    const guard = handler.indexOf("if (await getTokens().catch(() => null)) return;");
    const toLogin = handler.indexOf('setScreen("login")');
    expect(verified).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(verified);
    expect(guard).toBeLessThan(toLogin);
  });
});
