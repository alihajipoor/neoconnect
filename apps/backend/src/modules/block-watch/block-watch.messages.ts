import type { Page } from "../alerting/pager.service";
import { opsTime } from "../email/templates";
import { formatBytes, type BlockType, type FamilyResult } from "./block-signals";

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
  /** Over the last day, customers in the country whose apps dialled the
   * server: how many got data through it, how many did not. Counts only. */
  reports24h?: { through: number; failed: number };
}

const TYPE_WORDS: Record<BlockType, string> = {
  address: "the address or its port: connections from inside the country fail, from abroad they work",
  protocol: "some protocols on this server: others still carry for the same networks",
  tunnel: "the tunnels, not the address: connections open but carry nothing (handshake, name or upload filtering)",
};

const FOOTER =
  "Nothing has been changed automatically. Check the server yourself, then answer in the panel under Block watch: " +
  "Replace (once it has its new address), Retire, Keep (it is fine, stop reminding me) or Snooze.";

/** The html mail's own parts (Page.mail): the same facts as the text,
 * set out as a table, with the panel page that answers them. */
const WHAT_TO_DO =
  "Check the server yourself, then answer under Block watch: Replace (once it has its new address), Retire, " +
  "Keep (it is fine, stop reminding me) or Snooze.";
const UNCHANGED = "Nothing has been changed automatically.";
/** An early notice offers no Replace or Retire: it is one signal, and the
 * server may well be carrying its customers (netherlands-1, 2026-11-14). */
const NOTICE_TO_DO = "Check the server from inside if you can; there is nothing to answer yet. Nothing has been changed automatically.";
const PANEL = { path: "/block-watch", label: "Open Block watch" };

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

/** Said in so many words when our own boxes inside the country raised
 * it: that is the check the owner can repeat himself. Never an address. */
function insideNote(e: StoredEvidence): string {
  const inside = e.families.find((f) => f.family === "inside" && f.firing);
  if (!inside) return "";
  const what =
    inside.lostTcp === false
      ? "they connect to this server but no data moves, while in the same checks they still moved data to other servers"
      : "they could not open a connection to this server, while in the same checks they still reached the other servers";
  return `Raised by our own boxes inside the country: ${what}${inside.scope ? ` (${inside.scope.text})` : ""}.`;
}

/** What the latest evaluation reads, for a message about an incident
 * whose strongest verdict may be older than it. */
function readingNow(e: StoredEvidence): string {
  if (e.outage) return "an outage, not a block";
  if (e.current === "LIKELY_BLOCKED") return "likely blocked";
  if (e.current === "SUSPECT") return "suspect (it was likely blocked earlier)";
  return "quiet (nothing fires; it was likely blocked earlier)";
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
      (insideNote(i.evidence) ? `${insideNote(i.evidence)}\n\n` : "") +
      `Evidence:\n${evidenceLines(i.evidence)}\n\n` +
      `${guess(i.evidence)}\n\n${FOOTER}`,
    mail: {
      severity: "urgent",
      facts: [
        { label: "What", value: "Likely blocked" },
        { label: "Where", value: `${i.nodeName}, seen from ${where}` },
        { label: "Since", value: `${opsTime(i.openedAt)} (about ${hoursSince(i.openedAt, now)} h ago)` },
        {
          label: "How sure",
          value: `Likely, not proven: ${reasonOf(i.evidence)}. ${insideNote(i.evidence) ? `${insideNote(i.evidence)} ` : ""}${guess(i.evidence)}`,
        },
        { label: "What to do", value: WHAT_TO_DO },
      ],
      body: `Evidence:\n${evidenceLines(i.evidence)}`,
      panel: PANEL,
      note: UNCHANGED,
    },
  };
}

/** The server's own traffic over the last day against its usual day, in
 * words, from the stored bytes reading. */
function trafficLine(e: StoredEvidence): string {
  const b = e.families.find((f) => f.family === "bytes")?.bytes;
  if (!b) return "Server's own traffic: not read";
  const usual =
    b.usualUp === null
      ? "no earlier day to compare with"
      : `usually ${formatBytes(b.usualUp)} up and ${formatBytes(b.usualDown ?? 0)} down a day`;
  return `Server's own traffic, last 24 h: ${formatBytes(b.up)} up and ${formatBytes(b.down)} down; ${usual}` + (b.collapsed ? " -- collapsed" : "");
}

/** What customers' apps reported on the server over the last day, in words. */
function reportsLine(e: StoredEvidence): string {
  const r = e.reports24h;
  if (!r) return "Customers' apps, last 24 h: not read";
  if (!r.through && !r.failed) return "Customers' apps, last 24 h: nobody in the country dialled it";
  const n = (k: number) => `${k} customer${k === 1 ? "" : "s"}`;
  return `Customers' apps across the country, last 24 h: ${n(r.through)} got data through it, ${n(r.failed)} did not`;
}

/** The one early notice for an incident our boxes inside the country
 * raised while it is still a suspicion. Worded so it cannot be taken for
 * a block page: it says "not a block verdict" in the subject, and says
 * "partial" when only some boxes lost the server. The server's own traffic
 * and the apps' reports go beside it, because one box alone cannot tell a
 * block from its own network's change (netherlands-1 lost data from one
 * box on 2026-11-14 while its customers kept using it). Sent once per
 * incident; a block page follows if it becomes likely. */
export function insideNoticePage(i: IncidentView, now: Date): Page {
  const where = i.evidence.country.toUpperCase();
  const inside = i.evidence.families.find((f) => f.family === "inside");
  const scope = inside?.scope;
  const partial = scope?.partial === true;
  const label = partial ? "Partial" : "Early warning";
  const headline =
    scope?.kind === "partial"
      ? `${i.nodeName} fails from some of our inside boxes, not all`
      : scope?.kind === "some"
        ? `${i.nodeName} fails from ${scope.lost.length} of our ${scope.reporting.length} inside boxes; the others cannot tell`
        : scope?.kind === "only"
          ? `${i.nodeName} fails from the only inside box reporting`
          : scope?.kind === "all"
            ? `${i.nodeName} fails from every inside box reporting`
            : `${i.nodeName} fails from our inside boxes`;
  const scopeText = scope?.text ?? "from our inside boxes";
  const lines = [`- ${inside?.summary ?? "Our boxes inside the country lost it"}`, `- ${trafficLine(i.evidence)}`, `- ${reportsLine(i.evidence)}`];
  const verdictNote =
    "This is not a block verdict and nothing is paged as one: it is one signal so far. If a second signal agrees " +
    "(the server's own traffic collapsing, the outside check failing), a block page follows. This notice is not sent again for this incident.";
  return {
    subject: `[Neoxify] ${label}, not a block verdict: ${headline}`,
    webhook: `[inside] ${label.toLowerCase()}, not a block verdict -- ${i.nodeName} ${scopeText}. ${trafficLine(i.evidence)}. ${reportsLine(i.evidence)}.`,
    context: { event: "block_inside_notice", node: i.nodeName },
    text:
      `${label}: ${i.nodeName} stopped working ${scopeText}, seen from ${where}, first seen ${i.openedAt.toISOString()} ` +
      `(about ${hoursSince(i.openedAt, now)} h ago).\n\n${lines.join("\n")}\n\n${verdictNote}\n\n${NOTICE_TO_DO}`,
    mail: {
      severity: "warning",
      chip: label,
      facts: [
        { label: "What", value: `${label}, not a block verdict: ${scopeText}` },
        { label: "Where", value: `${i.nodeName}, seen from ${where}` },
        { label: "Since", value: `${opsTime(i.openedAt)} (about ${hoursSince(i.openedAt, now)} h ago)` },
        { label: "Traffic", value: trafficLine(i.evidence) },
        { label: "App reports", value: reportsLine(i.evidence) },
        { label: "How sure", value: verdictNote },
        { label: "What to do", value: NOTICE_TO_DO },
      ],
      body: lines.join("\n"),
      panel: PANEL,
      note: UNCHANGED,
    },
  };
}

/** Inside boxes that stopped reporting: told once, when first seen. */
export function boxesSilentPage(boxes: { vantage: string; lastAt: Date }[], reporting: string[], now: Date): Page {
  const names = boxes.map((b) => b.vantage);
  const from = reporting.length ? `inside evidence now comes from ${reporting.join(" and ")} only` : "no inside box is reporting now";
  const each = boxes.map((b) => `inside box ${b.vantage} has not reported since ${b.lastAt.toISOString()}`).join("; ");
  return {
    subject: `[Neoxify] Inside box ${names.join(" and ")} stopped reporting`,
    webhook: `[inside] ${each}; ${from}`,
    context: { event: "inside_box_silent", vantages: names },
    text:
      `${each[0].toUpperCase()}${each.slice(1)}; ${from}.\n\n` +
      "Until it reports again, the block watch reads servers from the other boxes alone, and says so in each server's evidence. " +
      `This is told once; another message follows when it reports again. (${now.toISOString()})`,
    mail: {
      severity: "warning",
      chip: "Inside box silent",
      facts: [
        { label: "What", value: `${each[0].toUpperCase()}${each.slice(1)}` },
        { label: "Evidence now", value: `${from[0].toUpperCase()}${from.slice(1)}` },
        { label: "As of", value: opsTime(now) },
        { label: "What to do", value: "Check the box and the panel host's collector. Nothing about any server has changed." },
      ],
      body: "",
      panel: PANEL,
      note: UNCHANGED,
    },
  };
}

/** Inside boxes that report again after a silence that was told. */
export function boxesBackPage(boxes: { vantage: string; lastAt: Date | null }[], reporting: string[], now: Date): Page {
  const names = boxes.map((b) => b.vantage);
  const each = boxes
    .map((b) => `inside box ${b.vantage} reports again${b.lastAt ? ` (silent since ${b.lastAt.toISOString()})` : ""}`)
    .join("; ");
  return {
    subject: `[Neoxify] Inside box ${names.join(" and ")} reports again`,
    webhook: `[inside] ${each}; inside evidence comes from ${reporting.join(" and ")}`,
    context: { event: "inside_box_back", vantages: names },
    text: `${each[0].toUpperCase()}${each.slice(1)}; inside evidence comes from ${reporting.join(" and ")} again. (${now.toISOString()})`,
    mail: {
      severity: "info",
      chip: "Resolved",
      facts: [
        { label: "What", value: `${each[0].toUpperCase()}${each.slice(1)}` },
        { label: "Evidence now", value: `From ${reporting.join(" and ")}` },
        { label: "As of", value: opsTime(now) },
        { label: "What to do", value: "Nothing." },
      ],
      body: "",
      panel: PANEL,
    },
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
    mail: {
      severity: "urgent",
      facts: [
        { label: "What", value: `${total} servers look blocked at once` },
        {
          label: "Where",
          value:
            `${names.join(", ")}, seen from ${where}` +
            (pagedThisHour ? ` (after ${pagedThisHour} more paged within the hour)` : ""),
        },
        { label: "Since", value: opsTime(now) },
        {
          label: "How sure",
          value:
            "Unsure. Several servers at once is more often an international cut, a fault on our side or a problem " +
            "with the probe service than separate blocks.",
        },
        { label: "What to do", value: `Check before buying anything. ${WHAT_TO_DO}` },
      ],
      body: incidents.map((i) => `${i.nodeName}: ${reasonOf(i.evidence)}\n${evidenceLines(i.evidence)}`).join("\n\n"),
      panel: PANEL,
      note: "Nothing has been switched or changed.",
    },
  };
}

/** One reminder for every incident that is due one this evaluation. */
export function remindersPage(incidents: IncidentView[], now: Date): Page {
  const where = incidents[0]?.evidence.country.toUpperCase() ?? "";
  if (incidents.length === 1) {
    const [i] = incidents;
    return {
      subject:
        i.evidence.current === "LIKELY_BLOCKED"
          ? `[Neoxify] Reminder: ${i.nodeName} still looks blocked from ${where}`
          : `[Neoxify] Reminder: ${i.nodeName} was likely blocked from ${where}; right now ${readingNow(i.evidence)}`,
      webhook: `[block] Reminder: ${i.nodeName} from ${where}, open ${hoursSince(i.openedAt, now)} h, right now ${readingNow(i.evidence)}`,
      context: { event: "block_reminder", nodes: [i.nodeName] },
      text:
        `${i.nodeName} has had a block incident open from ${where} for about ${hoursSince(i.openedAt, now)} h and nobody has answered ` +
        `in the panel. Right now it reads ${readingNow(i.evidence)}. This is the only reminder.\n\nLatest evidence:\n${evidenceLines(i.evidence)}\n\n${guess(i.evidence)}\n\n${FOOTER}`,
      mail: {
        severity: "warning",
        chip: "Reminder",
        facts: [
          { label: "What", value: `Open, and nobody has answered in the panel. Right now: ${readingNow(i.evidence)}` },
          { label: "Where", value: `${i.nodeName}, seen from ${where}` },
          { label: "Since", value: `${opsTime(i.openedAt)} (about ${hoursSince(i.openedAt, now)} h ago)` },
          { label: "How sure", value: guess(i.evidence) },
          { label: "What to do", value: WHAT_TO_DO },
        ],
        body: `Latest evidence:\n${evidenceLines(i.evidence)}`,
        panel: PANEL,
        note: `This is the only reminder. ${UNCHANGED}`,
      },
    };
  }
  const names = incidents.map((i) => i.nodeName);
  return {
    subject: `[Neoxify] Reminder: ${incidents.length} servers still look blocked from ${where}`,
    webhook: `[block] Reminder: still look blocked from ${where}: ${names.join(", ")}`,
    context: { event: "block_reminder", nodes: names },
    text:
      `These have had block incidents open from ${where} for a day or more and nobody has answered in the panel. ` +
      "This is the only reminder for each.\n\n" +
      incidents
        .map((i) => `${i.nodeName} (about ${hoursSince(i.openedAt, now)} h; right now ${readingNow(i.evidence)})\n${evidenceLines(i.evidence)}`)
        .join("\n\n") +
      `\n\n${FOOTER}`,
    mail: {
      severity: "warning",
      chip: "Reminder",
      facts: [
        { label: "What", value: `${incidents.length} servers still look blocked, and nobody has answered in the panel` },
        { label: "Where", value: `${names.join(", ")}, seen from ${where}` },
        { label: "Since", value: "A day or more, each" },
        { label: "What to do", value: WHAT_TO_DO },
      ],
      body: incidents
        .map((i) => `${i.nodeName} (about ${hoursSince(i.openedAt, now)} h; right now ${readingNow(i.evidence)})\n${evidenceLines(i.evidence)}`)
        .join("\n\n"),
      panel: PANEL,
      note: `This is the only reminder for each. ${UNCHANGED}`,
    },
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
      mail: {
        severity: "info",
        chip: "Resolved",
        facts: [
          { label: "What", value: "Working again; the incident is closed" },
          { label: "Where", value: `${i.nodeName}, seen from ${where}` },
          { label: "Lasted", value: `About ${hoursOf(i)} h, cleared ${opsTime(now)}` },
          { label: "How sure", value: why(i) },
          { label: "What to do", value: "Nothing. If you already replaced the server, there is nothing to undo." },
        ],
        body: "",
        panel: PANEL,
      },
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
    mail: {
      severity: "info",
      chip: "Resolved",
      facts: [
        { label: "What", value: `${incidents.length} servers work again; their incidents are closed` },
        { label: "Where", value: `${names.join(", ")}, seen from ${where}` },
        { label: "Cleared", value: opsTime(now) },
        { label: "What to do", value: "Nothing. If you already replaced any of them, there is nothing to undo." },
      ],
      body: incidents.map((i) => `- ${i.nodeName}, after about ${hoursOf(i)} h: ${why(i)}`).join("\n"),
      panel: PANEL,
    },
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
  /** Inside boxes that stopped reporting, one line each. */
  silentBoxes?: string[];
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
  if (parts.silentBoxes?.length) {
    sections.push(`Inside boxes not reporting:\n\n${parts.silentBoxes.join("\n")}`);
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
    mail: {
      // A page that reached nobody is the one thing in a digest that is
      // not routine.
      severity: undelivered.length ? "warning" : "info",
      chip: "Daily digest",
      facts: [
        { label: "Under watch", value: `${watching} server${watching === 1 ? "" : "s"}, seen from ${where}` },
        ...(undelivered.length
          ? [{ label: "Pages lost", value: `${undelivered.length} reached nobody: ${undelivered.map((i) => i.nodeName).join(", ")}` }]
          : []),
        { label: "Cleared", value: cleared.length ? cleared.map((i) => i.nodeName).join(", ") : "None since the last digest" },
        { label: "As of", value: opsTime(now) },
        { label: "What to do", value: "Answer anything still open under Block watch. Note any verdict that was wrong." },
      ],
      body: sections.join("\n\n"),
      panel: PANEL,
      note: "Nothing here has been changed automatically.",
    },
  };
}
