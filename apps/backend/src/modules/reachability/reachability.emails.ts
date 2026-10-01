/**
 * Operator alert mail.
 *
 * Deliberately not in modules/email/templates.ts. Everything there is
 * customer-facing and localised through `Locale`, and is rendered inside
 * the brand shell with an unsubscribe footer. This is none of those
 * things: it goes to staff, it is English because the operator reads
 * English, and it must not carry an unsubscribe link -- an operator who
 * unsubscribes from their own outage alerts has silently disabled
 * monitoring.
 */

const WRAP =
  'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface OperatorMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * A node has stopped answering from the probe country.
 *
 * Says what was measured and what was not. "Unreachable from Iran" is a
 * statement about a TCP connection from eight Iranian networks -- it is
 * not proof of deliberate filtering, and the mail says so, because an
 * operator who is told "filtered" and finds a dead host instead stops
 * believing the next one.
 */
export function reachabilityAlertEmail(
  nodeName: string,
  country: string,
  consecutiveChecks: number,
  port: number,
): OperatorMail {
  const where = country.toUpperCase();
  const name = escapeHtml(nodeName);
  const minutes = consecutiveChecks * 30;

  const subject = `[Neoxify] ${nodeName} is unreachable from ${where}`;

  const text = [
    `${nodeName} has failed ${consecutiveChecks} consecutive reachability checks from ${where} (about ${minutes} minutes).`,
    "",
    `No vantage point in ${where} could open a TCP connection to the node on port ${port}.`,
    "",
    "The node's agent may still be reporting ONLINE. That is expected and is not a contradiction: the agent heartbeats outbound, so it keeps working while inbound connections from the country are being dropped.",
    "",
    `Most likely this is filtering of the node's address. It can also be the host being down, or its firewall dropping ${port}. Check the node directly before assuming a block.`,
    "",
    "Panel -> Iran Reachability shows which networks failed, broken down by operator.",
    "",
    "You will not get another mail about this node until it recovers.",
  ].join("\n");

  const html = `<div style="${WRAP}">
  <p style="margin:0 0 14px"><strong>${name}</strong> has failed <strong>${consecutiveChecks}</strong> consecutive reachability checks from ${where} (about ${minutes} minutes).</p>
  <p style="margin:0 0 14px">No vantage point in ${where} could open a TCP connection to the node on port ${port}.</p>
  <p style="margin:0 0 14px">The node's agent may still be reporting <code>ONLINE</code>. That is expected and not a contradiction: the agent heartbeats outbound, so it keeps working while inbound connections from the country are being dropped.</p>
  <p style="margin:0 0 14px">Most likely this is filtering of the node's address. It can also be the host being down, or its firewall dropping ${port}. Check the node directly before assuming a block.</p>
  <p style="margin:0 0 14px"><strong>Panel &rarr; Iran Reachability</strong> shows which networks failed, broken down by operator.</p>
  <p style="margin:0;color:#666;font-size:13px">You will not get another mail about this node until it recovers.</p>
</div>`;

  return { subject, html, text };
}

/** The node answers again. Sent so that a resolved incident is as
 * visible as an opened one -- otherwise the only way to learn an outage
 * ended is to go and look. */
export function reachabilityRecoveryEmail(
  nodeName: string,
  country: string,
  minutes: number,
): OperatorMail {
  const where = country.toUpperCase();
  const name = escapeHtml(nodeName);
  const subject = `[Neoxify] ${nodeName} is reachable from ${where} again`;

  const text = [
    `${nodeName} is answering from ${where} again, after about ${minutes} minutes.`,
    "",
    "No action needed. If this node keeps flapping, its address is worth rotating -- repeated short blocks are often a filter being tuned rather than a network fault.",
  ].join("\n");

  const html = `<div style="${WRAP}">
  <p style="margin:0 0 14px"><strong>${name}</strong> is answering from ${where} again, after about ${minutes} minutes.</p>
  <p style="margin:0;color:#666;font-size:13px">No action needed. If this node keeps flapping, its address is worth rotating &mdash; repeated short blocks are often a filter being tuned rather than a network fault.</p>
</div>`;

  return { subject, html, text };
}
