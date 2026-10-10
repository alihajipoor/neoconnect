import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every screen that waits on Neoxify says so past eight seconds.
 *
 * Reads wait up to twenty seconds an address now, and a write first asks
 * who answers, so a screen can sit on its spinner for half a minute on a
 * network where only a slow route answers. still-trying.test.ts covers the
 * hook; this pins where it is shown. Read from the source because these
 * components have no test harness of their own: the line could be deleted
 * from any of them and every other test would still pass. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The note as the screens that render it themselves write it. */
const NOTE = '{t("common.stillTrying")}';

describe("the screens that render the note themselves", () => {
  it("say it under a sign-in and a sign-up", () => {
    for (const path of ["../screens/Login.tsx", "../screens/Register.tsx"]) {
      const text = source(path);
      expect(text, path).toContain("const pendingLong = useStillTrying(pending);");
      expect(text, path).toContain(`{pendingLong ? <p className="text-center text-xs text-muted-foreground">${NOTE}</p> : null}`);
    }
  });

  it("say it under the server list's load and its switch", () => {
    const text = source("../components/LocationPicker.tsx");
    expect(text).toContain("const loadingLong = useStillTrying(loading);");
    expect(text).toContain("const switchingLong = useStillTrying(switchingId !== null);");
    expect(text).toContain(`{loadingLong ? <p className="text-xs">${NOTE}</p> : null}`);
    expect(text).toContain(`{switchingLong ? <p className="px-2 pt-2 text-xs text-muted-foreground">${NOTE}</p> : null}`);
  });

  it("say it under the dashboard's load", () => {
    const text = source("../screens/Dashboard.tsx");
    expect(text).toContain("const loadingLong = useStillTrying(loading);");
    expect(text).toMatch(/\{loadingLong \? \(\s*<p className="max-w-xs px-6 text-center text-xs text-muted-foreground">\{t\("common\.stillTrying"\)\}<\/p>/);
  });
});

describe("the screens that use the shared line", () => {
  it("is the hook and the words, and nothing else", () => {
    const text = source("../components/StillTrying.tsx");
    expect(text).toContain("const long = useStillTrying(waiting);");
    expect(text).toContain(NOTE);
  });

  /** Each wait that used to give up at eight seconds and now may not:
   * confirming an email code, a password reset, a voucher, the plan list
   * and a payment's start, the store's plans, and support. */
  it.each([
    ["../screens/VerifyEmail.tsx", ["<StillTrying waiting={pending || resending} />"]],
    ["../screens/ForgotPassword.tsx", ["<StillTrying waiting={pending} />"]],
    ["../components/RedeemVoucher.tsx", ["<StillTrying waiting={busy} />"]],
    [
      "../screens/Plans.tsx",
      ['<StillTrying waiting={error === null} className="mt-2 text-left" />', '<StillTrying waiting={stage.name === "starting"} />'],
    ],
    ["../screens/StorePlans.tsx", ["<StillTrying waiting />"]],
    [
      "../screens/Support.tsx",
      ["<StillTrying waiting={!error} />", '<StillTrying waiting={busy} className="text-left" />', "<StillTrying waiting />", "<StillTrying waiting={busy} />"],
    ],
  ])("%s says it", (path, uses) => {
    const text = source(path);
    for (const use of uses) expect(text, use).toContain(use);
  });
});
