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
    expect(en["relay.chip"]).toBe("App data: backup route");
    expect(fa["relay.chip"]).toBe("داده‌های برنامه: مسیر پشتیبان");
    expect(en["relay.disconnect"]).toBe("Disconnect to use the backup route.");
    expect(fa["relay.disconnect"]).toBe("برای استفاده از مسیر پشتیبان، اتصال را قطع کنید.");
    // Without naming the country: the owner asked that no screen name it
    // (2026-10-26).
    expect(en["relay.region"]).toBe("The backup route only works for connections from inside the country its server is in.");
    expect(fa["relay.region"]).toBe("مسیر پشتیبان فقط برای اتصال از داخل کشوری است که سرورش در آن قرار دارد.");
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

  // With the prompt gone, the Settings hint is the only thing that says
  // what the backup route does before it is used. It said "from Iran" and
  // named three things; the route is tried wherever the usual way is
  // blocked, for the app's own background requests too, until the backend
  // places the network abroad.
  it("say in Settings that the route is automatic, carries the app's own requests, and when it stops", () => {
    expect(en["settings.backupRouteHint"]).toMatch(/automatically/);
    expect(en["settings.backupRouteHint"]).toMatch(/your account, the server list and vouchers/);
    expect(en["settings.backupRouteHint"]).toMatch(/until you turn this off here/);
    expect(en["settings.backupRouteHint"]).toMatch(/outside that country.*for a day/);
    expect(en["settings.backupRouteHint"]).not.toMatch(/usual way from Iran/);
    expect(fa["settings.backupRouteHint"]).toContain("به‌طور خودکار");
    expect(fa["settings.backupRouteHint"]).toContain("فهرست سرورها");
    expect(fa["settings.backupRouteHint"]).toContain("همین‌جا خاموش");
    expect(fa["settings.backupRouteHint"]).toMatch(/بیرون از آن کشور.*یک روز/);
    // The encryption sentence stays.
    expect(en["settings.backupRouteHint"]).toMatch(/Your data stays encrypted/);
    expect(fa["settings.backupRouteHint"]).toContain("رمزگذاری‌شده می‌ماند");
  });

  it("mention the backup server having failed only in the string for a relay that was dialled", () => {
    const tried = (Object.keys(en) as (keyof typeof en)[]).filter((key) => /even through the backup server/i.test(en[key]));
    expect(tried).toEqual(["api.unreachableWithBackup"]);
    const words = read("./failure-text.ts");
    expect(words).toMatch(/if \(failure\.relayTried && failure\.error !== STOPPED_ANSWERING\) return t\("api\.unreachableWithBackup"\)/);
  });
});

describe("the calm-UI rules", () => {
  it("draw the chip and the reminders without a warning colour", () => {
    for (const source of [
      component(backupRoute, "BackupRouteChip"),
      component(recovery, "VerifyEmailReminder").split("function Problem")[0],
    ]) {
      // Errors a form shows are `Problem`, defined apart; the card itself
      // is neutral.
      expect(source).not.toMatch(/\b(?:text|bg|border)-(?:warning|destructive|amber|yellow|orange|red)/);
    }
  });

  it("put the chip at each app's root, never on a dashboard's orb or headline", () => {
    for (const app of [desktopApp, mobileApp]) {
      expect(app).toMatch(/<BackupRouteChip \/>/);
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

  it("look for a tunnel while the chip shows, so a tunnel up on either app ends relay mode", () => {
    // The phone tells the endpoint order nothing about its tunnel, and a
    // tunnel can come up with no pass in the app at all (a quick-settings
    // tile, always-on VPN, one kept up across a restart): the chip would
    // otherwise claim the backup route over a tunnel until the TTL ran out.
    const chip = component(backupRoute, "BackupRouteChip");
    expect(chip).toMatch(/if \(!active\) return;\s*void checkTunnelForRelayMode\(\);/);
    expect(chip).toMatch(/setInterval\(\(\) => void checkTunnelForRelayMode\(\), TUNNEL_WATCH_MS\)/);
    expect(chip).toMatch(/return \(\) => clearInterval\(watch\);/);
  });

  // Owner, 2026-10-18: the backup route asks nothing before it is used.
  // A prompt only ever reached customers who tapped something; the
  // server-list refresh of one already signed in never asked, and kept
  // them on cached servers. It is on until turned off in Settings.
  it("ask nothing before the backup route is used, and start the Settings switch on", () => {
    expect(backupRoute).not.toMatch(/BackupRouteConsent|onRelayConsentAsked/);
    for (const app of [desktopApp, mobileApp]) expect(app).not.toMatch(/BackupRouteConsent/);
    expect(component(recovery, "BackupRouteSection")).toMatch(/useState\(backupRouteOn\(\)\)/);
    expect(Object.keys(en).filter((key) => key.startsWith("relay.consent"))).toEqual([]);
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

  it("meet plans an unconfirmed account may not list with the calm reminder, not a red error or an endless load", () => {
    // A relay sign-up lands on Plans, and the backend's guard refuses the
    // plan list to an unconfirmed account (403 VERIFY_EMAIL, R3.3).
    const plans = read("../screens/Plans.tsx");
    expect(plans).toMatch(/else if \(result\.code === "VERIFY_EMAIL"\) setLimited\(true\);\s*else setError\(failureText\(result, t\)\);/);
    expect(plans).toMatch(/\{limited \? null : plans === null \?/);
    const note = /<p\b[^>]*data-plans-limited[^>]*>\s*\{t\("verify\.reminder"\)\}/.exec(plans);
    expect(note).not.toBeNull();
    expect(note![0]).not.toMatch(/\b(?:text|bg|border)-(?:warning|destructive|amber|yellow|orange|red)/);
    // Said once: the sign-up's own notice already says it.
    expect(plans).toMatch(/\{limited && !notice \? \(/);
  });

  it("hold card and crypto checkout through the relay, and say why", () => {
    const plans = read("../screens/Plans.tsx");
    expect(plans).toMatch(/TODO\(relay checkout\)/);
    expect(plans).toMatch(/disabled=\{stage\.name === "starting" \|\| viaRelay\}/g);
    expect(plans).toMatch(/t\("relay\.checkoutUnavailable"\)/);
  });
});
