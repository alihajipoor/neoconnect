/** Branded HTML email bodies -- matches the panel's dark violet/cyan
 * visual language (see the panel's Tailwind theme + [[feedback_ui_design_quality]]),
 * translated into an email-safe layout: table-based structure, inline
 * styles only (no <style> block, no flexbox/grid), web-safe font stack --
 * this is what actually survives Outlook/Gmail's aggressive CSS
 * stripping, not a fully modern stylesheet. Each template returns both an
 * html and a text body (nodemailer sends both; text is the fallback for
 * clients that can't/won't render html). */

const PRIMARY = "#8b5cf6"; // violet, matches the panel's primary accent
const PRIMARY_DARK = "#7c3aed";
const ACCENT = "#22d3ee"; // cyan, matches the panel's secondary/highlight accent
const INK = "#1e1b2e";
const MUTED = "#6b7280";
const BORDER = "#eceaf5";
const BG = "#f4f4fa";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Wraps a template's body content in the shared branded shell: a
 * gradient header with the Neoxify mark, a white card, and a muted
 * footer. `preheader` is the short hidden preview text most mail clients
 * show next to the subject line in the inbox list. */
function shell({
  preheader,
  bodyHtml,
  footerHtml,
}: {
  preheader: string;
  bodyHtml: string;
  /** Replaces the default closing sentence. Bulk mail needs to say how
   * to stop receiving it; transactional mail must not, since there is
   * nothing to opt out of. */
  footerHtml?: string;
}): string {
  return `<!doctype html>
<html>
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
  <body style="margin:0;padding:0;background:${BG};font-family:${FONT_STACK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(139,92,246,0.12);">
            <tr>
              <td style="background-color:${PRIMARY};background-image:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,#5b21b6 100%);padding:28px 32px;">
                <span style="font-size:22px;line-height:1;vertical-align:middle;">&#9889;</span>
                <span style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:0.2px;vertical-align:middle;margin-left:8px;">Neoxify</span>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 32px 32px;color:${INK};font-size:15px;line-height:1.65;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid ${BORDER};background:#fbfaff;">
                <p style="margin:0;font-size:12px;color:${MUTED};">
                  You're receiving this because you have a Neoxify account.
                  ${footerHtml ?? "If something here looks wrong, you can safely ignore this email."}
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

function heading(text: string): string {
  return `<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:${INK};">${text}</h1>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px 0;color:${INK};">${text}</p>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
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
 * allowed to shrink rather than grow to fit unbreakable content. */
function codeBlock(value: string): string {
  return `<div style="margin:4px 0 20px 0;padding:14px 18px;max-width:100%;background:#f6f3ff;border:1px solid #e4dcfb;border-radius:10px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:14px;font-weight:600;color:${PRIMARY_DARK};word-break:break-all;overflow-wrap:anywhere;white-space:normal;">${value}</div>`;
}

/** A large, widely-spaced short code for the actual human to type by
 * hand -- added 2026-07-24 after live testing showed a raw JWT (what
 * codeBlock() above was originally used for here) is both unusable to
 * type and prone to overflowing the email's layout. Real digits are
 * separated by literal spaces, not just CSS letter-spacing, since some
 * email clients strip letter-spacing -- this is the standard OTP-email
 * technique for a reason. */
function bigCode(value: string): string {
  const spaced = value.split("").join(" ");
  return `<div style="margin:4px 0 20px 0;padding:18px 12px;max-width:100%;background:#f6f3ff;border:1px solid #e4dcfb;border-radius:12px;text-align:center;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:30px;font-weight:800;letter-spacing:4px;color:${PRIMARY_DARK};word-break:break-all;">${spaced}</div>`;
}

function fineprint(text: string): string {
  return `<p style="margin:0;font-size:13px;color:${MUTED};">${text}</p>`;
}

/** A small colored stat pill -- used to make a number (GB remaining,
 * days remaining) the visual focal point rather than burying it in a
 * sentence. */
function statPill(value: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px 0;">
    <tr>
      <td style="padding:16px 22px;background:linear-gradient(135deg,#f6f3ff,#ecfeff);border:1px solid ${BORDER};border-radius:12px;">
        <div style="font-size:26px;font-weight:800;color:${PRIMARY_DARK};line-height:1.1;">${value}</div>
        <div style="font-size:12px;font-weight:600;color:${ACCENT === "#22d3ee" ? "#0891b2" : MUTED};text-transform:uppercase;letter-spacing:0.6px;margin-top:2px;">${label}</div>
      </td>
    </tr>
  </table>`;
}

/** `publicApiUrl` is where this API answers from a customer's browser.
 *
 * When it's set the button points at an https:// page that verifies and
 * then offers to open the app. Without it the button falls back to the
 * raw `neoconnect://` link, which webmail clients strip -- Gmail and
 * Yahoo both rendered it unclickable, confirmed on a real account. The
 * 6-digit code works in every case, which is why it stays the most
 * prominent element rather than the button. */
export function verificationEmail(token: string, code: string, publicApiUrl?: string) {
  const deepLink = `neoconnect://verify-email?token=${encodeURIComponent(token)}`;
  const link = publicApiUrl
    ? `${publicApiUrl.replace(/\/$/, "")}/customer-auth/verify-email/open?token=${encodeURIComponent(token)}`
    : deepLink;

  return {
    subject: "Welcome to Neoxify -- verify your email",
    html: shell({
      preheader: `Your verification code is ${code}.`,
      bodyHtml: `
        ${heading("Welcome aboard ⚡")}
        ${paragraph("Your Neoxify account is created. One step left -- enter this code in the app to activate it:")}
        ${bigCode(code)}
        ${fineprint("Or just click here:")}
        ${button(link, "Verify my email")}
        ${fineprint("This code expires in 24 hours. If you didn't create a Neoxify account, you can ignore this email.")}
      `,
    }),
    text: `Welcome to Neoxify. Your verification code: ${code} (expires in 24 hours). Or open: ${link}`,
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
export function passwordResetEmail(code: string) {
  return {
    subject: "Reset your Neoxify password",
    html: shell({
      preheader: `Your password reset code is ${code}.`,
      bodyHtml: `
        ${heading("Reset your password")}
        ${paragraph("A password reset was requested for your account. Enter this code in the app to continue:")}
        ${bigCode(code)}
        ${fineprint("This code expires in 30 minutes. If you didn't request this, you can safely ignore this email -- your password won't change.")}
      `,
    }),
    text: `A password reset was requested for your Neoxify account. Your code: ${code} (expires in 30 minutes). If you didn't request this, ignore this email.`,
  };
}

export function lowDataWarningEmail(remainingGb: number) {
  const remaining = remainingGb.toFixed(1);
  return {
    subject: "Your Neoxify data is running low",
    html: shell({
      preheader: `About ${remaining} GB left on your current plan.`,
      bodyHtml: `
        ${heading("Data running low")}
        ${statPill(`${remaining} GB`, "remaining this period")}
        ${paragraph("Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.")}
      `,
    }),
    text: `You have about ${remaining} GB of data remaining on your current plan. Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.`,
  };
}

export function expiringSoonEmail(daysRemaining: number) {
  const unit = daysRemaining === 1 ? "day" : "days";
  return {
    subject: "Your Neoxify subscription is expiring soon",
    html: shell({
      preheader: `Your subscription expires in about ${daysRemaining} ${unit}.`,
      bodyHtml: `
        ${heading("Subscription expiring soon")}
        ${statPill(`${daysRemaining} ${unit}`, "until expiry")}
        ${paragraph("Renew before it expires to keep your VPN connection active without interruption.")}
      `,
    }),
    text: `Your subscription expires in about ${daysRemaining} day(s). Renew before it expires to keep your VPN connection active without interruption.`,
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
export function referralFriendJoinedEmail(maskedEmail: string, monthsToGo: number | null) {
  const progress =
    monthsToGo === null
      ? paragraph("Keep inviting friends to earn free months of Neoxify.")
      : paragraph(
          `You're ${monthsToGo} paid ${monthsToGo === 1 ? "month" : "months"} away from your next free month.`,
        );

  return {
    subject: "Someone joined Neoxify with your invite",
    html: shell({
      preheader: `${maskedEmail} just activated their account.`,
      bodyHtml: `
        ${heading("Your invite worked")}
        ${statPill(maskedEmail, "just activated their account")}
        ${progress}
      `,
    }),
    text: `${maskedEmail} just activated their Neoxify account using your invite.${
      monthsToGo === null ? "" : ` You are ${monthsToGo} paid month(s) away from your next free month.`
    }`,
  };
}

/** Sent when a free month has actually been granted -- after the
 * subscription exists, never before. Promising a reward that then fails
 * to provision would be worse than a delayed email. */
export function referralRewardEmail(days: number, planName: string) {
  return {
    subject: "You've earned free Neoxify time",
    html: shell({
      preheader: `${days} free days have been added to your account.`,
      bodyHtml: `
        ${heading("Your free time is ready")}
        ${statPill(`${days} days`, `free on ${planName}`)}
        ${paragraph("Thanks for spreading the word. It's already on your account -- open Neoxify and connect as usual.")}
      `,
    }),
    text: `You have earned ${days} free days of Neoxify on ${planName}, thanks to the friends you invited. It is already active on your account.`,
  };
}

/** Used by AnnouncementsProcessor to wrap an admin-composed broadcast in
 * the same branded shell -- so a manual "server maintenance tonight"
 * notice looks as polished as every automated trigger above, not a bare
 * unstyled paragraph. */
export function announcementEmail(body: string) {
  return shell({
    preheader: body.slice(0, 120),
    bodyHtml: body
      .split(/\n{2,}/)
      .map((para) => paragraph(para.replace(/\n/g, "<br>")))
      .join(""),
    // The visible half of the opt-out. EmailService sets the
    // List-Unsubscribe header, because it knows the from-address; this
    // line is for the human, who does not read headers.
    //
    // Worded as a reply because that is what actually happens. There is
    // no unsubscribe endpoint yet, and a link that does nothing is worse
    // than an instruction that works.
    footerHtml:
      'This is an announcement from Neoxify. To stop receiving them, reply with "Unsubscribe".',
  });
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
 */
export function supportReplyEmail(subject: string, body: string) {
  const escaped = escapeHtml(body);
  return {
    subject: `Re: ${subject}`,
    html: shell({
      preheader: body.slice(0, 120),
      bodyHtml: `
        ${heading("Support replied")}
        ${escaped
          .split(/\n{2,}/)
          .map((para) => paragraph(para.replace(/\n/g, "<br>")))
          .join("")}
        ${fineprint("Reply from inside the Neoxify app to continue the conversation.")}
      `,
    }),
    text: `${body}\n\n--\nReply from inside the Neoxify app to continue the conversation.`,
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
 */
export function invoiceIssuedEmail(params: {
  invoiceNumber: string;
  planName: string;
  amountUsd: string;
  currency: string;
  documentUrl?: string;
}) {
  const amount = `$${params.amountUsd} ${params.currency.toUpperCase()}`;
  return {
    subject: `Your Neoxify receipt (${params.invoiceNumber})`,
    html: shell({
      preheader: `${amount} for ${params.planName}.`,
      bodyHtml: `
        ${heading("Thanks for your payment")}
        ${paragraph(`We've received ${amount} for your ${params.planName} subscription. It's active now.`)}
        ${codeBlock(params.invoiceNumber)}
        ${params.documentUrl ? button(params.documentUrl, "View invoice") : ""}
        ${fineprint("Keep this for your records. You can view or print your invoices any time from the app.")}
      `,
    }),
    text: `Payment received: ${amount} for ${params.planName}. Invoice ${params.invoiceNumber}.${
      params.documentUrl ? ` View it: ${params.documentUrl}` : ""
    }`,
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
  invoiceNumber: string;
  amountUsd: string;
  currency: string;
  documentUrl?: string;
}) {
  const amount = `$${params.amountUsd} ${params.currency.toUpperCase()}`;
  return {
    subject: `Unpaid invoice ${params.invoiceNumber}`,
    html: shell({
      preheader: `${amount} is still outstanding.`,
      bodyHtml: `
        ${heading("This invoice is still unpaid")}
        ${paragraph(`We haven't received ${amount} for invoice ${params.invoiceNumber} yet.`)}
        ${params.documentUrl ? button(params.documentUrl, "View invoice") : ""}
        ${fineprint("If you've already paid, it may still be confirming -- crypto payments can take a while, and this will clear on its own. Otherwise, reach out and we'll help.")}
      `,
    }),
    text: `Invoice ${params.invoiceNumber} for ${amount} is unpaid.${
      params.documentUrl ? ` View it: ${params.documentUrl}` : ""
    }`,
  };
}
