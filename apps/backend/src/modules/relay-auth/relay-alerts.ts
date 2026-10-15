/** Operator mail for relay alerts. English and unbranded, like the
 * reachability alerts (see modules/reachability/reachability.emails.ts
 * for why: it goes to staff, and must carry no unsubscribe link). */

const WRAP =
  "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function relayOperatorMail(subject: string, text: string) {
  return {
    subject: `[Neoxify] ${subject}`,
    text,
    html: `<div style="${WRAP}"><p style="margin:0 0 14px"><strong>${escapeHtml(subject)}</strong></p><p style="margin:0">${escapeHtml(text)}</p></div>`,
  };
}
