import { operationsEmail, type OperationsEmailInput } from "../email/templates";

/** Operator mail for relay alerts. English, on the operations shell like
 * the reachability alerts (see modules/reachability/reachability.emails.ts
 * for why: it goes to staff, and must carry no unsubscribe link).
 *
 * `text` is the whole message, and is the plain part as it stands.
 * `mail` is how the html sets it out; without it the html is the text. */
export function relayOperatorMail(
  subject: string,
  text: string,
  mail?: Omit<OperationsEmailInput, "title">,
) {
  return {
    subject: `[Neoxify] ${subject}`,
    text,
    html: operationsEmail({ severity: "info", body: text, ...mail, title: subject }),
  };
}

/** What the traffic detector measured, as rows for the mail's table. */
export function relayReadingFacts(reading: { ir: number; irMedian: number; other: number; otherMedian: number }) {
  return [
    { label: "Iran, last 30 min", value: `${reading.ir} requests on the normal routes (7-day median ${reading.irMedian})` },
    { label: "Everyone else", value: `${reading.other} requests (median ${reading.otherMedian})` },
  ];
}

/** Where the intranet is declared. */
export const RELAY_PANEL = { path: "/settings/relay", label: "Open Relay settings" };
