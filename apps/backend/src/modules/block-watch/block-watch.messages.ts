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
  /** With nothing firing: whether the server is shown working again (and
   * so on its way to clearing), or the incident is held for want of
   * evidence either way. Null while anything fires. */
  clearing?: string | null;
}

const TYPE_WORDS: Record<BlockType, string> = {
  address: "the address or its port: connections from inside the country fail, from abroad they work",
  protocol: "some protocols on this server: others still carry for the same networks",
  tunnel: "the tunnels, not the address: connections open but carry nothing (handshake, name or upload filtering)",
};

const FOOTER =
  "Nothing has been changed automatically. Check the server yourself, then answer in the panel under Block watch: " +
  "Replace (once it has its new address), Retire, Keep (it is fine, stop reminding me) or Snooze.";

function hoursSince(from: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 3_600_000));
}

function evidenceLines(e: StoredEvidence): string {
  const lines = e.families.filter((f) => f.firing).map((f) => `- ${f.summary}`);
  const quiet = e.families.filter((f) => !f.firing).map((f) => `- ${f.summary}`);
  let text = lines.join("\n");
  if (quiet.length) text += `${text ? "\n\n" : ""}Not firing:\n${quiet.join("\n")}`;
  return text;
}

function guess(e: StoredEvidence): string {
  return e.blockType ? `Best guess, not proof: it is ${TYPE_WORDS[e.blockType]}.` : "The kind of block is not clear from here.";
}

/** Why a page is a page. The evidence's own reason; a page is sent only
 * while the latest evaluation says likely, so this is the fallback for
 * a record written some other way. */
function reasonOf(e: StoredEvidence): string {
  return e.reason ?? "the evidence reached \"likely blocked\"";
}

export function likelyBlockedPage(i: IncidentView, now: Date): Page {
  const where = i.evidence.country.toUpperCase();
  const since = i.openedAt.toISOString();
  return {
    subject: `[Neoxify] ${i.nodeName} is likely blocked from ${where}`,
    webhook: `[block] ${i.nodeName} is likely blocked from ${where} (since ${since}): ${reasonOf(i.evidence)}`,
    context: { event: "block_likely", node: i.nodeName },
    text:
      `${i.nodeName} looks blocked from ${where}, first seen ${since} (about ${hoursSince(i.openedAt, now)} h ago).\n\n` +
      `Why this is a page: ${reasonOf(i.evidence)}.\n\n` +
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
      incidents.map((i) => `${i.nodeName}: ${reasonOf(i.evidence)}\n${evidenceLines(i.evidence)}`).join("\n\n") +
      `\n\n${FOOTER}`,
  };
}

/** One reminder for every incident that is due one this evaluation. */
export function remindersPage(incidents: IncidentView[], now: Date): Page {
  const where = incidents[0]?.evidence.country.toUpperCase() ?? "";
  if (incidents.length === 1) {
    const [i] = incidents;
    return {
      subject: `[Neoxify] Reminder: ${i.nodeName} still looks blocked from ${where}`,
      webhook: `[block] Reminder: ${i.nodeName} still looks blocked from ${where} (${hoursSince(i.openedAt, now)} h)`,
      context: { event: "block_reminder", nodes: [i.nodeName] },
      text:
        `${i.nodeName} has looked blocked from ${where} for about ${hoursSince(i.openedAt, now)} h and nobody has answered ` +
        `in the panel. This is the only reminder.\n\nLatest evidence:\n${evidenceLines(i.evidence)}\n\n${guess(i.evidence)}\n\n${FOOTER}`,
    };
  }
  const names = incidents.map((i) => i.nodeName);
  return {
    subject: `[Neoxify] Reminder: ${incidents.length} servers still look blocked from ${where}`,
    webhook: `[block] Reminder: still look blocked from ${where}: ${names.join(", ")}`,
    context: { event: "block_reminder", nodes: names },
    text:
      `These have looked blocked from ${where} for a day or more and nobody has answered in the panel. ` +
      "This is the only reminder for each.\n\n" +
      incidents
        .map((i) => `${i.nodeName} (about ${hoursSince(i.openedAt, now)} h)\n${evidenceLines(i.evidence)}`)
        .join("\n\n") +
      `\n\n${FOOTER}`,
  };
}

/** One notice for every paged incident that cleared since the last. */
export function recoveriesPage(incidents: (IncidentView & { closedAt: Date })[], now: Date): Page {
  const where = incidents[0]?.evidence.country.toUpperCase() ?? "";
  const hoursOf = (i: IncidentView & { closedAt: Date }) =>
    Math.max(1, Math.round((i.closedAt.getTime() - i.openedAt.getTime()) / 3_600_000));
  const why = (i: IncidentView) => i.evidence.clearing ?? "the server is shown working again";
  if (incidents.length === 1) {
    const [i] = incidents;
    return {
      subject: `[Neoxify] ${i.nodeName} works from ${where} again`,
      webhook: `[block] ${i.nodeName}: working from ${where} again after ~${hoursOf(i)} h`,
      context: { event: "block_cleared", nodes: [i.nodeName] },
      text:
        `${i.nodeName} is shown working from ${where} again after about ${hoursOf(i)} h (${now.toISOString()}): ${why(i)}. ` +
        "The incident is closed. If you already replaced the server, there is nothing to do.",
    };
  }
  const names = incidents.map((i) => i.nodeName);
  return {
    subject: `[Neoxify] ${incidents.length} servers work from ${where} again`,
    webhook: `[block] working from ${where} again: ${names.join(", ")}`,
    context: { event: "block_cleared", nodes: names },
    text:
      `These are shown working from ${where} again (${now.toISOString()}); their incidents are closed:\n\n` +
      incidents.map((i) => `- ${i.nodeName}, after about ${hoursOf(i)} h: ${why(i)}`).join("\n") +
      "\n\nIf you already replaced any of them, there is nothing to do.",
  };
}

export interface DigestParts {
  open: IncidentView[];
  cleared: (IncidentView & { closedAt: Date })[];
  /** Likely blocks whose page reached nobody, after every try. */
  undelivered: (IncidentView & { pageError: string | null })[];
  /** Incidents that had cleared and came back within the reopen window;
   * not paged again. */
  reopened: IncidentView[];
  /** Servers whose reachability alert was held because an incident here
   * already covers them. */
  heldProbeAlerts: string[];
  /** Nodes that failed the data check from a box inside the country on at
   * least half of the last day's checks (inside-probe.ts). */
  inside?: string[];
  calibrating: boolean;
  country: string;
}

export function digestPage(parts: DigestParts, now: Date): Page {
  const { open, cleared, undelivered, reopened, heldProbeAlerts, calibrating } = parts;
  const where = parts.country.toUpperCase();
  const section = (i: IncidentView) =>
    `${i.nodeName} -- ${i.evidence.current === "LIKELY_BLOCKED" ? "LIKELY BLOCKED" : i.evidence.current === null ? "quiet" : "suspect"} since ${i.openedAt.toISOString()}\n` +
    (i.evidence.clearing ? `${i.evidence.clearing}\n` : "") +
    evidenceLines(i.evidence);
  const sections: string[] = [];
  if (calibrating) {
    sections.push(
      "Calibration: block verdicts go only to this digest for now; the reachability probe still pages as before. " +
        "Note any that were wrong.",
    );
  }
  if (undelivered.length) {
    sections.push(
      "Pages that reached nobody (webhook and mail both failed, every try):\n\n" +
        undelivered.map((i) => `${section(i)}\nDelivery: ${i.pageError ?? "unknown"}`).join("\n\n"),
    );
  }
  if (reopened.length) {
    sections.push(
      "Looked clear, then came back (the same incident, re-opened; not paged again):\n\n" + reopened.map(section).join("\n\n"),
    );
  }
  if (open.length) sections.push(`Under watch:\n\n${open.map(section).join("\n\n")}`);
  if (cleared.length) sections.push(`Cleared since the last digest: ${cleared.map((i) => i.nodeName).join(", ")}`);
  if (parts.inside?.length) {
    sections.push(
      "From inside the country, the last 24 hours (256 KB down and up through each server's address):\n\n" +
        parts.inside.join("\n"),
    );
  }
  if (heldProbeAlerts.length) {
    sections.push(
      `Reachability alerts not sent separately, because the block watch already has the server open: ${heldProbeAlerts.join(", ")}`,
    );
  }
  const watching = open.length + undelivered.length + reopened.length;
  return {
    subject: `[Neoxify] Block watch: ${watching} server${watching === 1 ? "" : "s"} under watch from ${where}`,
    webhook:
      `[block] Daily: ${watching} under watch (${[...undelivered, ...reopened, ...open].map((i) => i.nodeName).join(", ") || "none"}), ` +
      `${cleared.length} cleared`,
    context: { event: "block_digest" },
    text: `${sections.join("\n\n")}\n\n(${now.toISOString()}) Nothing here has been changed automatically.`,
  };
}
