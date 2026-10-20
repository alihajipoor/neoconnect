import type { Page } from "../alerting/pager.service";
import type { BlockType, FamilyResult } from "./block-signals";

/** What a page says. English: it goes to the owner. Never an address --
 * the webhook may be a chat channel -- only the server's name. */

export interface IncidentView {
  nodeName: string;
  openedAt: Date;
  evidence: StoredEvidence;
}

/** The incident's evidenceJson, as written by BlockWatchService. */
export interface StoredEvidence {
  evaluatedAt: string;
  current: "SUSPECT" | "LIKELY_BLOCKED" | null;
  reason: string | null;
  since: Partial<Record<string, string>>;
  families: FamilyResult[];
  outage: string | null;
  blockType: BlockType | null;
  thinResidential: boolean;
  country: string;
}

const TYPE_WORDS: Record<BlockType, string> = {
  address: "the address or its port: connections from inside the country fail, from abroad they work",
  protocol: "some protocols on this server: others still carry for the same networks",
  tunnel: "the tunnels, not the address: connections open but carry nothing (handshake, name or upload filtering)",
};

const FOOTER =
  "Nothing has been changed automatically. Check the server yourself, then answer in the panel under Block watch: " +
  "Replace (you are moving it to a new server), Retire, Keep (it is fine, stop reminding me) or Snooze.";

function hoursSince(from: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 3_600_000));
}

function evidenceLines(e: StoredEvidence): string {
  const lines = e.families.filter((f) => f.firing).map((f) => `- ${f.summary}`);
  const quiet = e.families.filter((f) => !f.firing).map((f) => `- ${f.summary}`);
  let text = lines.join("\n");
  if (quiet.length) text += `\n\nNot firing:\n${quiet.join("\n")}`;
  return text;
}

function guess(e: StoredEvidence): string {
  return e.blockType ? `Best guess, not proof: it is ${TYPE_WORDS[e.blockType]}.` : "The kind of block is not clear from here.";
}

export function likelyBlockedPage(i: IncidentView, now: Date): Page {
  const where = i.evidence.country.toUpperCase();
  const since = i.openedAt.toISOString();
  return {
    subject: `[Neoxify] ${i.nodeName} is likely blocked from ${where}`,
    webhook: `[block] ${i.nodeName} is likely blocked from ${where} (since ${since}): ${i.evidence.reason ?? ""}`,
    context: { event: "block_likely", node: i.nodeName },
    text:
      `${i.nodeName} looks blocked from ${where}, first seen ${since} (about ${hoursSince(i.openedAt, now)} h ago).\n\n` +
      `Why this is a page: ${i.evidence.reason}.\n\n` +
      `Evidence:\n${evidenceLines(i.evidence)}\n\n` +
      `${guess(i.evidence)}\n\n${FOOTER}`,
  };
}

export function groupedPage(incidents: IncidentView[], pagedThisHour: number, now: Date): Page {
  const where = incidents[0]?.evidence.country.toUpperCase() ?? "";
  const names = incidents.map((i) => i.nodeName);
  const total = names.length + pagedThisHour;
  return {
    subject: `[Neoxify] ${total} servers look blocked from ${where} at once`,
    webhook: `[block] ${total} servers look blocked from ${where} at once: ${names.join(", ")}`,
    context: { event: "block_grouped", nodes: names },
    text:
      `${names.join(", ")} started looking blocked from ${where}` +
      (pagedThisHour ? `, after ${pagedThisHour} more paged within the hour` : "") +
      ` (${now.toISOString()}).\n\n` +
      "Several servers at once is more often an international cut, a fault on our side or a problem with the probe " +
      "service than separate blocks. Nothing has been switched or changed. Check before buying anything.\n\n" +
      incidents.map((i) => `${i.nodeName}: ${i.evidence.reason}\n${evidenceLines(i.evidence)}`).join("\n\n") +
      `\n\n${FOOTER}`,
  };
}

export function reminderPage(i: IncidentView, now: Date): Page {
  const where = i.evidence.country.toUpperCase();
  return {
    subject: `[Neoxify] Reminder: ${i.nodeName} still looks blocked from ${where}`,
    webhook: `[block] Reminder: ${i.nodeName} still looks blocked from ${where} (${hoursSince(i.openedAt, now)} h)`,
    context: { event: "block_reminder", node: i.nodeName },
    text:
      `${i.nodeName} has looked blocked from ${where} for about ${hoursSince(i.openedAt, now)} h and nobody has answered ` +
      `in the panel. This is the only reminder.\n\nLatest evidence:\n${evidenceLines(i.evidence)}\n\n${guess(i.evidence)}\n\n${FOOTER}`,
  };
}

export function recoveryPage(i: IncidentView & { closedAt: Date }, now: Date): Page {
  const where = i.evidence.country.toUpperCase();
  const hours = Math.max(1, Math.round((i.closedAt.getTime() - i.openedAt.getTime()) / 3_600_000));
  return {
    subject: `[Neoxify] ${i.nodeName}: no block signal any more`,
    webhook: `[block] ${i.nodeName}: block signals from ${where} cleared after ~${hours} h`,
    context: { event: "block_cleared", node: i.nodeName },
    text:
      `The signals that made ${i.nodeName} look blocked from ${where} have stopped, after about ${hours} h ` +
      `(${now.toISOString()}). The incident is closed. If you already replaced the server, there is nothing to do.`,
  };
}

export function digestPage(
  open: IncidentView[],
  cleared: (IncidentView & { closedAt: Date })[],
  calibrating: boolean,
  now: Date,
): Page {
  const where = (open[0] ?? cleared[0])?.evidence.country.toUpperCase() ?? "";
  const section = (i: IncidentView) =>
    `${i.nodeName} -- ${i.evidence.current === "LIKELY_BLOCKED" ? "LIKELY BLOCKED" : "suspect"} since ${i.openedAt.toISOString()}\n` +
    evidenceLines(i.evidence);
  const parts: string[] = [];
  if (calibrating) {
    parts.push(
      "Calibration: block verdicts go only to this digest for now; the reachability probe still pages as before. " +
        "Note any that were wrong.",
    );
  }
  if (open.length) parts.push(`Under watch:\n\n${open.map(section).join("\n\n")}`);
  if (cleared.length) parts.push(`Cleared since the last digest: ${cleared.map((i) => i.nodeName).join(", ")}`);
  return {
    subject: `[Neoxify] Block watch: ${open.length} server${open.length === 1 ? "" : "s"} under watch from ${where}`,
    webhook: `[block] Daily: ${open.length} under watch (${open.map((i) => i.nodeName).join(", ") || "none"}), ${cleared.length} cleared`,
    context: { event: "block_digest" },
    text: `${parts.join("\n\n")}\n\n(${now.toISOString()}) Nothing here has been changed automatically.`,
  };
}
