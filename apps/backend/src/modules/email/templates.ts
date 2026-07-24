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
 * gradient header with the NeoConnect mark, a white card, and a muted
 * footer. `preheader` is the short hidden preview text most mail clients
 * show next to the subject line in the inbox list. */
function shell({ preheader, bodyHtml }: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BG};font-family:${FONT_STACK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(139,92,246,0.12);">
            <tr>
              <td style="background-color:${PRIMARY};background-image:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 60%,#5b21b6 100%);padding:28px 32px;">
                <span style="font-size:22px;line-height:1;vertical-align:middle;">&#9889;</span>
                <span style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:0.2px;vertical-align:middle;margin-left:8px;">NeoConnect</span>
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
                  You're receiving this because you have a NeoConnect account. If something here looks wrong, ignore this email or reach out to support.
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

/** A prominent, letter-spaced token/code display -- used for both the
 * verification code and the password-reset code. */
function codeBlock(value: string): string {
  return `<div style="margin:4px 0 20px 0;padding:14px 18px;background:#f6f3ff;border:1px solid #e4dcfb;border-radius:10px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:15px;font-weight:600;letter-spacing:1px;color:${PRIMARY_DARK};word-break:break-all;">${value}</div>`;
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

export function welcomeEmail() {
  return {
    subject: "Welcome to NeoConnect",
    html: shell({
      preheader: "Your account is ready -- verify your email to get connected.",
      bodyHtml: `
        ${heading("Welcome aboard ⚡")}
        ${paragraph("Your NeoConnect account has been created.")}
        ${paragraph("A separate verification email is on its way -- confirm your address there before you can connect to the VPN.")}
      `,
    }),
    text: "Your NeoConnect account has been created. Check your inbox for a separate verification email -- you'll need to confirm your address before you can connect to the VPN.",
  };
}

export function verificationEmail(token: string) {
  const deepLink = `neoconnect://verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your NeoConnect email address",
    html: shell({
      preheader: "One quick step before you can connect.",
      bodyHtml: `
        ${heading("Verify your email")}
        ${paragraph("Confirm your address to activate your account. Open the NeoConnect app and enter this code:")}
        ${codeBlock(token)}
        ${button(deepLink, "Open in NeoConnect")}
        ${fineprint("This code expires in 24 hours. If you didn't create a NeoConnect account, you can ignore this email.")}
      `,
    }),
    text: `Confirm your email address to activate your NeoConnect account. Verification code: ${token} (expires in 24 hours). Or open: ${deepLink}`,
  };
}

export function passwordResetEmail(token: string) {
  const deepLink = `neoconnect://reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your NeoConnect password",
    html: shell({
      preheader: "Use this code to reset your password.",
      bodyHtml: `
        ${heading("Reset your password")}
        ${paragraph("A password reset was requested for your account. Enter this code in the app to continue:")}
        ${codeBlock(token)}
        ${button(deepLink, "Open in NeoConnect")}
        ${fineprint("This code expires in 30 minutes. If you didn't request this, you can safely ignore this email -- your password won't change.")}
      `,
    }),
    text: `A password reset was requested for your NeoConnect account. Code: ${token} (expires in 30 minutes). Or open: ${deepLink}. If you didn't request this, ignore this email.`,
  };
}

export function lowDataWarningEmail(remainingGb: number) {
  const remaining = remainingGb.toFixed(1);
  return {
    subject: "Your NeoConnect data is running low",
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
    subject: "Your NeoConnect subscription is expiring soon",
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
  });
}
