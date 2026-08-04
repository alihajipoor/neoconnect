/**
 * Bilingual replies, chosen from the member's own language role.
 *
 * The server splits its channels by language (see scripts/discord/config.mjs),
 * so a member who picked فارسی is reading Persian channels and should get a
 * Persian answer from the bot too. The role is the source of truth rather than
 * Discord's client locale: locale is whatever language their app happens to be
 * in, while the role is what they deliberately chose here.
 */
export type Lang = "en" | "fa";

/** Matched by name so the bot survives the roles being recreated, which is
 * exactly what the sync script does. Kept in step with `roles` in
 * scripts/discord/config.mjs. */
const ROLE_NAMES: Record<Lang, string> = { en: "English", fa: "فارسی" };

export function detectLang(roleNames: string[]): Lang {
  return roleNames.some((name) => name === ROLE_NAMES.fa) ? "fa" : "en";
}

type Copy = Record<Lang, string>;

const t = (en: string, fa: string): Copy => ({ en, fa });

export const strings = {
  statusTitle: t("Service status", "وضعیت سرویس"),
  statusAllUp: t("All nodes are reporting in.", "همهٔ سرورها در حال گزارش هستند."),
  statusDegraded: t(
    "Some nodes are not reporting. The team has been alerted.",
    "بعضی سرورها گزارش نمی‌دهند. تیم در جریان است.",
  ),
  statusNoNodes: t("No nodes are configured yet.", "هنوز هیچ سروری تنظیم نشده است."),
  fieldNodes: t("Nodes", "سرورها"),
  fieldRoutes: t("Routes", "مسیرها"),
  fieldRegions: t("Regions", "مناطق"),
  online: t("online", "آنلاین"),
  stale: t("not reporting", "بدون گزارش"),
  offline: t("offline", "آفلاین"),
  enabled: t("enabled", "فعال"),

  plansTitle: t("Plans", "پلن‌ها"),
  plansEmpty: t("No plans are on sale right now.", "در حال حاضر پلنی برای فروش نیست."),
  perDays: t("days", "روز"),
  unlimited: t("Unlimited data", "ترافیک نامحدود"),
  dataCap: t("data", "ترافیک"),
  speed: t("speed", "سرعت"),
  devices: t("devices", "دستگاه"),
  buyAt: t("Buy at", "خرید از"),

  downloadTitle: t("Download Neoxify", "دانلود نئوکسیفای"),
  downloadBody: t(
    "Windows installer. Only ever download from our own site -- never a build shared by another member.",
    "نصب‌کنندهٔ ویندوز. فقط از سایت خودمان دانلود کنید — هرگز نسخه‌ای که کاربر دیگری فرستاده را نصب نکنید.",
  ),
  downloadFallback: t(
    "The download feed is not answering. Get the app from the website.",
    "سرویس دانلود پاسخ نمی‌دهد. برنامه را از وب‌سایت بگیرید.",
  ),

  helpTitle: t("Getting help", "دریافت کمک"),
  helpBody: t(
    [
      "Open a post in the help forum for your language and include:",
      "",
      "• Your OS and version",
      "• App version (Settings → About)",
      "• The route name and protocol",
      "• What you expected, and what happened",
      "",
      "**Never post config files, keys, subscription links, or invoices** — not even in a screenshot. Staff will never DM you first.",
    ].join("\n"),
    [
      "در انجمن پشتیبانی زبان خودتان یک پست بسازید و این‌ها را بنویسید:",
      "",
      "• سیستم‌عامل و نسخهٔ آن",
      "• نسخهٔ برنامه (تنظیمات ← درباره)",
      "• نام مسیر و پروتکل",
      "• چه انتظاری داشتید و چه اتفاقی افتاد",
      "",
      "**هرگز فایل کانفیگ، کلید، لینک اشتراک یا فاکتور نفرستید** — حتی در اسکرین‌شات. تیم پشتیبانی هرگز اول به شما پیام خصوصی نمی‌دهد.",
    ].join("\n"),
  ),

  apiDown: t(
    "I could not reach the panel just now. Try again in a minute.",
    "الان نتوانستم به پنل وصل شوم. یک دقیقهٔ دیگر دوباره امتحان کنید.",
  ),
  checkedAt: t("Checked", "بررسی‌شده در"),
} satisfies Record<string, Copy>;

export function say(key: keyof typeof strings, lang: Lang): string {
  return strings[key][lang];
}
