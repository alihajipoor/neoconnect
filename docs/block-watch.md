# Block watch

Notices servers that look blocked from the probe country and tells the
owner. **It never changes, buys, replaces or moves anything**: what to do
about a block is the owner's decision, answered in the panel.

Code: `apps/backend/src/modules/block-watch`. Panel: **Block Watch**.

This page says what it does, not where its lines are drawn. The
thresholds are settings (`BLOCK_WATCH_TUNING`, below) whose values in use
live only in `infra/.env` on the panel host and in the owner's private
notes. Published, they would say how to shape a block that is never
noticed -- keep them, and any list of what it does not look at, out of
this repository.

## What it reads

Only what the backend already records, on the sweep cadence:

- **App reports** -- the connect reports of signed-in customers on
  networks registered in the country, one row per customer and route
  however many reports anyone sends. A network counts when several
  distinct customers on it got nothing through lately, and the server
  had carried traffic for those same people before, as the server itself
  measured it (usage records) -- not as an app claims. Times are when a
  report arrived, which a client cannot move.
- **Traffic** -- how many people sent data upstream through the server
  lately, against the same hours on earlier days.
- **Probes** -- the reachability checks (`node_reachability_checks`).
- **Our own boxes inside** -- the inside probe (`inside_probe_checks`;
  see `modules/inside-probe`). Only whether a box opened a
  TCP connection counts, never whether data then moved: one box connects
  and moves nothing to several healthy servers as its normal state. A
  round counts for a box only if that box reached some other server in
  it (a box that reaches nothing is the box's problem), and a box counts
  for a server only if it normally connects to it (a server a box never
  reached says nothing from that box). It fires when every box that
  normally reaches the server has lost it for several rounds in a row
  (`insideRounds`). With the outside probe failing too, that is two
  signals: likely blocked within a couple of hours instead of the day it
  took on 2026-11-12. On its own it is a suspicion.

The app reports are read only once the network table (which says what
networks are in the country) has loaded. Before that -- the first
minutes after a backend start -- that signal reads "unknown", which is
neither evidence nor "too little data": on 2026-11-13 a round two
seconds before the table loaded saw no customers at all, called the
residential data thin, and paged.

A server whose agent is offline, whose camouflage destination is down, or
whose port does not answer from the panel host either is an **outage**,
not a block, and is never reported as one. The port is checked whenever
anything fires, so a crashed engine behind a healthy agent is an outage
too. Heartbeat gaps are paged separately (below).

A retired server -- one set `DISABLED`, kept in the database for its
usage history -- is not evaluated at all: it is neither an outage nor a
block. An incident still open on it stays in the panel as it last read
and can be answered there, and no page, reminder or digest line is sent
about it.

## Verdicts

- **Suspect** -- one signal. Panel and daily digest only.
- **Likely blocked** -- two signals at once; or app reports failing on
  several networks for a while, while the server's own traffic is not as
  usual; or probes alone for hours with too little residential data to
  contradict them (the page says so).

An incident keeps the strongest verdict it reached, and its evidence has
the latest reading. The panel's badge and the reminder show the latest
reading, with "was likely blocked" beside it when the two differ, so an
incident that fell back to a suspicion is not shown as a likely block.
A page goes out only while the latest reading is likely.

## How an incident ends

Only on evidence that the server works again, from a signal that fired
during the incident: the probes connect, the networks that failed carry
again, or traffic is back near what it was. A signal that merely went
quiet -- its data thinned out, people were steered elsewhere, the probe
service stopped answering -- proves nothing, and the incident is held
open, as it is through an outage. While it is open, "before" means
before it began: a block that lasts never becomes the baseline it is
measured against.

An incident that comes back soon after it cleared is the same incident,
opened again. It is not paged again; the digest says it came back.

## Turning it on

`BLOCK_WATCH` in `infra/.env`, then recreate the backend container:

| Value | Effect |
|---|---|
| blank / `off` | Nothing runs (default). |
| `record` | Verdicts in the panel only. |
| `digest` | Also a daily digest by webhook + email; no pages. Run this first, for about two weeks, and note wrong verdicts. |
| `notify` | Pages for likely blocks; suspects in the daily digest. |

In `notify`: one page per incident, sent only while the latest evaluation
says likely; several servers at once are one message; one reminder a day
later, and one notice when it works again -- reminders and notices of a
run grouped into one message each, and an hourly budget with room kept
for new pages. A page counts as sent only when it reached somebody;
otherwise it is tried again a few times, and then listed in the digest.
While an incident is open for a server, the reachability monitor's own
alert for it is held (the incident carries the same probe evidence) and
listed in the digest instead.

`BLOCK_WATCH_TUNING` -- the thresholds, as `name=value` pairs separated
by commas (the names are in `parseTuning`, `block-signals.ts`). Blank is
the fallbacks in the code. A value that does not read keeps its fallback
and is logged by name.

Pages go through the owner's pager: `ALERT_WEBHOOK_URL` and every
SUPERADMIN's mailbox. Delivery is recorded on the incident.

## The owner's answers (SUPERADMIN)

- **Replace** -- the server has moved to a new address. Accepted only
  once the node's address has changed; until then, snooze it. Closes the
  incident; evidence from before it stops counting for that server.
- **Retire** -- closes it and stops watching the server while it keeps
  that address.
- **Keep** -- it is fine; no more pages or reminders for this incident.
  A kept incident may close once the signals that fired have no data.
- **Snooze 24h** -- holds pages and the reminder.

## Heartbeat gaps

Separate from the block watch, and off until `HEARTBEAT_GAP_PAGE_MINUTES`
is set (blank or `0` = off; 10 is a sensible value): a node with no
heartbeat for that many minutes pages the owner once, and once more when
it is back. Nodes that go quiet in the same sweep are one message, and
so are nodes that come back. A gap counts as paged only when the page
reached somebody; otherwise later sweeps try again, a few times. A node
that was just said to be back is not paged again for some hours, so a
flapping link is not a page every few minutes. Gaps already older than a
day when first seen (a node long gone) stay with the six-hourly webhook
reminder. The "back" message is sent by the sweep, never from the agent's
reconnect, which re-sends customers' credentials and routes first.
