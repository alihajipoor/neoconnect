import { operationsEmail, opsTitle } from "../email/templates";

/**
 * Operator alert mail.
 *
 * Built on the operations shell (`operationsEmail`), not the customer
 * one. Everything a customer gets is localised through `Locale` and
 * carries an account notice and, on bulk mail, a way to stop it. This is
 * none of those things: it goes to staff, it is English because the
 * operator reads English, and it must not carry an unsubscribe link --
 * an operator who unsubscribes from their own outage alerts has silently
 * disabled monitoring.
 */

export interface OperatorMail {
  subject: string;
  html: string;
  text: string;
}

const PANEL = { path: "/reachability", label: "Open Reachability" };

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

  const html = operationsEmail({
    severity: "warning",
    title: opsTitle(subject),
    facts: [
      { label: "What", value: `No vantage point could open a TCP connection on port ${port}` },
      { label: "Where", value: `${nodeName}, seen from ${where}` },
      { label: "Since", value: `About ${minutes} minutes: ${consecutiveChecks} consecutive checks failed` },
      {
        label: "How sure",
        value:
          `Measured, but only a TCP connection from outside probes. Most likely the node's address is filtered. ` +
          `It can also be the host being down, or its firewall dropping ${port}.`,
      },
      { label: "What to do", value: "Check the node directly before assuming a block." },
    ],
    body:
      "The node's agent may still be reporting ONLINE. That is expected and not a contradiction: the agent " +
      "heartbeats outbound, so it keeps working while inbound connections from the country are being dropped.\n\n" +
      "The Reachability page shows which networks failed, broken down by operator.",
    panel: PANEL,
    note: "You will not get another mail about this node until it recovers.",
  });

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
  const subject = `[Neoxify] ${nodeName} is reachable from ${where} again`;

  const text = [
    `${nodeName} is answering from ${where} again, after about ${minutes} minutes.`,
    "",
    "No action needed. If this node keeps flapping, its address is worth rotating -- repeated short blocks are often a filter being tuned rather than a network fault.",
  ].join("\n");

  const html = operationsEmail({
    severity: "info",
    chip: "Resolved",
    title: opsTitle(subject),
    facts: [
      { label: "What", value: "Answering again" },
      { label: "Where", value: `${nodeName}, seen from ${where}` },
      { label: "Lasted", value: `About ${minutes} minutes` },
      { label: "What to do", value: "Nothing." },
    ],
    panel: PANEL,
    note:
      "If this node keeps flapping, its address is worth rotating: repeated short blocks are often a filter " +
      "being tuned rather than a network fault.",
  });

  return { subject, html, text };
}
