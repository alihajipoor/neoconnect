import type { Page } from "../alerting/pager.service";
import { opsTime } from "../email/templates";

/** What the heartbeat-gap pages say. English: they go to the owner.
 * Never an address -- the webhook may be a chat channel -- only the
 * server's name. Pure, like block-watch.messages.ts, so the wording can
 * be read and rendered without a database. */

export interface HeartbeatGap {
  name: string;
  /** The last heartbeat, ISO. */
  since: string;
  minutes: number;
}

const PANEL = { path: "/nodes", label: "Open Nodes" };

/** One page for every agent that has gone quiet. */
export function heartbeatGapPage(gaps: HeartbeatGap[]): Page {
  const one = gaps.length === 1 ? gaps[0] : null;
  return {
    subject: one ? `[Neoxify] ${one.name} has stopped heartbeating` : `[Neoxify] ${gaps.length} nodes have stopped heartbeating`,
    webhook: one
      ? `[node] ${one.name}: no heartbeat for ${one.minutes} min (since ${one.since})`
      : `[node] no heartbeat from ${gaps.map((g) => `${g.name} (${g.minutes} min)`).join(", ")}`,
    context: { event: "heartbeat_gap", nodes: gaps.map((g) => g.name) },
    text:
      (one
        ? `The agent on ${one.name} has sent no heartbeat for ${one.minutes} minutes, since ${one.since}. `
        : `${gaps.length} agents have sent no heartbeat:\n` +
          gaps.map((g) => `- ${g.name}: ${g.minutes} minutes, since ${g.since}`).join("\n") +
          "\n\nSeveral at once is more often a fault on our side or a network cut than separate failures. ") +
      "Customers on them may be cut off. This is an outage -- the server, its network or the agent -- not a block.\n\n" +
      "You will hear once more when it is back. Nothing has been changed automatically.",
    mail: {
      severity: "urgent",
      facts: [
        { label: "What", value: "No heartbeat from the agent. Customers there may be cut off." },
        { label: "Where", value: gaps.map((g) => g.name).join(", ") },
        {
          label: "Since",
          value: gaps.map((g) => (one ? "" : `${g.name}: `) + `${opsTime(g.since)} (${g.minutes} minutes)`).join("\n"),
        },
        {
          label: "How sure",
          value:
            "Measured: the backend has heard nothing since then. This is an outage -- the server, its network or " +
            "the agent -- not a block." +
            (one ? "" : " Several at once is more often a fault on our side or a network cut than separate failures."),
        },
        { label: "What to do", value: "Check the server, its network and the agent. You will hear once more when it is back." },
      ],
      body: "",
      panel: PANEL,
      note: "Nothing has been changed automatically.",
    },
  };
}

/** One page for every paged agent that is back. */
export function heartbeatReturnPage(back: { name: string; pagedAt: Date }[]): Page {
  const names = back.map((n) => n.name);
  const one = back.length === 1 ? back[0] : null;
  return {
    subject: one ? `[Neoxify] ${one.name} is heartbeating again` : `[Neoxify] ${back.length} nodes are heartbeating again`,
    webhook: `[node] heartbeating again: ${names.join(", ")}`,
    context: { event: "heartbeat_gap_ended", nodes: names },
    text:
      (one
        ? `The agent on ${one.name} has connected again; its gap was paged at ${one.pagedAt.toISOString()}. `
        : `These agents have connected again: ${names.join(", ")}. `) +
      "The backend re-sends their customers' credentials and routes as each one reconnects.",
    mail: {
      severity: "info",
      chip: "Resolved",
      facts: [
        { label: "What", value: "The agent has connected again" },
        { label: "Where", value: names.join(", ") },
        { label: "Gap paged", value: back.map((n) => (one ? "" : `${n.name}: `) + opsTime(n.pagedAt)).join("\n") },
        {
          label: "What to do",
          value: "Nothing. The backend re-sends their customers' credentials and routes as each one reconnects.",
        },
      ],
      body: "",
      panel: PANEL,
    },
  };
}
