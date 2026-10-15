import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "./i18n";

/** The relay of last resort's screens, as wired (docs/relay-last-resort.md,
 * section 8): the strings the owner approved, word for word; the calm-UI
 * rules; and where each piece is mounted. Read from the sources, as the
 * other wiring tests here are. */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const backupRoute = read("../components/BackupRoute.tsx");
const recovery = read("../components/AccountRecovery.tsx");
const desktopApp = read("../App.tsx");
const mobileApp = read("../../../mobile/src/App.tsx");
const desktopDashboard = read("../screens/Dashboard.tsx");
const mobileDashboard = read("../../../mobile/src/screens/Dashboard.tsx");
const { en, fa } = DICTIONARIES;

/** The source of one exported component, to its closing brace. */
function component(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("the approved strings", () => {
  it("say what the spec says, in both languages", () => {
    expect(en["relay.consentBody"]).toBe(
      "Neoxify can't be reached the usual way on this network. Use our backup server inside Iran? Your data stays encrypted; the server's host can see that this device connected, not what it sent.",
    );
    expect(fa["relay.consentBody"]).toBe(
      "در این شبکه دسترسی به نئوکسیفای از راه معمول ممکن نیست. از سرور پشتیبان ما در داخل ایران استفاده شود؟ اطلاعات شما رمزگذاری‌شده می‌ماند؛ میزبان این سرور فقط می‌بیند که این دستگاه وصل شده، نه آنچه فرستاده شده.",
    );
    expect(en["relay.chip"]).toBe("App data: backup route");
    expect(fa["relay.chip"]).toBe("داده‌های برنامه: مسیر پشتیبان");
    expect(en["relay.disconnect"]).toBe("Disconnect to use the backup route.");
    expect(fa["relay.disconnect"]).toBe("برای استفاده از مسیر پشتیبان، اتصال را قطع کنید.");
    expect(en["relay.region"]).toBe("The backup route is only for connections from inside Iran.");
    expect(fa["relay.region"]).toBe("مسیر پشتیبان فقط برای اتصال از داخل ایران است.");
    expect(en["relay.blocked"]).toBe("Neoxify's usual routes are blocked on this network.");
    expect(fa["relay.blocked"]).toBe("راه‌های معمول نئوکسیفای در این شبکه مسدود است.");
    expect(en["verify.reminder"]).toBe(
      "Confirm your email to unlock all plans and payments. Your current plan is not affected.",
    );
    expect(en["recovery.save"]).toBe(
      "Save this recovery code somewhere safe. If you can't open your email, it is the only way to reset your password. It is shown only once.",
    );
    expect(en["forgot.relayHint"]).toBe(
      "The reset code is sent by email. If you can't open your email, use your recovery code.",
    );
  });

  it("use the app's own word for a voucher", () => {
    expect(fa["voucher.title"]).toContain("کد هدیه");
    expect(fa["relay.created"]).toContain("کد هدیه");
    expect(fa["relay.created"]).not.toContain("کوپن");
  });

  it("never call a recovery code a reset code, or the other way about", () => {
    for (const key of Object.keys(fa) as (keyof typeof fa)[]) {
      if (key.startsWith("recovery.")) expect([key, fa[key].includes("بازنشانی") && !fa[key].includes("رمز")]).toEqual([key, false]);
    }
    expect(fa["forgot.relayHint"]).toContain("کد بازنشانی");
    expect(fa["forgot.relayHint"]).toContain("کد بازیابی");
    expect(fa["recovery.title"]).toContain("کد بازیابی");
    expect(fa["recovery.title"]).not.toContain("بازنشانی");
  });

  it("name a national intranet only in the string kept for a declared one", () => {
    const naming = (Object.keys(en) as (keyof typeof en)[]).filter((key) => /intranet/i.test(en[key]));
    expect(naming.sort()).toEqual(
      ["relay.intranet", "relay.intranetLimits", "relay.otherPlansAbroad", "setpw.hint"].sort(),
    );
  });

  it("mention the backup server having failed only in the string for a relay that was dialled", () => {
    const tried = (Object.keys(en) as (keyof typeof en)[]).filter((key) => /including the backup server/i.test(en[key]));
    expect(tried).toEqual(["api.unreachableWithBackup"]);
    const words = read("./failure-text.ts");
    expect(words).toMatch(/if \(failure\.relayTried && failure\.error !== STOPPED_ANSWERING\) return t\("api\.unreachableWithBackup"\)/);
  });
});

describe("the calm-UI rules", () => {
  it("draw the chip, the prompt and the reminders without a warning colour", () => {
    for (const source of [
      component(backupRoute, "BackupRouteChip"),
      component(backupRoute, "BackupRouteConsent"),
      component(recovery, "VerifyEmailReminder").split("function Problem")[0],
    ]) {
      // Errors a form shows are `Problem`, defined apart; the card itself
      // is neutral.
      expect(source).not.toMatch(/\b(?:text|bg|border)-(?:warning|destructive|amber|yellow|orange|red)/);
    }
  });

  it("put the chip and the prompt at each app's root, never on a dashboard's orb or headline", () => {
    for (const app of [desktopApp, mobileApp]) {
      expect(app).toMatch(/<BackupRouteChip \/>/);
      expect(app).toMatch(/<BackupRouteConsent \/>/);
      expect(app).toMatch(/setRelayTunnelReader\(/);
    }
    for (const dashboard of [desktopDashboard, mobileDashboard]) {
      expect(dashboard).not.toMatch(/BackupRoute|last-resort|relayModeActive/);
    }
  });

  it("show the chip only while relay mode lasts", () => {
    const chip = component(backupRoute, "BackupRouteChip");
    expect(chip).toMatch(/if \(!active\) return null;/);
  });

  it("ask consent with two plain answers, and no way to dismiss it as a decline", () => {
    const prompt = component(backupRoute, "BackupRouteConsent");
    expect(prompt).toMatch(/answer\(true\)/);
    expect(prompt).toMatch(/answer\(false\)/);
    expect(prompt).not.toMatch(/Escape/);
    // The backdrop is not a button.
    expect(prompt).not.toMatch(/bg-black\/60[^>]*onClick/);
  });
});

describe("the reset and sign-up screens", () => {
  it("offer the recovery code where the emailed reset code is asked for", () => {
    const forgot = read("../screens/ForgotPassword.tsx");
    expect(forgot).toMatch(/resetPasswordByRecoveryCode/);
    expect(forgot).toMatch(/t\("forgot\.relayHint"\)/);
    expect(forgot).toMatch(/<RecoveryCodeNotice/);
  });

  it("asks for the address twice on the relay's sign-up, and shows the recovery code once", () => {
    const register = read("../screens/Register.tsx");
    expect(register).toMatch(/relayRegister\(email\.trim\(\), emailAgain\.trim\(\), password\)/);
    expect(register).toMatch(/t\("relay\.signupNote"\)/);
    expect(register).toMatch(/<RecoveryCodeNotice code=\{recoveryCode\}/);
  });

  it("hold card and crypto checkout through the relay, and say why", () => {
    const plans = read("../screens/Plans.tsx");
    expect(plans).toMatch(/TODO\(relay checkout\)/);
    expect(plans).toMatch(/disabled=\{stage\.name === "starting" \|\| viaRelay\}/g);
    expect(plans).toMatch(/t\("relay\.checkoutUnavailable"\)/);
  });
});
