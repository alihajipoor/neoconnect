/** Every email this backend sends, in one design.
 *
 * The look is the apps' own -- "Pearl Glass": a pearl page, a white card
 * with a soft edge and a generous radius, near-black type, and the glass
 * mark carrying the brand's violet-to-cyan. The values are the tokens in
 * apps/desktop-windows/src/theme.css, flattened: a mail client cannot blur
 * what is behind a surface, so the glass is drawn as the solid it settles
 * to, and a translucent hairline as the colour it makes over white.
 *
 * Built the way mail has to be built: tables for layout, every style that
 * matters written inline, no script, no external stylesheet, no webfont.
 * There is one small <style> block, for the two things an inline style
 * cannot say -- "on a narrow screen" and "in dark mode". A client that
 * strips it (several do) shows the light design at desktop padding, which
 * is still a complete, readable email. Nothing depends on that block.
 *
 * Two shells share the frame. Customers get the roomy one, in their own
 * language. Staff get a compact "operations" one (`operationsEmail`),
 * always in English: a severity chip, the facts as a table, the detail
 * under it. Each template returns an html and a text body; the text is
 * what a client shows when it cannot or will not render html.
 *
 * Bilingual since 2026-09-28. The clients have been English/Persian from
 * launch (apps/desktop-windows/src/lib/i18n.tsx) while every email here
 * was English-only, so the message that actually asks somebody to do
 * something (type a code, renew, pay) was the one part of the product a
 * Persian reader could not read. Every customer template takes the
 * recipient's `locale` as its first argument: required rather than
 * defaulted, so a new call site cannot quietly send English to a Persian
 * customer. */

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** theme.css, light ("Pearl"). */
const BASE = "#f1f3f6"; // --base, the page
const CARD = "#ffffff"; // --glass-strong, settled
const PEARL = "#f8f9fc"; // --pearl, a surface set into the card
const INK = "#090b10"; // --ink
const INK_2 = "#4a5264"; // --ink-2
const MUTED = "#6b7385"; // --muted
const EDGE = "#dee0e5"; // --hairline-2 over white, the card's edge
const RULE = "#e8eaef"; // between --hairline and --hairline-2, inside the card
const COBALT = "#1045ff"; // --cobalt, the apps' one action colour
/** The mark's own two colours (--logo-violet, --logo-cyan). Decoration
 * only: white text on the cyan end is 1.8:1. */
const LOGO_VIOLET = "#8b5cf6";
const LOGO_CYAN = "#22d3ee";
/** Where the button's gradient starts: the mark's violet, deepened until
 * white text on it passes 4.5:1 (5.7:1; on cobalt 6.3:1). */
const BUTTON_VIOLET = "#7c3aed";

/** theme.css, dark ("Smoked"). Only ever applied through the <style>
 * block's prefers-color-scheme rule. */
const DARK = {
  base: "#0b0e15",
  card: "#131721",
  head: "#161b27",
  well: "#1a1f2b",
  rule: "#262b36",
  wellEdge: "#2a303c",
  ink: "#eef1f7",
  ink2: "#a9b2c4",
  muted: "#8a93a6",
  link: "#93b0ff",
};

/** --r-panel for the card, the apps' pill for a button, and the rounder
 * of the inner radii for anything set into the card. */
const R_CARD = 22;
const R_WELL = 14;

/** --drop. */
const SHADOW = "0 1px 2px rgba(20,30,60,0.05),0 22px 44px -22px rgba(20,40,90,0.28)";

const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

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

/** A third slot, for staff mail only: a button to a page of the admin
 * panel. A slot for the same reason as the two above -- where the panel
 * lives is known only at send time -- and it carries the page and the
 * label, so `fillBrandSlots` can draw the button or, when the panel's
 * address is not known, leave nothing where it would have been. */
const PANEL_SLOT = /<!--neoxify:panel:([a-z0-9/_-]+)\|([A-Za-z0-9 ]+)-->/g;

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
  rtl: boolean;
  /** Where text is set flush. Written out on every text element rather
   * than left to inherit from `<html dir>`: Outlook renders through
   * Word, which honours `dir` inconsistently on nested table cells, and
   * a Persian paragraph flush left in the one client with the largest
   * corporate install base is the failure that would go unreported. */
  align: "left" | "right";
  font: string;
  lineHeight: string;
  /** Headings sit tighter than running text, in either script. */
  headingLineHeight: string;
  /** The apps' display tracking (-0.02em), for Latin only. Any
   * letter-spacing pulls joined Arabic-script letters apart or into each
   * other, so Persian gets none, anywhere. */
  tight: string;
}

/** The faces the apps use, named first, then what is on the reader's
 * machine.
 *
 * The apps bundle Inter and Vazirmatn. An email cannot bundle anything,
 * and a linked webfont is a network fetch most mail clients refuse, so
 * neither is loaded -- only named. A reader who has the face installed
 * (Vazirmatn is a common install among Persian readers) gets the app's
 * own type; everyone else gets the next one in the list:
 *
 *   Latin    the system UI face on each platform -- San Francisco, Segoe
 *            UI, Roboto -- which is what Inter was drawn to sit beside.
 *   Persian  Tahoma, on every Windows install since XP and the de facto
 *            Persian UI face there; Iranian Sans, the system Persian face
 *            on Samsung/Android, where a large share of this audience
 *            reads mail; Geneva so the Latin runs in a mixed line on
 *            macOS/iOS don't land on Times (Arabic script falls back to
 *            Geeza Pro there from any of these).
 *
 * Arial and sans-serif close each list so a machine with none of the
 * above still gets a sans face rather than the client's serif default. */
const FONT_STACK: Record<Locale, string> = {
  en: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  fa: "Vazirmatn,Tahoma,'Iranian Sans','IRANSans',Geneva,Arial,sans-serif",
};

/** Persian ascenders and diacritics need more vertical room than Latin
 * and collide with the line above at the Latin setting -- the same
 * reason `html[lang="fa"] body` carries its own line-height in
 * apps/desktop-windows/src/theme.css. Scaled from 1.65 by the ratio that
 * file uses (1.5 -> 1.75). */
const LINE_HEIGHT: Record<Locale, string> = { en: "1.65", fa: "1.9" };
const HEADING_LINE_HEIGHT: Record<Locale, string> = { en: "1.25", fa: "1.6" };

function styleFor(locale: Locale): Style {
  const rtl = locale === "fa";
  return {
    locale,
    dir: rtl ? "rtl" : "ltr",
    rtl,
    align: rtl ? "right" : "left",
    font: FONT_STACK[locale],
    lineHeight: LINE_HEIGHT[locale],
    headingLineHeight: HEADING_LINE_HEIGHT[locale],
    tight: rtl ? "" : "letter-spacing:-0.02em;",
  };
}

// ---------------------------------------------------------------------------
// The frame both shells share
// ---------------------------------------------------------------------------

/** The only stylesheet. Everything in it is an override of an inline
 * style, hung on a class, and the email is whole without any of it.
 *
 * Narrow screens: tighter padding, so a 380px phone keeps a readable
 * measure instead of a card with a third of its width spent on margins.
 *
 * Dark mode: the Smoked tokens. Declared as supported (the two metas and
 * `color-scheme` below) so a client that can follow the reader's theme
 * does it by these rules rather than by inverting colours on its own --
 * the automatic inversions are what turned the old violet-on-violet code
 * block illegible. A client that ignores all of it shows the light
 * design, whose near-black on white survives any inversion. */
const HEAD_CSS = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark;}",
  "@media only screen and (max-width:620px){",
  ".nx-outer{padding:14px 8px!important;}",
  ".nx-pad{padding-left:22px!important;padding-right:22px!important;}",
  ".nx-h1{font-size:22px!important;}",
  "}",
  "@media (prefers-color-scheme:dark){",
  `.nx-bg{background:${DARK.base}!important;}`,
  `.nx-card{background:${DARK.card}!important;border-color:${DARK.rule}!important;box-shadow:none!important;}`,
  `.nx-head{background:${DARK.head}!important;border-color:${DARK.rule}!important;}`,
  `.nx-rule{border-color:${DARK.rule}!important;}`,
  `.nx-ink{color:${DARK.ink}!important;}`,
  `.nx-ink2{color:${DARK.ink2}!important;}`,
  `.nx-muted{color:${DARK.muted}!important;}`,
  `.nx-well{background:${DARK.well}!important;border-color:${DARK.wellEdge}!important;}`,
  `.nx-link{color:${DARK.link}!important;}`,
  ".nx-logo-l{display:none!important;}",
  ".nx-logo-d{display:inline-block!important;}",
  ".nx-chip-info{background:#1c2542!important;color:#a7beff!important;}",
  ".nx-chip-warning{background:#33270f!important;color:#f7c46f!important;}",
  ".nx-chip-urgent{background:#3a1c19!important;color:#f79a90!important;}",
  "}",
].join("");

/** Pushes the body's first words out of the inbox preview line. Without
 * it a client fills the space after a short preheader with whatever
 * comes next in the markup -- here, the word "Neoxify" and the heading
 * again. Zero-width and non-breaking, so it takes up preview room and
 * shows nothing. */
const PREHEADER_PAD = "&#847;&zwnj;&nbsp;".repeat(40);

function frame(o: {
  s: Style;
  /** Already html: a Persian preheader carries `ltr()` spans. */
  preheader: string;
  headerHtml: string;
  bodyHtml: string;
  footerHtml: string;
}): string {
  const { s } = o;
  // The card's own corners, less its border, for the header's fill.
  const inner = R_CARD - 1;

  return `<!doctype html>
<html dir="${s.dir}" lang="${s.locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>${HEAD_CSS}</style>
  </head>
  <body dir="${s.dir}" class="nx-bg" style="margin:0;padding:0;background:${BASE};font-family:${s.font};-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;mso-hide:all;">${o.preheader}${PREHEADER_PAD}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" class="nx-bg" bgcolor="${BASE}" style="background:${BASE};">
      <tr>
        <td align="center" class="nx-outer" style="padding:28px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" class="nx-card" bgcolor="${CARD}" style="width:100%;max-width:600px;background:${CARD};border:1px solid ${EDGE};border-radius:${R_CARD}px;border-collapse:separate;box-shadow:${SHADOW};">
            <tr>
              <td align="${s.align}" class="nx-head nx-pad" bgcolor="${PEARL}" style="padding:20px 32px;background-color:${PEARL};background-image:linear-gradient(120deg,rgba(139,92,246,0.07),rgba(34,211,238,0.06));border-bottom:1px solid ${RULE};border-radius:${inner}px ${inner}px 0 0;text-align:${s.align};">
                ${o.headerHtml}
              </td>
            </tr>
            <tr>
              <td align="${s.align}" class="nx-pad nx-ink" style="padding:32px 32px 14px 32px;color:${INK};font-family:${s.font};font-size:15px;line-height:${s.lineHeight};text-align:${s.align};">
                ${o.bodyHtml}
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" style="width:100%;max-width:600px;">
            <tr>
              <td align="${s.align}" class="nx-pad" style="padding:18px 32px 8px 32px;font-family:${s.font};text-align:${s.align};">
                ${o.footerHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The mark as an image, with the name beside it as real text. Images
 * are blocked by default in a good number of clients, and a header that
 * is entirely an image becomes a blank bar when that happens -- the text
 * means the brand always survives.
 *
 * The wordmark stays Latin in both languages, the same way the Persian
 * client's dictionary leaves "Neoxify" untransliterated: it is what is
 * written on the app the reader is being asked to open. */
function wordmark(size: number): string {
  return `${BRAND_LOGO_SLOT}<span dir="ltr" class="nx-ink" style="font-size:${size}px;font-weight:600;color:${INK};letter-spacing:-0.02em;vertical-align:middle;">Neoxify</span>`;
}

/** The customer shell. `preheader` is the short hidden preview text most
 * mail clients show next to the subject line in the inbox list. */
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

  return frame({
    s,
    preheader,
    headerHtml: wordmark(20),
    bodyHtml,
    footerHtml: `${BRAND_LINKS_SLOT}
                <p class="nx-muted" style="margin:0;font-size:12px;color:${MUTED};line-height:${s.lineHeight};text-align:${s.align};">
                  ${chrome.accountNotice}
                  ${footerHtml ?? chrome.ignoreNotice}
                </p>`,
  });
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** For a value going into an attribute as well as into text. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function heading(s: Style, text: string): string {
  return `<h1 class="nx-ink nx-h1" style="margin:0 0 14px 0;font-size:24px;font-weight:600;color:${INK};${s.tight}text-align:${s.align};line-height:${s.headingLineHeight};">${text}</h1>`;
}

function paragraph(s: Style, text: string): string {
  return `<p class="nx-ink" style="margin:0 0 18px 0;font-size:15px;color:${INK};text-align:${s.align};line-height:${s.lineHeight};">${text}</p>`;
}

/** The one action. A pill in the apps' cobalt, with the mark's violet
 * running into it.
 *
 * "Bulletproof" in the mail sense: the colour is on the cell, three
 * ways. `bgcolor` is all Outlook's Word engine reads; `background-color`
 * is the solid every other client falls back to; the gradient is for the
 * ones that draw it. Whichever of the three a client stops at, the label
 * is white on a colour dark enough to read it on. Word also ignores
 * padding on a link, which would shrink the button to its text, so the
 * cell carries the same padding again under the one name only Word
 * reads (`mso-padding-alt`).
 *
 * No `align` attribute, deliberately -- on a table that is `float`, not
 * alignment, and the paragraph after it then wraps up alongside the
 * button instead of starting below it. Caught by rendering the Persian
 * set: the expiry line came up beside the button rather than under it,
 * and it would have done the same in English. A table with auto width
 * already sits at the start edge of its containing block, which `dir`
 * on the cell has already flipped to the right for Persian. */
function button(s: Style, url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" style="margin:6px 0 22px 0;">
    <tr>
      <td bgcolor="${COBALT}" style="border-radius:999px;background-color:${COBALT};background-image:linear-gradient(135deg,${BUTTON_VIOLET} 0%,${COBALT} 100%);mso-padding-alt:13px 28px;">
        <a href="${url}" style="display:inline-block;padding:13px 28px;font-family:${s.font};font-size:15px;font-weight:600;line-height:1.3;color:#ffffff;text-decoration:none;border-radius:999px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

/** A quiet label over a code, so a bare identifier says what it is. */
function wellLabel(s: Style, text: string): string {
  return `<p class="nx-ink2" style="margin:0 0 6px 0;font-size:12px;font-weight:600;color:${INK_2};text-align:${s.align};line-height:${s.lineHeight};">${text}</p>`;
}

/** An identifier the reader copies or quotes back to us -- an invoice
 * number, a token. `overflow-wrap`/`word-break` together (not just one)
 * plus `max-width:100%` is deliberate: a real bug found live had a raw
 * JWT overflow past the email's visible width in Gmail's web UI with
 * only `word-break` set -- some renderers need both properties, and the
 * containing element also needs to be told it's allowed to shrink
 * rather than grow to fit unbreakable content.
 *
 * Always `dir="ltr"`, in both languages: bidi reordering an identifier
 * inside a Persian paragraph would print a value that is not the value
 * we issued. */
function codeBlock(value: string): string {
  return `<div dir="ltr" class="nx-well nx-ink" style="margin:0 0 20px 0;padding:13px 18px;max-width:100%;background:${PEARL};border:1px solid ${RULE};border-radius:${R_WELL}px;font-family:${MONO};font-size:14px;font-weight:600;color:${INK};word-break:break-all;overflow-wrap:anywhere;white-space:normal;text-align:left;">${value}</div>`;
}

/** A large, widely-spaced short code for the actual human to type by
 * hand -- added 2026-07-24 after live testing showed a raw JWT (what
 * codeBlock() above was originally used for here) is both unusable to
 * type and prone to overflowing the email's layout. The characters are
 * separated by literal spaces, not just CSS letter-spacing, since some
 * email clients strip letter-spacing -- this is the standard OTP-email
 * technique for a reason.
 *
 * A six-digit code is spaced digit by digit. A voucher code is twelve
 * characters, which spaced that way is twenty-three and wraps on every
 * phone, so it is set in fours instead -- the grouping people use when
 * they read a code out, and one the redeem path already ignores
 * (`normalise` in vouchers/voucher-code.ts strips spaces).
 *
 * The digits stay Latin and `dir="ltr"` for a Persian reader too, unlike
 * every other number in these emails. They are not a quantity being
 * read, they are six characters being copied into a text input that the
 * app matches against what the database stored -- and what the database
 * stored is `randomInt().toString()`, i.e. `0-9`. Printing `۴۹۲۰۱۷` here
 * would be asking somebody to type a code that cannot match. */
function bigCode(value: string): string {
  const short = value.length <= 8;
  const spaced = short ? value.split("").join(" ") : (value.match(/.{1,4}/g) ?? [value]).join(" ");
  const size = short ? 30 : 22;
  return `<div dir="ltr" class="nx-well nx-ink" style="margin:0 0 20px 0;padding:18px 12px;max-width:100%;background:${PEARL};border:1px solid ${RULE};border-radius:${R_WELL}px;text-align:center;font-family:${MONO};font-size:${size}px;font-weight:600;letter-spacing:2px;color:${INK};word-break:break-all;">${spaced}</div>`;
}

function fineprint(s: Style, text: string): string {
  return `<p class="nx-ink2" style="margin:0 0 18px 0;font-size:13px;color:${INK_2};text-align:${s.align};line-height:${s.lineHeight};">${text}</p>`;
}

/** A number made the focal point -- GB remaining, days remaining --
 * rather than buried in a sentence. A pearl tile with the mark's
 * gradient down its leading edge, the one place outside the logo the
 * brand's two colours appear together.
 *
 * `compact` is for a value that is not a number: a masked email address
 * at the number's size runs off a phone.
 *
 * The label's `text-transform:uppercase` and `letter-spacing` are
 * English-only. Uppercase does nothing to Persian, which has no letter
 * case, and letter-spacing actively breaks it: Arabic-script letters
 * join, and pushing them apart severs the joins into disconnected
 * shapes. The one rule that looks like harmless polish in English is the
 * one that would make the Persian label read as broken text. */
function statPill(s: Style, value: string, label: string, compact = false): string {
  const labelStyle = s.rtl ? "" : "text-transform:uppercase;letter-spacing:0.6px;";
  // The bar takes the tile's corners on whichever side the text starts.
  const barRadius = s.rtl ? `0 ${R_WELL - 1}px ${R_WELL - 1}px 0` : `${R_WELL - 1}px 0 0 ${R_WELL - 1}px`;
  const valueSize = compact ? 17 : 28;
  // Not `align` -- see the note on button() above.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" class="nx-well" style="margin:0 0 20px 0;max-width:100%;background:${PEARL};border:1px solid ${RULE};border-radius:${R_WELL}px;border-collapse:separate;">
    <tr>
      <td width="5" bgcolor="${LOGO_VIOLET}" style="width:5px;font-size:0;line-height:0;background-color:${LOGO_VIOLET};background-image:linear-gradient(180deg,${LOGO_VIOLET},${LOGO_CYAN});border-radius:${barRadius};">&nbsp;</td>
      <td style="padding:14px 22px 14px 18px;text-align:${s.align};">
        <div class="nx-ink" style="font-size:${valueSize}px;font-weight:600;color:${INK};${s.tight}line-height:1.25;word-break:break-word;overflow-wrap:anywhere;">${value}</div>
        <div class="nx-ink2" style="font-size:12px;font-weight:600;color:${INK_2};${labelStyle}margin-top:3px;line-height:1.5;">${label}</div>
      </td>
    </tr>
  </table>`;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** Every piece of copy the customer templates emit, in both languages.
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
    ignoreNotice: "If this email looks wrong to you, you can ignore it.",
  },

  verification: {
    subject: "Confirm your Neoxify email",
    preheader: (code: string) => `Your confirmation code is ${code}.`,
    heading: "Welcome to Neoxify",
    intro: "Your account is ready. Enter this code in the app to activate it:",
    orClick: "Or confirm with this button:",
    button: "Confirm my email",
    expiry: "This code expires in 24 hours. If you didn't create a Neoxify account, you can ignore this email.",
    text: (code: string, link: string) =>
      `Welcome to Neoxify. Your confirmation code: ${code} (expires in 24 hours). Or open: ${link}`,
  },

  passwordReset: {
    subject: "Reset your Neoxify password",
    preheader: (code: string) => `Your password reset code is ${code}.`,
    heading: "Reset your password",
    intro: "Someone asked to reset the password for your account. Enter this code in the app to continue:",
    expiry:
      "This code expires in 30 minutes. If you didn't ask for this, ignore this email. Your password won't change.",
    text: (code: string) =>
      `Someone asked to reset the password for your Neoxify account. Your code: ${code} (expires in 30 minutes). If you didn't ask for this, ignore this email.`,
  },

  lowData: {
    subject: "Your Neoxify data is running low",
    preheader: (gb: string) => `About ${gb} GB left on your current plan.`,
    heading: "Data running low",
    pillValue: (gb: string) => `${gb} GB`,
    pillLabel: "left this period",
    body: "When your data runs out, your VPN connection pauses until you renew or upgrade your plan.",
    text: (gb: string) =>
      `You have about ${gb} GB of data left on your current plan. When your data runs out, your VPN connection pauses until you renew or upgrade your plan.`,
  },

  expiringSoon: {
    subject: "Your Neoxify plan ends soon",
    preheader: (days: number) =>
      `Your plan ends in about ${days} ${days === 1 ? "day" : "days"}.`,
    heading: "Your plan ends soon",
    pillValue: (days: number) => `${days} ${days === 1 ? "day" : "days"}`,
    pillLabel: "left",
    body: "Renew before then so your VPN keeps working without a break.",
    text: (days: number) =>
      `Your plan ends in about ${days} ${days === 1 ? "day" : "days"}. Renew before then so your VPN keeps working without a break.`,
  },

  referralJoined: {
    subject: "Someone joined Neoxify with your invite",
    preheader: (masked: string) => `${masked} just activated their account.`,
    heading: "Your invite worked",
    pillLabel: "just activated their account",
    keepInviting: "Invite more friends to get free months of Neoxify.",
    monthsToGo: (months: number) =>
      `You're ${months} paid ${months === 1 ? "month" : "months"} away from your next free month.`,
    text: (masked: string, months: number | null) =>
      `${masked} just activated their Neoxify account using your invite.${
        months === null
          ? ""
          : ` You're ${months} paid ${months === 1 ? "month" : "months"} away from your next free month.`
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
    body: "Thanks for inviting your friends. The free time is already on your account. Open Neoxify and connect as usual.",
    text: (days: number, planName: string) =>
      `You've earned ${days} free days of Neoxify on ${planName}, thanks to the friends you invited. It's already on your account.`,
  },

  announcement: {
    footer: 'This is an announcement from Neoxify. To stop receiving them, reply with "Unsubscribe".',
    textFooter: 'This is an announcement from Neoxify. Reply with "Unsubscribe" to stop receiving them.',
  },

  supportReply: {
    heading: "Support replied",
    footer: "Reply from the Neoxify app to continue the conversation.",
  },

  invoiceIssued: {
    subject: (invoiceNumber: string) => `Your Neoxify receipt (${invoiceNumber})`,
    preheader: (amount: string, planName: string) => `${amount} for ${planName}.`,
    heading: "Thanks for your payment",
    body: (amount: string, planName: string) =>
      `We received ${amount} for your ${planName} plan. It's active now.`,
    numberLabel: "Invoice number",
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
      "If you've already paid, the payment may still be confirming. Crypto payments can take a while, and this clears by itself. If you haven't paid, contact us and we'll help.",
    text: (amount: string, invoiceNumber: string, documentUrl?: string) =>
      `Invoice ${invoiceNumber} for ${amount} is unpaid.${documentUrl ? ` View it: ${documentUrl}` : ""}`,
  },

  voucher: {
    subject: (planName: string) => `Your Neoxify ${planName} plan is ready`,
    preheader: (planName: string, code: string) => `Activate your ${planName} plan with code ${code}.`,
    heading: "Your plan is ready",
    body: (planName: string) =>
      `You've been given a <strong>${planName}</strong> plan on Neoxify. Activate it with the code below. No payment is needed.`,
    codeLabel: "Activation code",
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
      `Your Neoxify ${planName} plan is ready.\n\n` +
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
 * The name is written نئوکسیفای in Persian prose, as the clients' Persian
 * dictionary writes it, so a sentence does not switch script mid-way. The
 * wordmark in the header stays Latin: it is what is printed on the app.
 *
 * Numbers in prose are Persian-Indic (see `num()`); codes, invoice
 * numbers, money and dates are not (see `bigCode()` and `ltr()`).
 */
const FA: Strings = {
  chrome: {
    accountNotice: "این ایمیل را گرفته‌اید چون در نئوکسیفای حساب کاربری دارید.",
    ignoreNotice: "اگر این ایمیل به نظرتان اشتباه است، آن را نادیده بگیرید.",
  },

  verification: {
    subject: "ایمیل نئوکسیفای خود را تأیید کنید",
    preheader: (code: string) => `کد تأیید شما ${ltr(code)} است.`,
    heading: "به نئوکسیفای خوش آمدید",
    intro: "حساب شما آماده است. برای فعال کردنش، این کد را در برنامه وارد کنید:",
    orClick: "یا با این دکمه تأیید کنید:",
    button: "تأیید ایمیل",
    expiry: "این کد تا ۲۴ ساعت اعتبار دارد. اگر شما حساب نئوکسیفای نساخته‌اید، این ایمیل را نادیده بگیرید.",
    text: (code: string, link: string) =>
      `به نئوکسیفای خوش آمدید. کد تأیید شما: ${code} (تا ۲۴ ساعت اعتبار دارد). یا این لینک را باز کنید: ${link}`,
  },

  passwordReset: {
    subject: "بازنشانی رمز عبور نئوکسیفای",
    preheader: (code: string) => `کد بازنشانی رمز عبور شما ${ltr(code)} است.`,
    heading: "بازنشانی رمز عبور",
    intro: "درخواست بازنشانی رمز عبور حساب شما ثبت شد. برای ادامه، این کد را در برنامه وارد کنید:",
    expiry:
      "این کد تا ۳۰ دقیقه اعتبار دارد. اگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید. رمز عبورتان عوض نمی‌شود.",
    text: (code: string) =>
      `درخواست بازنشانی رمز عبور حساب نئوکسیفای شما ثبت شد. کد شما: ${code} (تا ۳۰ دقیقه اعتبار دارد). اگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.`,
  },

  lowData: {
    subject: "حجم نئوکسیفای شما رو به اتمام است",
    preheader: (gb: string) => `حدود ${ltr(gb)} گیگابایت از پلن فعلی شما مانده است.`,
    heading: "حجم شما رو به اتمام است",
    pillValue: (gb: string) => `${gb} گیگابایت`,
    pillLabel: "مانده در این دوره",
    body: "وقتی حجم تمام شود، اتصال وی‌پی‌ان شما تا تمدید یا ارتقای پلن متوقف می‌شود.",
    text: (gb: string) =>
      `حدود ${gb} گیگابایت از حجم پلن فعلی شما مانده است. وقتی حجم تمام شود، اتصال وی‌پی‌ان شما تا تمدید یا ارتقای پلن متوقف می‌شود.`,
  },

  expiringSoon: {
    subject: "پلن نئوکسیفای شما به‌زودی تمام می‌شود",
    // Persian does not inflect the noun after a number, so the English
    // day/days branch collapses to one form here.
    preheader: (days: number) => `پلن شما حدود ${ltr(num("fa", days))} روز دیگر تمام می‌شود.`,
    heading: "پلن شما به‌زودی تمام می‌شود",
    pillValue: (days: number) => `${num("fa", days)} روز`,
    pillLabel: "مانده",
    body: "پیش از تمام شدن پلن، آن را تمدید کنید تا وی‌پی‌ان شما بدون وقفه کار کند.",
    text: (days: number) =>
      `پلن شما حدود ${num("fa", days)} روز دیگر تمام می‌شود. پیش از آن تمدیدش کنید تا وی‌پی‌ان شما بدون وقفه کار کند.`,
  },

  referralJoined: {
    subject: "یک نفر با دعوت شما در نئوکسیفای ثبت‌نام کرد",
    preheader: (masked: string) => `${ltr(masked)} حسابش را فعال کرد.`,
    heading: "دعوت شما نتیجه داد",
    pillLabel: "حسابش را فعال کرد",
    keepInviting: "دوستان بیشتری دعوت کنید تا ماه‌های رایگان نئوکسیفای بگیرید.",
    monthsToGo: (months: number) =>
      `تا ماه رایگان بعدی، ${ltr(num("fa", months))} ماه خرید دیگر لازم است.`,
    text: (masked: string, months: number | null) =>
      `${masked} با دعوت شما حساب نئوکسیفای خود را فعال کرد.${
        months === null ? "" : ` تا ماه رایگان بعدی، ${num("fa", months)} ماه خرید دیگر لازم است.`
      }`,
  },

  referralReward: {
    subject: "زمان رایگان نئوکسیفای برای شما ثبت شد",
    preheader: (days: number) => `${ltr(num("fa", days))} روز رایگان به حسابتان اضافه شد.`,
    heading: "زمان رایگان شما آماده است",
    pillValue: (days: number) => `${num("fa", days)} روز`,
    pillLabel: (planName: string) => `رایگان روی ${planName}`,
    fallbackPlanName: "پلن شما",
    body: "ممنون که دوستانتان را دعوت کردید. این زمان رایگان همین حالا روی حسابتان فعال است. نئوکسیفای را باز کنید و مثل همیشه وصل شوید.",
    text: (days: number, planName: string) =>
      `به لطف دوستانی که دعوت کردید، ${num("fa", days)} روز استفادهٔ رایگان از نئوکسیفای روی ${planName} برای شما ثبت شد و همین حالا روی حسابتان فعال است.`,
  },

  announcement: {
    // "Unsubscribe" stays in Latin in both languages: it is the word a
    // human on our side reads in the reply, and asking a Persian reader
    // to send back a Persian word we do not look for would make the
    // instruction wrong rather than translated.
    footer:
      "این یک اطلاعیه از نئوکسیفای است. اگر نمی‌خواهید این ایمیل‌ها را بگیرید، به همین ایمیل جواب بدهید و بنویسید Unsubscribe.",
    textFooter:
      "این یک اطلاعیه از نئوکسیفای است. اگر نمی‌خواهید این ایمیل‌ها را بگیرید، به همین ایمیل جواب بدهید و بنویسید Unsubscribe.",
  },

  supportReply: {
    heading: "پشتیبانی جواب داد",
    footer: "برای ادامهٔ گفت‌وگو، از داخل برنامهٔ نئوکسیفای جواب بدهید.",
  },

  invoiceIssued: {
    subject: (invoiceNumber: string) => `رسید پرداخت نئوکسیفای (${invoiceNumber})`,
    preheader: (amount: string, planName: string) => `${ltr(amount)} بابت ${planName}.`,
    heading: "ممنون از پرداخت شما",
    body: (amount: string, planName: string) =>
      `${ltr(amount)} بابت پلن ${planName} شما دریافت شد و پلن همین حالا فعال است.`,
    numberLabel: "شمارهٔ فاکتور",
    button: "دیدن فاکتور",
    keep: "این ایمیل را برای سوابق خود نگه دارید. هر وقت بخواهید می‌توانید فاکتورها را در برنامه ببینید یا چاپ کنید.",
    text: (amount: string, planName: string, invoiceNumber: string, documentUrl?: string) =>
      `پرداخت دریافت شد: ${amount} بابت ${planName}. شمارهٔ فاکتور ${invoiceNumber}.${
        documentUrl ? ` دیدن فاکتور: ${documentUrl}` : ""
      }`,
  },

  invoiceOverdue: {
    subject: (invoiceNumber: string) => `فاکتور پرداخت‌نشده ${invoiceNumber}`,
    preheader: (amount: string) => `${ltr(amount)} هنوز پرداخت نشده است.`,
    heading: "این فاکتور هنوز پرداخت نشده",
    body: (amount: string, invoiceNumber: string) =>
      `${ltr(amount)} بابت فاکتور ${ltr(invoiceNumber)} هنوز به دست ما نرسیده است.`,
    button: "دیدن فاکتور",
    settling:
      "اگر پرداخت کرده‌اید، ممکن است هنوز در حال تأیید باشد. پرداخت با رمزارز گاهی طول می‌کشد و این فاکتور خودش تسویه می‌شود. اگر پرداخت نکرده‌اید، به ما پیام بدهید تا کمکتان کنیم.",
    text: (amount: string, invoiceNumber: string, documentUrl?: string) =>
      `فاکتور ${invoiceNumber} به مبلغ ${amount} پرداخت نشده است.${
        documentUrl ? ` دیدن فاکتور: ${documentUrl}` : ""
      }`,
  },

  voucher: {
    subject: (planName: string) => `پلن ${planName} شما در نئوکسیفای آماده است`,
    preheader: (planName: string, code: string) =>
      `پلن ${planName} خود را با کد ${ltr(code)} فعال کنید.`,
    heading: "پلن شما آماده است",
    body: (planName: string) =>
      `یک پلن <strong>${planName}</strong> در نئوکسیفای به شما داده شده است. با کد زیر فعالش کنید. نیازی به پرداخت نیست.`,
    codeLabel: "کد فعال‌سازی",
    button: "فعال کردن پلن",
    thenInstall: "بعد برنامه را نصب کنید و با همین ایمیل وارد شوید:",
    noLinks: "برای شروع، برنامه را از neoxify.net دانلود کنید.",
    installerSub: "فایل نصب",
    apkSub: "فایل APK",
    expiresOn: (date: string) => `این کد تا تاریخ ${date} اعتبار دارد.`,
    neverExpires: "این کد تاریخ انقضا ندارد.",
    byHand: "اگر دکمه کار نکرد، به neoxify.net/account بروید و کد را خودتان وارد کنید.",
    text: (planName: string, code: string, activationUrl: string, expiry: string) =>
      `پلن ${planName} شما در نئوکسیفای آماده است.\n\n` +
      `کد فعال‌سازی: ${code}\n` +
      `فعال‌سازی: ${activationUrl}\n\n` +
      `${expiry}\n`,
  },
};

const STRINGS: Record<Locale, Strings> = { en: EN, fa: FA };

// ---------------------------------------------------------------------------
// Customer templates
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
        ${statPill(s, ltr(maskedEmail), t.pillLabel, true)}
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
 * an announcement written in Persian, sent to a Persian customer, would
 * otherwise be laid out left-to-right in a Latin face, and this is the
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
 * markup in their own customer's inbox. The preheader is the same words
 * and is escaped the same way.
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
      preheader: escapeHtml(body.slice(0, 120)),
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
        ${wellLabel(s, t.numberLabel)}
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

  // The gap between the two tiles is on the first one's trailing side,
  // whichever side that is.
  const gap = (first: boolean) => (first ? (s.rtl ? "0 0 0 10px" : "0 10px 0 0") : "0");
  const cell = (first: boolean, label: string, sub: string, href: string) =>
    `<td width="50%" style="width:50%;padding:${gap(first)};text-align:${s.align};" valign="top">
      <a href="${href}" class="nx-well" style="display:block;padding:12px 16px;border:1px solid ${RULE};border-radius:${R_WELL}px;text-decoration:none;background:${PEARL};">
        <span dir="ltr" class="nx-ink" style="display:block;font-size:15px;font-weight:600;color:${INK};text-align:${s.align};">${label}</span>
        <span class="nx-ink2" style="display:block;font-size:12px;color:${INK_2};text-align:${s.align};">${sub}</span>
      </a>
    </td>`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" style="margin:0 0 20px 0;width:100%;">
    <tr>
      ${cell(true, "Windows", t.installerSub, `${base}/updates/installer/windows`)}
      ${cell(false, "Android", t.apkSub, `${base}/updates/installer/android`)}
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
        ${wellLabel(s, t.codeLabel)}
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

// ---------------------------------------------------------------------------
// Operations mail
// ---------------------------------------------------------------------------

/** How loudly a staff mail speaks. The colours are the apps' state
 * colours (theme.css: --ok, --warn, --danger), each as its tint, its ink
 * and its dot -- calm on purpose. An inbox of red banners teaches its
 * owner to stop reading them. */
export type OpsSeverity = "info" | "warning" | "urgent";

const SEVERITY: Record<OpsSeverity, { label: string; tint: string; ink: string; dot: string }> = {
  info: { label: "Info", tint: "#e6edff", ink: "#0b3be0", dot: "#1045ff" },
  warning: { label: "Warning", tint: "#faeede", ink: "#8f4a00", dot: "#d97a00" },
  urgent: { label: "Urgent", tint: "#faeae9", ink: "#a8231a", dot: "#d02c1f" },
};

/** One row of the facts table: what it is, and its value. Both plain
 * text; a newline in the value is a line break. */
export interface OpsFact {
  label: string;
  value: string;
}

export interface OperationsEmailInput {
  severity: OpsSeverity;
  /** What the chip says, when the severity's own name is not the word:
   * a recovery is "info", and reads better as "Resolved". */
  chip?: string;
  /** The headline. The subject, without its "[Neoxify]" tag. */
  title: string;
  /** What, where, since when, how sure, what to do. */
  facts?: OpsFact[];
  /** The detail under the table. Plain text, paragraphs separated by a
   * blank line; a line starting "- " is a list item. */
  body?: string;
  /** The page of the admin panel that answers this mail. */
  panel?: { path: string; label: string };
  /** A closing line in small type. */
  note?: string;
}

function chip(severity: OpsSeverity, label: string | undefined): string {
  const tone = SEVERITY[severity];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;">
    <tr>
      <td class="nx-chip-${severity}" bgcolor="${tone.tint}" style="padding:4px 12px 4px 10px;border-radius:999px;background:${tone.tint};color:${tone.ink};font-size:12px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;line-height:1.5;"><span style="color:${tone.dot};">&#9679;</span>&nbsp;${escapeAttribute(label ?? tone.label)}</td>
    </tr>
  </table>`;
}

function factsTable(facts: OpsFact[]): string {
  const rows = facts
    .map((fact, index) => {
      const rule = index === facts.length - 1 ? "" : `border-bottom:1px solid ${RULE};`;
      return `<tr>
      <td class="nx-ink2 nx-rule" width="30%" valign="top" style="width:30%;padding:10px 12px 10px 16px;${rule}font-size:13px;line-height:1.5;color:${INK_2};text-align:left;">${escapeAttribute(fact.label)}</td>
      <td class="nx-ink nx-rule" valign="top" style="padding:10px 16px 10px 0;${rule}font-size:14px;line-height:1.5;color:${INK};text-align:left;word-break:break-word;overflow-wrap:anywhere;">${escapeAttribute(fact.value).replace(/\n/g, "<br>")}</td>
    </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="nx-well" style="margin:0 0 20px 0;width:100%;background:${PEARL};border:1px solid ${RULE};border-radius:${R_WELL}px;border-collapse:separate;">
    ${rows}
  </table>`;
}

/** Plain text to paragraphs. "- " at the start of a line becomes a
 * bullet: the pages are written as text first, for the webhook and the
 * plain part, and their lists should not arrive as hyphens, nor their
 * section headings ("Evidence:") in the same weight as what is under
 * them. */
function opsBody(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((para) => para.trim().length > 0)
    .map((para) => {
      const lines = escapeAttribute(para)
        .split("\n")
        .map((line) => {
          if (line.startsWith("- ")) return `&bull;&nbsp;${line.slice(2)}`;
          // A line that ends in a colon heads what follows it.
          return line.endsWith(":") ? `<span style="font-weight:600;">${line}</span>` : line;
        })
        .join("<br>");
      return `<p class="nx-ink" style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:${INK};text-align:left;word-break:break-word;overflow-wrap:anywhere;">${lines}</p>`;
    })
    .join("");
}

/** A button to an address. Exported for `fillBrandSlots`, which is the
 * only place that knows where the panel is. Staff mail is English, so
 * it is always left-to-right. */
function panelButton(url: string, label: string): string {
  return button(styleFor("en"), escapeAttribute(url), escapeAttribute(label));
}

/** The staff shell: the same card, compact, and always English.
 *
 * Not the customer shell with different words. It carries no account
 * notice and no way to unsubscribe -- an operator who unsubscribes from
 * their own outage alerts has silently turned monitoring off -- and no
 * community links, which are for customers.
 *
 * Reads top to bottom as: how serious, what happened, the facts, the
 * evidence, where to go. Everything passed in is plain text and escaped
 * here; a server name or an email address with a `<` in it cannot become
 * markup in the owner's inbox. */
export function operationsEmail(input: OperationsEmailInput): string {
  const s = styleFor("en");
  const title = escapeAttribute(input.title);
  // The inbox line under the subject: the first facts, since they are
  // the answer to "do I need to open this", or else the opening words.
  const lead = input.facts?.length
    ? input.facts
        .slice(0, 3)
        .map((fact) => `${fact.label}: ${fact.value}`)
        .join(" · ")
    : input.body || input.title;
  const preheader = escapeAttribute(lead.replace(/\s+/g, " ").slice(0, 160));
  const panel =
    input.panel && /^[a-z0-9/_-]+$/.test(input.panel.path) && /^[A-Za-z0-9 ]+$/.test(input.panel.label)
      ? `<!--neoxify:panel:${input.panel.path}|${input.panel.label}-->`
      : "";

  return frame({
    s,
    preheader,
    headerHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                  <tr>
                    <td style="text-align:left;">${wordmark(18)}</td>
                    <td class="nx-muted" style="text-align:right;font-size:11px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};">Operations</td>
                  </tr>
                </table>`,
    bodyHtml: `
        ${chip(input.severity, input.chip)}
        <h1 class="nx-ink nx-h1" style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:${INK};letter-spacing:-0.02em;text-align:left;line-height:1.3;">${title}</h1>
        ${input.facts?.length ? factsTable(input.facts) : ""}
        ${input.body ? opsBody(input.body) : ""}
        ${panel}
        ${input.note ? fineprint(s, escapeAttribute(input.note)) : ""}
      `,
    footerHtml: `<p class="nx-muted" style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;text-align:left;">Operations mail for the owners of this Neoxify panel.</p>`,
  });
}

/** A moment, as a person reads it: "2026-11-10 06:30 UTC". The text
 * part and the webhook keep the full ISO form, which is what gets
 * pasted into a query; the table is for reading, and there the seconds,
 * the T and the Z are noise that also wraps badly on a phone. Always
 * UTC, and says so. */
export function opsTime(at: Date | string): string {
  const iso = (typeof at === "string" ? new Date(at) : at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A staff mail's subject, as its headline: the "[Neoxify]" tag is for
 * the inbox list, and the header already says whose mail this is. */
export function opsTitle(subject: string): string {
  return subject.replace(/^\[Neoxify\]\s*/, "");
}

// ---------------------------------------------------------------------------
// Filling the slots
// ---------------------------------------------------------------------------

export interface BrandChrome {
  /** Where the logo images are served, no trailing slash. Absent when
   * the API has no public address: there is then nowhere to fetch the
   * mark from, and the header falls back to the wordmark alone -- a
   * broken-image icon next to the product name looks worse than no
   * image at all. */
  logoBaseUrl?: string;
  /** The admin panel's address, no trailing slash. Absent when it is
   * not known; staff mail then carries no button. */
  panelUrl?: string;
  /** Community links that are set, in the order shown. */
  links: { kind: BrandLinkKind; url: string }[];
}

export type BrandLinkKind = "website" | "discord" | "instagram" | "telegram";

/** The footer's link names. In Persian mail they are written in Persian:
 * three Latin words in a row at the foot of a Persian email read as a
 * part that was left untranslated, and they also lay out backwards --
 * Latin runs joined by dots keep their left-to-right order inside a
 * right-to-left line, so the first link lands last. */
const LINK_LABELS: Record<Locale, Record<BrandLinkKind, string>> = {
  en: { website: "Website", discord: "Discord", instagram: "Instagram", telegram: "Telegram" },
  fa: { website: "وب‌سایت", discord: "دیسکورد", instagram: "اینستاگرام", telegram: "تلگرام" },
};

/** The mark, twice: on its pearl plate, and on its smoked plate for dark
 * mode. Only one shows. The dark one is `display:none` until the <style>
 * block's dark rule swaps them, so a client that strips that block shows
 * the pearl plate -- which, being a plate, looks right on any background
 * a client's own dark mode produces. Word does not honour `display:none`
 * on an image, hence the conditional comment that keeps the second one
 * from Outlook altogether.
 *
 * The 2x file at 1x size, so it is sharp on a phone. `width`, `height`
 * and an empty `alt` hold the layout when images are blocked: the name
 * is already beside it as text, and saying it twice helps nobody. */
function logoHtml(base: string, rtl: boolean): string {
  const gap = rtl ? "margin:0 0 0 10px;" : "margin:0 10px 0 0;";
  const img = (variant: "light" | "dark", cls: string, display: string) =>
    `<img class="${cls}" src="${escapeAttribute(base)}/email-logo-${variant}-2x.png" width="40" height="40" alt="" ` +
    `style="display:${display};width:40px;height:40px;${gap}border:0;outline:none;vertical-align:middle;border-radius:12px;">`;
  return (
    img("light", "nx-logo-l", "inline-block") +
    `<!--[if !mso]><!-->${img("dark", "nx-logo-d", "none")}<!--<![endif]-->`
  );
}

function linksHtml(links: BrandChrome["links"], locale: Locale): string {
  const align = locale === "fa" ? "right" : "left";
  // Nothing set, nothing rendered -- not an empty row of separators.
  // Same rule the app's header follows: never show a way to reach us
  // that goes nowhere.
  if (links.length === 0) return "";
  const rendered = links
    .map(
      (link) =>
        `<a href="${escapeAttribute(link.url)}" class="nx-ink2" style="color:${INK_2};text-decoration:none;font-weight:600;">${LINK_LABELS[locale][link.kind]}</a>`,
    )
    // A middle dot rather than a table of buttons: this is a footer,
    // and it should not compete with the message above it.
    .join(`<span style="color:#b6bcc9;">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`);
  return `<p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;text-align:${align};">${rendered}</p>`;
}

/** Fills the slots a template left behind. Pure: EmailBrandService
 * supplies the runtime facts, and the preview script supplies its own.
 *
 * The direction is read back off the document rather than passed in,
 * because the slots are filled long after the template that knew it has
 * returned -- and the gap beside the logo has to be on the side the
 * wordmark is on. */
export function fillBrandSlots(html: string, chrome: BrandChrome): string {
  const rtl = html.includes('<html dir="rtl"');
  const logo = chrome.logoBaseUrl ? logoHtml(chrome.logoBaseUrl, rtl) : "";
  const links = linksHtml(chrome.links, rtl ? "fa" : "en");
  // Functions, not strings: a `$&` in an operator-entered link would
  // otherwise be read as a replacement pattern.
  return html
    .replace(BRAND_LOGO_SLOT, () => logo)
    .replace(BRAND_LINKS_SLOT, () => links)
    .replace(PANEL_SLOT, (_slot, path: string, label: string) =>
      chrome.panelUrl ? panelButton(`${chrome.panelUrl}${path}`, label) : "",
    );
}
