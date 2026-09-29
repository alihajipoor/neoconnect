/** Branded HTML email bodies -- matches the panel's dark violet/cyan
 * visual language (see the panel's Tailwind theme + [[feedback_ui_design_quality]]),
 * translated into an email-safe layout: table-based structure, inline
 * styles only (no <style> block, no flexbox/grid), web-safe font stack --
 * this is what actually survives Outlook/Gmail's aggressive CSS
 * stripping, not a fully modern stylesheet. Each template returns both an
 * html and a text body (nodemailer sends both; text is the fallback for
 * clients that can't/won't render html).
 *
 * Bilingual since 2026-09-28. The clients have been English/Persian from
 * launch (apps/desktop-windows/src/lib/i18n.tsx) while every email here
 * was English-only -- and the largest single market for this product is
 * Iran, so the message that actually asks somebody to do something (type
 * a code, renew, pay) was the one part of the product they could not
 * read. Nothing was broken, which is why it went unnoticed. Every
 * template now takes the recipient's `locale` as its first argument:
 * required rather than defaulted, so a new call site cannot quietly send
 * English to a Persian customer. */

const PRIMARY = "#8b5cf6"; // violet, matches the panel's primary accent
const PRIMARY_DARK = "#7c3aed";
const ACCENT = "#22d3ee"; // cyan, matches the panel's secondary/highlight accent
const INK = "#1e1b2e";
const MUTED = "#6b7280";
const BORDER = "#eceaf5";
const BG = "#f4f4fa";

/** Filled in by EmailBrandService just before the message is sent.
 *
 * Slots rather than parameters because these two things -- where this
 * API answers from, and which community links the operator has set --
 * are runtime facts that live in config and the database, while every
 * template here is a pure function called from a dozen places. Threading
 * them through all of those would make each call site responsible for
 * remembering brand chrome it has no opinion about, and one that forgot
 * would silently send an unbranded email. Substituting at the single
 * point every message already passes through cannot be forgotten, and
 * keeps the templates synchronous and testable. */
export const BRAND_LOGO_SLOT = "<!--neoxify:logo-->";
export const BRAND_LINKS_SLOT = "<!--neoxify:links-->";

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

/** The two languages the clients ship, and therefore the two a customer
 * can have asked for. Kept in step with `Language` in
 * apps/desktop-windows/src/lib/i18n.tsx -- adding a third means adding it
 * there first, since the value in the database only ever comes from a
 * client that already renders that language. */
export type Locale = "en" | "fa";

/** Narrows whatever came out of the database to a locale we can render.
 *
 * `Customer.locale` is a plain String column with a default, not an enum,
 * so a hand-edited row or a future client that sends `fa-IR` must not be
 * able to index the strings table with a key that isn't there and hand a
 * customer an email full of `undefined`. Anything unrecognised is
 * English, which is the same answer the column's default gives. */
export function toLocale(value: string | null | undefined): Locale {
  if (!value) return "en";
  return value.toLowerCase().startsWith("fa") ? "fa" : "en";
}

/** Latin for English, Persian for Persian.
 *
 * Deliberately hand-rolled rather than `Intl.NumberFormat("fa-IR")`,
 * which is what the desktop client uses (GamePicker.tsx). A client runs
 * in a browser engine that always has full ICU; this runs in
 * node:20-alpine, and nothing in this repo pins that image's ICU build.
 * A small-ICU runtime does not throw on an unknown locale -- it silently
 * falls back to en-US, which here would mean Latin digits in an
 * otherwise Persian sentence, on a send path nobody reads the output of.
 *
 * Only for counts in prose. Verification codes, invoice numbers and
 * money never go through this -- see `ltr()`. */
const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
function num(locale: Locale, value: string | number): string {
  const text = String(value);
  if (locale === "en") return text;
  return text.replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]).replace(/\./g, "٫");
}

/** Forces a run of Latin text to read left-to-right inside an RTL
 * sentence. The same rule the clients apply in CSS (`html[dir="rtl"]
 * [data-ltr]` in apps/desktop-windows/src/theme.css): without it
 * "1.5 GB" renders as "GB 1.5", and an email address or a URL at the end
 * of a Persian sentence has its punctuation thrown to the wrong side.
 *
 * The `dir` attribute rather than the `unicode-bidi` CSS property the
 * client can rely on: attributes survive the CSS stripping every webmail
 * client does to a message body, declarations on a span do not always. */
function ltr(value: string): string {
  return `<span dir="ltr" style="unicode-bidi:embed;">${value}</span>`;
}

interface Style {
  locale: Locale;
  dir: "ltr" | "rtl";
  /** Where text is set flush. Written out on every text element rather
   * than left to inherit from `<html dir>`: Outlook renders through
   * Word, which honours `dir` inconsistently on nested table cells, and
   * a Persian paragraph flush left in the one client with the largest
   * corporate install base is the failure that would go unreported. */
  align: "left" | "right";
  font: string;
  lineHeight: string;
}

/** English keeps the original web-safe stack.
 *
 * Persian cannot: the clients bundle Vazirmatn precisely because Windows
 * otherwise falls back to Tahoma, which sets Persian poorly (see the
 * @font-face comment in apps/desktop-windows/src/theme.css). An email
 * cannot bundle anything, and a linked webfont needs an @font-face rule
 * in a <style> block -- which this layout deliberately does not have,
 * and which Gmail strips from a message body regardless. So Persian gets
 * the faces that are already on the reader's machine, worst-first-avoided
 * rather than best-hoped-for:
 *
 *   Tahoma       -- on every Windows install since XP and the de facto
 *                   Persian UI face there; plain, but it always exists.
 *   Iranian Sans -- the system Persian face on Samsung/Android, where a
 *                   large share of this audience reads mail.
 *   Geneva       -- macOS/iOS fall back to Geeza Pro for Arabic script
 *                   from any of these anyway; named so the Latin runs in
 *                   a mixed line don't land on Times.
 *
 * Arial and sans-serif close it out so a machine with none of the above
 * still gets a sans face rather than the client's serif default. */
const FONT_STACK: Record<Locale, string> = {
  en: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  fa: "Tahoma,'Iranian Sans','IRANSans',Geneva,Arial,sans-serif",
};

/** Persian ascenders and diacritics need more vertical room than Latin
 * and collide with the line above at the Latin setting -- the same
 * reason `html[lang="fa"] body` carries its own line-height in
 * apps/desktop-windows/src/theme.css. Scaled from 1.65 by the ratio that
 * file uses (1.5 -> 1.75). */
const LINE_HEIGHT: Record<Locale, string> = { en: "1.65", fa: "1.9" };

function styleFor(locale: Locale): Style {
  const rtl = locale === "fa";
  return {
    locale,
    dir: rtl ? "rtl" : "ltr",
    align: rtl ? "right" : "left",
    font: FONT_STACK[locale],
    lineHeight: LINE_HEIGHT[locale],
  };
}

// ---------------------------------------------------------------------------
// Shell and building blocks
// ---------------------------------------------------------------------------

/** Wraps a template's body content in the shared branded shell: a
 * gradient header with the Neoxify mark, a white card, and a muted
 * footer. `preheader` is the short hidden preview text most mail clients
 * show next to the subject line in the inbox list. */
function shell({
  locale,
  preheader,
  bodyHtml,
  footerHtml,
}: {
  locale: Locale;
  preheader: string;
  bodyHtml: string;
  /** Replaces the default closing sentence. Bulk mail needs to say how
   * to stop receiving it; transactional mail must not, since there is
   * nothing to opt out of. */
  footerHtml?: string;
}): string {
  const s = styleFor(locale);
  const chrome = STRINGS[locale].chrome;

  return `<!doctype html>
<html dir="${s.dir}" lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <!-- Declares this design as light-only. Without it, clients that
         auto-invert for dark mode (Outlook and Gmail both do) recolour
         the card and the code block by their own rules, and the violet
         text on the pale violet panel is exactly the combination that
         comes out illegible. Better to render as designed in both modes
         than to be re-interpreted in one. -->
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
  </head>
  <body dir="${s.dir}" style="margin:0;padding:0;background:${BG};font-family:${s.font};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${s.dir}" style="background:${BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" dir="${s.dir}" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(139,92,246,0.12);">
            <tr>
              <td align="${s.align}" style="background-color:${PRIMARY};background-image:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,#5b21b6 100%);padding:28px 32px;">
                <!-- The mark as an image, with the name beside it as
                     real text. Images are blocked by default in a good
                     number of clients, and a header that is entirely an
                     image becomes a blank bar when that happens -- the
                     text means the brand always survives.
                     The wordmark stays Latin in both languages, the same
                     way the Persian client's dictionary leaves "Neoxify"
                     untransliterated: it is what is written on the app
                     the reader is being asked to open. -->
                ${BRAND_LOGO_SLOT}<span dir="ltr" style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:0.2px;vertical-align:middle;">Neoxify</span>
              </td>
            </tr>
            <tr>
              <td align="${s.align}" style="padding:36px 32px 32px 32px;color:${INK};font-size:15px;line-height:${s.lineHeight};text-align:${s.align};">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td align="${s.align}" style="padding:20px 32px;border-top:1px solid ${BORDER};background:#fbfaff;text-align:${s.align};">
                ${BRAND_LINKS_SLOT}
                <p style="margin:0;font-size:12px;color:${MUTED};line-height:${s.lineHeight};text-align:${s.align};">
                  ${chrome.accountNotice}
                  ${footerHtml ?? chrome.ignoreNotice}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function heading(s: Style, text: string): string {
  return `<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:${INK};text-align:${s.align};line-height:${s.lineHeight};">${text}</h1>`;
}

function paragraph(s: Style, text: string): string {
  return `<p style="margin:0 0 16px 0;color:${INK};text-align:${s.align};line-height:${s.lineHeight};">${text}</p>`;
}

/** No `align` attribute, deliberately -- on a table that is `float`, not
 * alignment, and the paragraph after it then wraps up alongside the
 * button instead of starting below it. Caught by rendering the Persian
 * set: the expiry line came up beside the button rather than under it,
 * and it would have done the same in English. A table with auto width
 * already sits at the start edge of its containing block, which `dir`
 * on the cell has already flipped to the right for Persian. */
function button(s: Style, url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" dir="${s.dir}" style="margin:8px 0 20px 0;">
    <tr>
      <td style="border-radius:10px;background-color:${PRIMARY};background-image:linear-gradient(135deg,${PRIMARY},${PRIMARY_DARK});">
        <a href="${url}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

/** A prominent, letter-spaced token/code display -- used for the
 * password-reset link's token. `overflow-wrap`/`word-break` together
 * (not just one) plus `max-width:100%` is deliberate: a real bug found
 * live had a raw JWT overflow past the email's visible width in Gmail's
 * web UI with only `word-break` set -- some renderers need both
 * properties, and the containing element also needs to be told it's
 * allowed to shrink rather than grow to fit unbreakable content.
 *
 * Always `dir="ltr"`, in both languages. What goes in here is an
 * identifier the reader copies or quotes back to us -- an invoice
 * number, a token -- and bidi reordering it inside a Persian paragraph
 * would print a value that is not the value we issued. */
function codeBlock(value: string): string {
  return `<div dir="ltr" style="margin:4px 0 20px 0;padding:14px 18px;max-width:100%;background:#f6f3ff;border:1px solid #e4dcfb;border-radius:10px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:14px;font-weight:600;color:${PRIMARY_DARK};word-break:break-all;overflow-wrap:anywhere;white-space:normal;text-align:left;">${value}</div>`;
}

/** A large, widely-spaced short code for the actual human to type by
 * hand -- added 2026-07-24 after live testing showed a raw JWT (what
 * codeBlock() above was originally used for here) is both unusable to
 * type and prone to overflowing the email's layout. Real digits are
 * separated by literal spaces, not just CSS letter-spacing, since some
 * email clients strip letter-spacing -- this is the standard OTP-email
 * technique for a reason.
 *
 * The digits stay Latin and `dir="ltr"` for a Persian reader too, unlike
 * every other number in these emails. They are not a quantity being
 * read, they are six characters being copied into a text input that the
 * app matches against what the database stored -- and what the database
 * stored is `randomInt().toString()`, i.e. `0-9`. Printing `۴۹۲۰۱۷` here
 * would be asking somebody to type a code that cannot match. */
function bigCode(value: string): string {
  const spaced = value.split("").join(" ");
  return `<div dir="ltr" style="margin:4px 0 20px 0;padding:18px 12px;max-width:100%;background:#f6f3ff;border:1px solid #e4dcfb;border-radius:12px;text-align:center;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:30px;font-weight:800;letter-spacing:4px;color:${PRIMARY_DARK};word-break:break-all;">${spaced}</div>`;
}

function fineprint(s: Style, text: string): string {
  return `<p style="margin:0;font-size:13px;color:${MUTED};text-align:${s.align};line-height:${s.lineHeight};">${text}</p>`;
}

/** A small colored stat pill -- used to make a number (GB remaining,
 * days remaining) the visual focal point rather than burying it in a
 * sentence.
 *
 * The label's `text-transform:uppercase` and `letter-spacing` are
 * English-only. Uppercase does nothing to Persian, which has no letter
 * case, and letter-spacing actively breaks it: Arabic-script letters
 * join, and pushing them apart severs the joins into disconnected
 * shapes. The one rule that looks like harmless polish in English is the
 * one that would make the Persian label read as broken text. */
function statPill(s: Style, value: string, label: string): string {
  const labelStyle =
    s.locale === "fa" ? "" : "text-transform:uppercase;letter-spacing:0.6px;";
  // Not `align` -- see the note on button() above.
  return `<table role="presentation" cellpadding="0" cellspacing="0" dir="${s.dir}" style="margin:4px 0 20px 0;">
    <tr>
      <td style="padding:16px 22px;background:linear-gradient(135deg,#f6f3ff,#ecfeff);border:1px solid ${BORDER};border-radius:12px;text-align:${s.align};">
        <div style="font-size:26px;font-weight:800;color:${PRIMARY_DARK};line-height:1.1;">${value}</div>
        <div style="font-size:12px;font-weight:600;color:${ACCENT === "#22d3ee" ? "#0891b2" : MUTED};${labelStyle}margin-top:2px;">${label}</div>
      </td>
    </tr>
  </table>`;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** Every piece of copy these templates emit, in both languages.
 *
 * A plain typed dictionary rather than an i18n library, for the same
 * reason the clients use one (see the comment above `const en` in
 * apps/desktop-windows/src/lib/i18n.tsx): there are eleven templates
 * here, and the single thing a library would buy -- a missing Persian
 * string being an error rather than a blank -- is bought instead by
 * `FA: Strings` below, which is a compile error the moment the two drift.
 *
 * Interpolation is by function rather than `{placeholder}` substitution
 * because a subject or a sentence sometimes has to reorder its parts
 * between languages, and a function can do that while a replace cannot.
 */
const EN = {
  chrome: {
    accountNotice: "You're receiving this because you have a Neoxify account.",
    ignoreNotice: "If something here looks wrong, you can safely ignore this email.",
  },

  verification: {
    subject: "Welcome to Neoxify -- verify your email",
    preheader: (code: string) => `Your verification code is ${code}.`,
    heading: "Welcome aboard ⚡",
    intro: "Your Neoxify account is created. One step left -- enter this code in the app to activate it:",
    orClick: "Or just click here:",
    button: "Verify my email",
    expiry: "This code expires in 24 hours. If you didn't create a Neoxify account, you can ignore this email.",
    text: (code: string, link: string) =>
      `Welcome to Neoxify. Your verification code: ${code} (expires in 24 hours). Or open: ${link}`,
  },

  passwordReset: {
    subject: "Reset your Neoxify password",
    preheader: (code: string) => `Your password reset code is ${code}.`,
    heading: "Reset your password",
    intro: "A password reset was requested for your account. Enter this code in the app to continue:",
    expiry:
      "This code expires in 30 minutes. If you didn't request this, you can safely ignore this email -- your password won't change.",
    text: (code: string) =>
      `A password reset was requested for your Neoxify account. Your code: ${code} (expires in 30 minutes). If you didn't request this, ignore this email.`,
  },

  lowData: {
    subject: "Your Neoxify data is running low",
    preheader: (gb: string) => `About ${gb} GB left on your current plan.`,
    heading: "Data running low",
    pillValue: (gb: string) => `${gb} GB`,
    pillLabel: "remaining this period",
    body: "Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.",
    text: (gb: string) =>
      `You have about ${gb} GB of data remaining on your current plan. Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.`,
  },

  expiringSoon: {
    subject: "Your Neoxify subscription is expiring soon",
    preheader: (days: number) =>
      `Your subscription expires in about ${days} ${days === 1 ? "day" : "days"}.`,
    heading: "Subscription expiring soon",
    pillValue: (days: number) => `${days} ${days === 1 ? "day" : "days"}`,
    pillLabel: "until expiry",
    body: "Renew before it expires to keep your VPN connection active without interruption.",
    text: (days: number) =>
      `Your subscription expires in about ${days} day(s). Renew before it expires to keep your VPN connection active without interruption.`,
  },

  referralJoined: {
    subject: "Someone joined Neoxify with your invite",
    preheader: (masked: string) => `${masked} just activated their account.`,
    heading: "Your invite worked",
    pillLabel: "just activated their account",
    keepInviting: "Keep inviting friends to earn free months of Neoxify.",
    monthsToGo: (months: number) =>
      `You're ${months} paid ${months === 1 ? "month" : "months"} away from your next free month.`,
    text: (masked: string, months: number | null) =>
      `${masked} just activated their Neoxify account using your invite.${
        months === null ? "" : ` You are ${months} paid month(s) away from your next free month.`
      }`,
  },

  referralReward: {
    subject: "You've earned free Neoxify time",
    preheader: (days: number) => `${days} free days have been added to your account.`,
    heading: "Your free time is ready",
    pillValue: (days: number) => `${days} days`,
    pillLabel: (planName: string) => `free on ${planName}`,
    /** Used when the reward plan has been deleted out from under the
     * settings row. Copy, not a call-site string, so it is translated
     * with everything else rather than left in English by the one place
     * that supplies it. */
    fallbackPlanName: "your plan",
    body: "Thanks for spreading the word. It's already on your account -- open Neoxify and connect as usual.",
    text: (days: number, planName: string) =>
      `You have earned ${days} free days of Neoxify on ${planName}, thanks to the friends you invited. It is already active on your account.`,
  },

  announcement: {
    footer: 'This is an announcement from Neoxify. To stop receiving them, reply with "Unsubscribe".',
    textFooter: 'This is an announcement from Neoxify. Reply with "Unsubscribe" to stop receiving them.',
  },

  supportReply: {
    heading: "Support replied",
    footer: "Reply from inside the Neoxify app to continue the conversation.",
  },

  invoiceIssued: {
    subject: (invoiceNumber: string) => `Your Neoxify receipt (${invoiceNumber})`,
    preheader: (amount: string, planName: string) => `${amount} for ${planName}.`,
    heading: "Thanks for your payment",
    body: (amount: string, planName: string) =>
      `We've received ${amount} for your ${planName} subscription. It's active now.`,
    button: "View invoice",
    keep: "Keep this for your records. You can view or print your invoices any time from the app.",
    text: (amount: string, planName: string, invoiceNumber: string, documentUrl?: string) =>
      `Payment received: ${amount} for ${planName}. Invoice ${invoiceNumber}.${
        documentUrl ? ` View it: ${documentUrl}` : ""
      }`,
  },

  invoiceOverdue: {
    subject: (invoiceNumber: string) => `Unpaid invoice ${invoiceNumber}`,
    preheader: (amount: string) => `${amount} is still outstanding.`,
    heading: "This invoice is still unpaid",
    body: (amount: string, invoiceNumber: string) =>
      `We haven't received ${amount} for invoice ${invoiceNumber} yet.`,
    button: "View invoice",
    settling:
      "If you've already paid, it may still be confirming -- crypto payments can take a while, and this will clear on its own. Otherwise, reach out and we'll help.",
    text: (amount: string, invoiceNumber: string, documentUrl?: string) =>
      `Invoice ${invoiceNumber} for ${amount} is unpaid.${documentUrl ? ` View it: ${documentUrl}` : ""}`,
  },

  voucher: {
    subject: (planName: string) => `Your Neoxify ${planName} subscription is ready`,
    preheader: (planName: string, code: string) => `Activate your ${planName} plan with code ${code}.`,
    heading: "Your subscription is ready",
    body: (planName: string) =>
      `You've been given a <strong>${planName}</strong> plan on Neoxify. Activate it with the code below — no payment needed.`,
    button: "Activate my plan",
    thenInstall: "Then install the app and sign in with the same email:",
    noLinks: "Download the app from neoxify.net to get started.",
    installerSub: "Installer",
    apkSub: "APK",
    /** Takes an already-rendered date so the html body can wrap it in
     * `ltr()` and the text/plain body cannot -- markup in a plain part
     * shows up as literal `<span dir="ltr">` in the reader's client. */
    expiresOn: (date: string) => `This code expires on ${date}.`,
    neverExpires: "This code does not expire.",
    byHand: "If the button doesn't work, go to neoxify.net/account and enter the code by hand.",
    text: (planName: string, code: string, activationUrl: string, expiry: string) =>
      `Your Neoxify ${planName} subscription is ready.\n\n` +
      `Activation code: ${code}\n` +
      `Activate here: ${activationUrl}\n\n` +
      `${expiry}\n`,
  },
};

type Strings = typeof EN;

/** Persian.
 *
 * Written as Persian rather than translated word for word: subjects are
 * shorter than their English counterparts because Persian inbox lists
 * truncate sooner at the same pixel width, and the "you can safely
 * ignore this" constructions are the ones a Persian speaker would
 * actually use rather than a literal rendering of the English idiom.
 *
 * "Neoxify" is left in Latin script throughout, matching the Persian
 * dictionary in the clients: it is the name printed on the app the
 * reader is being told to open, and a transliteration would not match
 * anything they can see.
 *
 * Numbers in prose are Persian-Indic (see `num()`); codes, invoice
 * numbers, money and dates are not (see `bigCode()` and `ltr()`).
 */
const FA: Strings = {
  chrome: {
    accountNotice: "این ایمیل را دریافت کرده‌اید چون در Neoxify حساب کاربری دارید.",
    ignoreNotice: "اگر چیزی در آن درست به نظر نمی‌رسد، می‌توانید بدون نگرانی نادیده‌اش بگیرید.",
  },

  verification: {
    subject: "به Neoxify خوش آمدید — ایمیلتان را تأیید کنید",
    preheader: (code: string) => `کد تأیید شما ${ltr(code)} است.`,
    heading: "خوش آمدید ⚡",
    intro: "حساب Neoxify شما ساخته شد. یک قدم مانده — این کد را در برنامه وارد کنید تا فعال شود:",
    orClick: "یا روی این دکمه بزنید:",
    button: "تأیید ایمیل",
    expiry: "این کد تا ۲۴ ساعت اعتبار دارد. اگر شما حساب Neoxify نساخته‌اید، این ایمیل را نادیده بگیرید.",
    text: (code: string, link: string) =>
      `به Neoxify خوش آمدید. کد تأیید شما: ${code} (تا ۲۴ ساعت اعتبار دارد). یا این نشانی را باز کنید: ${link}`,
  },

  passwordReset: {
    subject: "بازنشانی رمز عبور Neoxify",
    preheader: (code: string) => `کد بازنشانی رمز عبور شما ${ltr(code)} است.`,
    heading: "بازنشانی رمز عبور",
    intro: "برای حساب شما درخواست بازنشانی رمز عبور ثبت شده است. برای ادامه، این کد را در برنامه وارد کنید:",
    expiry:
      "این کد تا ۳۰ دقیقه اعتبار دارد. اگر شما چنین درخواستی نداده‌اید، می‌توانید این ایمیل را نادیده بگیرید — رمز عبورتان تغییر نمی‌کند.",
    text: (code: string) =>
      `برای حساب Neoxify شما درخواست بازنشانی رمز عبور ثبت شد. کد شما: ${code} (تا ۳۰ دقیقه اعتبار دارد). اگر شما چنین درخواستی نداده‌اید، این ایمیل را نادیده بگیرید.`,
  },

  lowData: {
    subject: "حجم Neoxify شما رو به پایان است",
    preheader: (gb: string) => `حدود ${ltr(gb)} گیگابایت از پلن فعلی شما مانده است.`,
    heading: "حجم رو به پایان",
    pillValue: (gb: string) => `${gb} گیگابایت`,
    pillLabel: "باقی‌مانده در این دوره",
    body: "با تمام‌شدن حجم، اتصال VPN شما تا زمان تمدید یا ارتقای پلن متوقف می‌شود.",
    text: (gb: string) =>
      `حدود ${gb} گیگابایت از حجم پلن فعلی شما باقی مانده است. با تمام‌شدن حجم، اتصال VPN شما تا زمان تمدید یا ارتقای پلن متوقف می‌شود.`,
  },

  expiringSoon: {
    subject: "اشتراک Neoxify شما به‌زودی تمام می‌شود",
    // Persian does not inflect the noun after a number, so the English
    // day/days branch collapses to one form here.
    preheader: (days: number) => `اشتراک شما تا حدود ${ltr(num("fa", days))} روز دیگر تمام می‌شود.`,
    heading: "اشتراک رو به پایان",
    pillValue: (days: number) => `${num("fa", days)} روز`,
    pillLabel: "تا پایان اشتراک",
    body: "پیش از پایان اشتراک آن را تمدید کنید تا اتصالتان بدون وقفه برقرار بماند.",
    text: (days: number) =>
      `اشتراک شما تا حدود ${num("fa", days)} روز دیگر تمام می‌شود. پیش از آن تمدید کنید تا اتصالتان بدون وقفه برقرار بماند.`,
  },

  referralJoined: {
    subject: "کسی با دعوت شما به Neoxify پیوست",
    preheader: (masked: string) => `${ltr(masked)} حسابش را فعال کرد.`,
    heading: "دعوتتان نتیجه داد",
    pillLabel: "حسابش را فعال کرد",
    keepInviting: "برای گرفتن ماه‌های رایگان Neoxify، دوستان بیشتری دعوت کنید.",
    monthsToGo: (months: number) =>
      `تا ماه رایگان بعدی‌تان ${ltr(num("fa", months))} ماه اشتراک پولی فاصله دارید.`,
    text: (masked: string, months: number | null) =>
      `${masked} با دعوت شما حساب Neoxify خود را فعال کرد.${
        months === null ? "" : ` تا ماه رایگان بعدی‌تان ${num("fa", months)} ماه اشتراک پولی فاصله دارید.`
      }`,
  },

  referralReward: {
    subject: "زمان رایگان Neoxify برای شما ثبت شد",
    preheader: (days: number) => `${ltr(num("fa", days))} روز رایگان به حسابتان اضافه شد.`,
    heading: "زمان رایگان شما آماده است",
    pillValue: (days: number) => `${num("fa", days)} روز`,
    pillLabel: (planName: string) => `رایگان روی ${planName}`,
    fallbackPlanName: "پلن شما",
    body: "ممنون که Neoxify را به دیگران معرفی کردید. این زمان هم‌اکنون روی حسابتان فعال است — برنامه را باز کنید و مثل همیشه وصل شوید.",
    text: (days: number, planName: string) =>
      `به لطف دوستانی که دعوت کردید، ${num("fa", days)} روز استفاده‌ی رایگان از Neoxify روی پلن ${planName} برای شما ثبت شد و هم‌اکنون روی حسابتان فعال است.`,
  },

  announcement: {
    // "Unsubscribe" stays in Latin in both languages: it is the word a
    // human on our side reads in the reply, and asking a Persian reader
    // to send back a Persian word we do not look for would make the
    // instruction wrong rather than translated.
    footer:
      "این یک اطلاعیه از Neoxify است. برای متوقف‌کردن دریافت آن‌ها، به این ایمیل پاسخ دهید و بنویسید Unsubscribe.",
    textFooter:
      "این یک اطلاعیه از Neoxify است. برای متوقف‌کردن دریافت آن‌ها، به این ایمیل پاسخ دهید و بنویسید Unsubscribe.",
  },

  supportReply: {
    heading: "پشتیبانی پاسخ داد",
    footer: "برای ادامه‌ی گفتگو، از داخل برنامه‌ی Neoxify پاسخ دهید.",
  },

  invoiceIssued: {
    subject: (invoiceNumber: string) => `رسید پرداخت Neoxify (${invoiceNumber})`,
    preheader: (amount: string, planName: string) => `${ltr(amount)} بابت ${planName}.`,
    heading: "از پرداخت شما سپاسگزاریم",
    body: (amount: string, planName: string) =>
      `${ltr(amount)} بابت اشتراک ${planName} شما دریافت شد و اشتراک هم‌اکنون فعال است.`,
    button: "مشاهده‌ی فاکتور",
    keep: "این را برای سوابق خود نگه دارید. هر وقت بخواهید می‌توانید فاکتورهایتان را از داخل برنامه ببینید یا چاپ کنید.",
    text: (amount: string, planName: string, invoiceNumber: string, documentUrl?: string) =>
      `پرداخت دریافت شد: ${amount} بابت ${planName}. شماره‌ی فاکتور ${invoiceNumber}.${
        documentUrl ? ` مشاهده: ${documentUrl}` : ""
      }`,
  },

  invoiceOverdue: {
    subject: (invoiceNumber: string) => `فاکتور پرداخت‌نشده ${invoiceNumber}`,
    preheader: (amount: string) => `${ltr(amount)} هنوز پرداخت نشده است.`,
    heading: "این فاکتور هنوز پرداخت نشده",
    body: (amount: string, invoiceNumber: string) =>
      `${ltr(amount)} بابت فاکتور ${ltr(invoiceNumber)} هنوز به دست ما نرسیده است.`,
    button: "مشاهده‌ی فاکتور",
    settling:
      "اگر پرداخت کرده‌اید، ممکن است هنوز در حال تأیید باشد — پرداخت‌های رمزارزی گاهی طول می‌کشند و این مورد خودبه‌خود تسویه می‌شود. در غیر این صورت به ما پیام بدهید تا کمکتان کنیم.",
    text: (amount: string, invoiceNumber: string, documentUrl?: string) =>
      `فاکتور ${invoiceNumber} به مبلغ ${amount} پرداخت نشده است.${
        documentUrl ? ` مشاهده: ${documentUrl}` : ""
      }`,
  },

  voucher: {
    subject: (planName: string) => `اشتراک ${planName} شما در Neoxify آماده است`,
    preheader: (planName: string, code: string) =>
      `پلن ${planName} خود را با کد ${ltr(code)} فعال کنید.`,
    heading: "اشتراک شما آماده است",
    body: (planName: string) =>
      `یک پلن <strong>${planName}</strong> در Neoxify به شما داده شده است. با کد زیر فعالش کنید — نیازی به پرداخت نیست.`,
    button: "فعال‌سازی اشتراک",
    thenInstall: "سپس برنامه را نصب کنید و با همین ایمیل وارد شوید:",
    noLinks: "برای شروع، برنامه را از neoxify.net دریافت کنید.",
    installerSub: "نصب‌کننده",
    apkSub: "فایل APK",
    expiresOn: (date: string) => `این کد در تاریخ ${date} منقضی می‌شود.`,
    neverExpires: "این کد تاریخ انقضا ندارد.",
    byHand: "اگر دکمه کار نکرد، به neoxify.net/account بروید و کد را دستی وارد کنید.",
    text: (planName: string, code: string, activationUrl: string, expiry: string) =>
      `اشتراک ${planName} شما در Neoxify آماده است.\n\n` +
      `کد فعال‌سازی: ${code}\n` +
      `فعال‌سازی: ${activationUrl}\n\n` +
      `${expiry}\n`,
  },
};

const STRINGS: Record<Locale, Strings> = { en: EN, fa: FA };

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** `publicApiUrl` is where this API answers from a customer's browser.
 *
 * When it's set the button points at an https:// page that verifies and
 * then offers to open the app. Without it the button falls back to the
 * raw `neoconnect://` link, which webmail clients strip -- Gmail and
 * Yahoo both rendered it unclickable, confirmed on a real account. The
 * 6-digit code works in every case, which is why it stays the most
 * prominent element rather than the button. */
export function verificationEmail(
  locale: Locale,
  token: string,
  code: string,
  publicApiUrl?: string,
) {
  const s = styleFor(locale);
  const t = STRINGS[locale].verification;
  const deepLink = `neoconnect://verify-email?token=${encodeURIComponent(token)}`;
  const link = publicApiUrl
    ? `${publicApiUrl.replace(/\/$/, "")}/customer-auth/verify-email/open?token=${encodeURIComponent(token)}`
    : deepLink;

  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(code),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${paragraph(s, t.intro)}
        ${bigCode(code)}
        ${fineprint(s, t.orClick)}
        ${button(s, link, t.button)}
        ${fineprint(s, t.expiry)}
      `,
    }),
    text: t.text(code, link),
  };
}

/** Code only, no link.
 *
 * There used to be an "Open in Neoxify" button pointing at
 * neoconnect://reset-password, and nothing in the app has ever handled
 * that scheme -- it launched the app to no effect. Webmail strips custom
 * schemes anyway, which is the same reason verification grew a code.
 *
 * The token-based reset endpoint stays: it is still the right shape for
 * a website, which does not exist yet. When one does, this can carry an
 * https link the way the verification email does. */
export function passwordResetEmail(locale: Locale, code: string) {
  const s = styleFor(locale);
  const t = STRINGS[locale].passwordReset;
  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(code),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${paragraph(s, t.intro)}
        ${bigCode(code)}
        ${fineprint(s, t.expiry)}
      `,
    }),
    text: t.text(code),
  };
}

export function lowDataWarningEmail(locale: Locale, remainingGb: number) {
  const s = styleFor(locale);
  const t = STRINGS[locale].lowData;
  const remaining = num(locale, remainingGb.toFixed(1));
  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(remaining),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${statPill(s, t.pillValue(remaining), t.pillLabel)}
        ${paragraph(s, t.body)}
      `,
    }),
    text: t.text(remaining),
  };
}

export function expiringSoonEmail(locale: Locale, daysRemaining: number) {
  const s = styleFor(locale);
  const t = STRINGS[locale].expiringSoon;
  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(daysRemaining),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${statPill(s, t.pillValue(daysRemaining), t.pillLabel)}
        ${paragraph(s, t.body)}
      `,
    }),
    text: t.text(daysRemaining),
  };
}

/** Sent to the inviter when someone they invited activates their
 * account. The trigger M16 listed and could not build, because the
 * referral programme it depends on did not exist yet.
 *
 * The friend's address is masked before it ever reaches this function.
 * The inviter is entitled to know their invite worked; they are not
 * entitled to a readable copy of someone else's email address, and a
 * referral link shared publicly would otherwise become a way to harvest
 * them. */
export function referralFriendJoinedEmail(
  locale: Locale,
  maskedEmail: string,
  monthsToGo: number | null,
) {
  const s = styleFor(locale);
  const t = STRINGS[locale].referralJoined;
  const progress =
    monthsToGo === null
      ? paragraph(s, t.keepInviting)
      : paragraph(s, t.monthsToGo(monthsToGo));

  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(maskedEmail),
      // The masked address is an email address, not prose -- it keeps
      // its own direction so the mask, the @ and the domain stay in the
      // order they were written.
      bodyHtml: `
        ${heading(s, t.heading)}
        ${statPill(s, ltr(maskedEmail), t.pillLabel)}
        ${progress}
      `,
    }),
    text: t.text(maskedEmail, monthsToGo),
  };
}

/** Sent when a free month has actually been granted -- after the
 * subscription exists, never before. Promising a reward that then fails
 * to provision would be worse than a delayed email. */
export function referralRewardEmail(locale: Locale, days: number, planName: string | null) {
  const s = styleFor(locale);
  const t = STRINGS[locale].referralReward;
  // Null when the plan the reward points at has since been deleted. The
  // reward is real either way, so the email still goes -- naming it
  // vaguely beats not sending it.
  const plan = planName ?? t.fallbackPlanName;
  return {
    subject: t.subject,
    html: shell({
      locale,
      preheader: t.preheader(days),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${statPill(s, t.pillValue(days), t.pillLabel(plan))}
        ${paragraph(s, t.body)}
      `,
    }),
    text: t.text(days, plan),
  };
}

/** Used by AnnouncementsProcessor to wrap an admin-composed broadcast in
 * the same branded shell -- so a manual "server maintenance tonight"
 * notice looks as polished as every automated trigger above, not a bare
 * unstyled paragraph.
 *
 * `locale` styles the shell around the message, not the message: the
 * body is whatever one admin typed into one box, and there is no
 * translation of it to reach for. What the locale still buys is real --
 * an announcement written in Persian, sent to a Persian customer, is
 * currently laid out left-to-right in a Latin face, and this is the
 * template most likely to be composed in Persian in the first place. */
export function announcementEmail(locale: Locale, body: string) {
  const s = styleFor(locale);
  return shell({
    locale,
    preheader: body.slice(0, 120),
    bodyHtml: body
      .split(/\n{2,}/)
      .map((para) => paragraph(s, para.replace(/\n/g, "<br>")))
      .join(""),
    // The visible half of the opt-out. EmailService sets the
    // List-Unsubscribe header, because it knows the from-address; this
    // line is for the human, who does not read headers.
    //
    // Worded as a reply because that is what actually happens. There is
    // no unsubscribe endpoint yet, and a link that does nothing is worse
    // than an instruction that works.
    footerHtml: STRINGS[locale].announcement.footer,
  });
}

/** The plain-text half of the announcement, which the processor builds
 * itself because it owns the body. Exported so the opt-out wording is
 * localised in exactly one place rather than two. */
export function announcementText(locale: Locale, body: string): string {
  return `${body}\n\n--\n${STRINGS[locale].announcement.textFooter}`;
}

/** Sent when the operator answers a support conversation.
 *
 * Deliberately carries the reply itself rather than only "you have a
 * new message": support here is asynchronous, the app may be shut, and
 * an answer somebody has to go and fetch is an answer they may never
 * read. The thread still lives in the app for the back-and-forth.
 *
 * Escaped, unlike the announcement body above -- an operator typing
 * "if x < y" into a reply box should not be able to produce broken
 * markup in their own customer's inbox.
 *
 * As with the announcement, the reply body is the operator's words and
 * is not translated; the locale sets the direction and the chrome. The
 * "Re:" prefix stays Latin in both languages on purpose -- it is what
 * mail clients thread on, and a Persian speaker reading mail sees it
 * every day regardless.
 */
export function supportReplyEmail(locale: Locale, subject: string, body: string) {
  const s = styleFor(locale);
  const t = STRINGS[locale].supportReply;
  const escaped = escapeHtml(body);
  return {
    subject: `Re: ${subject}`,
    html: shell({
      locale,
      preheader: body.slice(0, 120),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${escaped
          .split(/\n{2,}/)
          .map((para) => paragraph(s, para.replace(/\n/g, "<br>")))
          .join("")}
        ${fineprint(s, t.footer)}
      `,
    }),
    text: `${body}\n\n--\n${t.footer}`,
  };
}

/** Receipt for a payment that has cleared.
 *
 * Sent when the invoice is issued, which for this product is the moment
 * the payment settles -- so it reads as a receipt rather than a demand.
 * The link opens the invoice document, which the customer's browser can
 * print to PDF; nothing is attached, since a PDF attachment is the
 * single most reliable way to get a transactional email into a spam
 * folder.
 *
 * The amount keeps Latin digits and its `$` in both languages: it is a
 * figure that has to match the payment processor's record and the
 * invoice document, and a Persian-Indic copy of it would be a second
 * spelling of a number somebody may have to quote back to a bank.
 */
export function invoiceIssuedEmail(params: {
  locale: Locale;
  invoiceNumber: string;
  planName: string;
  amountUsd: string;
  currency: string;
  documentUrl?: string;
}) {
  const s = styleFor(params.locale);
  const t = STRINGS[params.locale].invoiceIssued;
  const amount = `$${params.amountUsd} ${params.currency.toUpperCase()}`;
  return {
    subject: t.subject(params.invoiceNumber),
    html: shell({
      locale: params.locale,
      preheader: t.preheader(amount, params.planName),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${paragraph(s, t.body(amount, params.planName))}
        ${codeBlock(params.invoiceNumber)}
        ${params.documentUrl ? button(s, params.documentUrl, t.button) : ""}
        ${fineprint(s, t.keep)}
      `,
    }),
    text: t.text(amount, params.planName, params.invoiceNumber, params.documentUrl),
  };
}

/** Reminder for an invoice that has gone past its due date.
 *
 * Rare by design: almost everything here is paid at issue, so this only
 * fires for slow-settling crypto or, later, reseller terms. Worded as a
 * nudge rather than a threat, because the most likely explanation is a
 * payment still confirming rather than someone refusing to pay.
 */
export function invoiceOverdueEmail(params: {
  locale: Locale;
  invoiceNumber: string;
  amountUsd: string;
  currency: string;
  documentUrl?: string;
}) {
  const s = styleFor(params.locale);
  const t = STRINGS[params.locale].invoiceOverdue;
  const amount = `$${params.amountUsd} ${params.currency.toUpperCase()}`;
  return {
    subject: t.subject(params.invoiceNumber),
    html: shell({
      locale: params.locale,
      preheader: t.preheader(amount),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${paragraph(s, t.body(amount, params.invoiceNumber))}
        ${params.documentUrl ? button(s, params.documentUrl, t.button) : ""}
        ${fineprint(s, t.settling)}
      `,
    }),
    text: t.text(amount, params.invoiceNumber, params.documentUrl),
  };
}

/** A row of platform download links, laid out as a table so it survives
 * Outlook, which ignores flexbox entirely.
 *
 * Every href goes through the API's own `/updates/installer/*` redirects
 * rather than a GitHub release URL. Those redirect to whatever the
 * current release is (verified live: they resolve to desktop-v0.9.4 and
 * android-v0.2.9 today), so an email sent months ago still hands someone
 * the current build. A pasted release URL would rot the day after it was
 * sent, and this email is the one a reseller forwards repeatedly.
 *
 * "Windows" and "Android" are not translated: they are what is written
 * on the reader's own device and on the page the link opens.
 */
function downloadRow(s: Style, publicApiUrl?: string): string {
  const t = STRINGS[s.locale].voucher;
  const base = publicApiUrl ? publicApiUrl.replace(/\/$/, "") : "";
  if (!base) {
    // No configured public address means we cannot build a link that
    // works outside our own network. Saying where to go beats printing
    // a broken one.
    return paragraph(s, t.noLinks);
  }

  const cell = (label: string, sub: string, href: string) =>
    `<td style="padding:0 6px 10px 0;text-align:${s.align};" valign="top">
      <a href="${href}" style="display:block;padding:12px 14px;border:1px solid #e4dcfb;border-radius:10px;text-decoration:none;background:#faf8ff;">
        <span dir="ltr" style="display:block;font-size:14px;font-weight:700;color:${PRIMARY_DARK};text-align:${s.align};">${label}</span>
        <span style="display:block;font-size:12px;color:${MUTED};text-align:${s.align};">${sub}</span>
      </a>
    </td>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" dir="${s.dir}" style="margin:4px 0 18px 0;width:100%;">
    <tr>
      ${cell("Windows", t.installerSub, `${base}/updates/installer/windows`)}
      ${cell("Android", t.apkSub, `${base}/updates/installer/android`)}
    </tr>
  </table>`;
}

/**
 * The email a reseller sends when they hand a subscription to one of
 * their own customers.
 *
 * This is a stranger's first contact with the product -- they did not
 * sign up, they were given something by someone they bought from -- so
 * it has to answer "what is this, is it real, what do I do" in one
 * screen: what they have been given, the code itself, one button that
 * activates it, and where to get the app.
 *
 * The activation link carries the code so the common path is a single
 * tap. The code is also printed, because a link that arrives mangled by
 * a mail client, or is read on a different device from the one being set
 * up, must not be a dead end -- and because a reseller may have handed
 * the same code over verbally.
 *
 * Deliberately does not name the reseller. They are a business
 * relationship of the operator's, not a brand the recipient knows, and a
 * name they do not recognise on an unexpected email reads as phishing.
 *
 * The expiry date stays Gregorian and ISO in both languages. A Persian
 * reader would normally expect a Jalali date, and that is a real gap --
 * but the same date is printed on the voucher record an operator reads
 * in the panel, and two calendars for one deadline is a worse failure
 * than one unfamiliar calendar. Worth revisiting with a real conversion,
 * not a guess.
 */
export function resellerVoucherEmail(params: {
  locale: Locale;
  code: string;
  planName: string;
  activationUrl: string;
  publicApiUrl?: string;
  expiresAt?: Date | null;
}) {
  const s = styleFor(params.locale);
  const t = STRINGS[params.locale].voucher;
  const isoDate = params.expiresAt?.toISOString().slice(0, 10);
  const expiryHtml = isoDate ? t.expiresOn(ltr(isoDate)) : t.neverExpires;
  const expiryText = isoDate ? t.expiresOn(isoDate) : t.neverExpires;

  return {
    subject: t.subject(params.planName),
    html: shell({
      locale: params.locale,
      preheader: t.preheader(params.planName, params.code),
      bodyHtml: `
        ${heading(s, t.heading)}
        ${paragraph(s, t.body(params.planName))}
        ${bigCode(params.code)}
        ${button(s, params.activationUrl, t.button)}
        ${paragraph(s, t.thenInstall)}
        ${downloadRow(s, params.publicApiUrl)}
        ${fineprint(s, `${expiryHtml} ${t.byHand}`)}
      `,
    }),
    text: t.text(params.planName, params.code, params.activationUrl, expiryText),
  };
}
