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
  see `modules/inside-probe`). Each box is its own series. A round counts
  for a box only if that box reached at least half of the other servers
  it usually reaches in a round: a box that reaches nothing, or far less
  than usual, is its own network failing, and counting it would fire for
  every server at once. A box counts against a server only if it
  normally connects to it.

  A round is **lost** when the box got no connection. From a box that
  normally moves data to the server (a *mover*), a round that connects
  and moves nothing either way is lost too -- but only if in that same
  round the box moved data to at least one other server it usually moves
  data to. A box whose own line carries nothing proves nothing, and that
  round is skipped. uk-1 kept accepting the connection from one box from
  2026-11-14 20:08 while nothing moved, for three days, and the watch,
  which then counted only lost connections, said nothing.

  It fires when **one** box that normally reaches the server has lost it
  for several rounds in a row (`insideRounds`). What the other boxes
  show is the **scope**, stored with the incident and said in every
  message: "from 1 of 2 inside networks (signin); still moves data from
  ir2" (partial), "from every inside box that is reporting", or "only
  one inside box is reporting". Until 2026-11-17 another box that still
  connected vetoed it, which is how uk-1 stayed silent. A box shows a
  server working only by moving data to it; a bare connect is no proof,
  from a mover or not -- one box connects and moves nothing to several
  healthy servers as its normal state, and kept doing exactly that
  through the address blocks of 2026-10-28 and 2026-11-07.

  One box alone cannot tell a block from a change on its own network:
  netherlands-1 lost data from the same box in the same round as uk-1
  while its customers kept using it heavily. So on its own this is a
  suspicion, and the early notice below says it as one. With the outside
  probe failing, or the server's own traffic collapsing, it is two
  signals.

  A box that has stopped reporting is said, never dropped without a
  word: each server's inside reading names it ("only one inside box is
  reporting; ir2 has not reported since ..."), and the owner is told
  (below). Not covered: a block of most of the fleet at once looks the
  same as the boxes' own networks failing, and is skipped.
- **The server's own bytes** -- its upstream over the last 24 hours
  against the median of the earlier days' totals (while an incident is
  open, the seven 24-hour windows ending when it opened, fixed there so
  the comparison does not slide), with enough comparable days and a usual
  day big enough to judge. **Corroboration only**: it never opens an
  incident and never fires unless our inside boxes have. On a lightly
  used server a quiet day looks just like a collapse -- in the replay of
  2026-10-27 to 2026-11-17 it read "collapsed" on its own for days on
  servers that were fine. Beside the inside family it is the second
  signal ("and the server's own traffic has collapsed"), and it is what
  told uk-1 from netherlands-1: the first fell from gigabytes a day to a
  few megabytes, the second did not move. It counts only within 48 hours
  of the inside loss beginning, or while it has counted without a break
  since, unless every reporting box lost the server: a quiet afternoon
  days after one box lost a busy, lumpy server is not the same event.
- **One network's change.** A data-only loss from a single box that has
  lasted 24 hours while the server's own bytes have not collapsed is read
  as that box's network changing, not a block: the inside family stops
  firing and reads healthy, so the incident clears and stops holding the
  server's reachability e-mails (netherlands-1, 2026-11-15). Too few bytes
  to judge leaves the loss standing. While an incident is open, a box it
  recorded as having lost the server stays a mover even once the rounds
  from before the loss have aged out of the 30 days kept.

Replayed with the real rules over the rows kept from 2026-10-27 to
2026-11-17, every 30 minutes (`block-watch.replay.spec.ts`, rows from
the database by an export kept out of this repository): the six
incidents the watch really had open at the same times as under the old
rules; uk-1 gets an early notice at 22:01 on 2026-11-14, under two
hours after its data stopped, and a block page at 14:01 the next day when its traffic collapsed; netherlands-1 gets the
same early notice, and its incident clears at 21:01 on 2026-11-15, a
day on with its traffic as usual; france-1 and singapore-1 get one
each on 2026-11-06 (both retired the next day); ir2's silence is told at
00:31 on 2026-11-17. Nothing else.

The app reports are read only once the network table (which says what
networks are in the country) has loaded. Before that -- the first
minutes after a backend start -- that signal reads "unknown", which is
neither evidence nor "too little data": on 2026-11-13 a round two
seconds before the table loaded saw no customers at all, called the
residential data thin, and paged. An unknown signal keeps the time it
started firing, so a restart does not start its one-hour wait again. A
table that has not loaded is tried again every 15 minutes until one
does, not only on the daily refresh.

A server whose agent is offline, whose camouflage destination is down, or
whose port does not answer from the panel host either is an **outage**,
not a block, and is never reported as one. The sweep's log line says
which of the three it was (`outage(agent offline)` and so on). The port is checked whenever
anything fires, so a crashed engine behind a healthy agent is an outage
too. Heartbeat gaps are paged separately (below).

A retired server -- one set `DISABLED`, kept in the database for its
usage history -- is not evaluated at all: it is neither an outage nor a
block. An incident still open on it stays in the panel as it last read
and can be answered there, and no page, reminder or digest line is sent
about it.

## Verdicts

- **Suspect** -- one signal. Panel and daily digest only, except a
  suspicion our inside boxes raised, which also gets one early notice
  (below).
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
listed in the digest instead. That includes an incident our boxes inside
opened alone, as a suspicion: such an incident now opens earlier than
the outside probe alone would have opened one, and from then on that
server's reachability outage email goes to the digest, not straight to
the owner.

Also in `notify`:

- **The early notice.** An incident our inside boxes raised that is
  still only a suspicion gets one message, once per incident: the inside
  line with its scope, the server's own upload and download over the
  last 24 hours against its usual day, and what customers' apps across
  the country reported on it over the last 24 hours (how many got data
  through, how many did not -- counts, never who). Its subject says
  "Partial" when another box still moves data to the server, otherwise
  "Early warning", and always "not a block verdict", so it cannot be
  taken for a block page. It is not sent again while the incident stays
  open; one that becomes likely gets the block page as any other. A
  suspicion raised by other signals alone stays in the digest, as before.
- **A silent box.** An inside box with rows in the last 24 hours but none
  in the last two is silent. The owner is told once when that is first
  seen ("inside box ir2 has not reported since ...; inside evidence now
  comes from signin only") and once when it reports again steadily
  (3 rounds within two hours), and the digest lists it while it lasts,
  for a week at most. Within 12 hours of a "reports again" a new silence
  goes to the digest only, so a flapping link does not send a pair of
  messages every few hours. A message that reached nobody is tried three
  times for that silence; a later silence is told afresh. A box that
  reports but whose own line carries nothing is said as unable to tell,
  never left out of the scope. Early notices and box messages use only
  the hourly budget above what is kept for new block pages. What was told is kept in
  `block_watch_notices`, so a backend restart does not tell it again.

Each digest's delivery -- reached somebody, or why not -- is kept in
`block_watch_notices` too, so "did the digest arrive?" has an answer.

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
