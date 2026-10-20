# Block watch

Notices servers that look blocked from the probe country (Iran) and tells
the owner. **It never changes, buys, replaces or moves anything**: what to
do about a block is the owner's decision, answered in the panel.

Code: `apps/backend/src/modules/block-watch`. Panel: **Block Watch**.

## What it reads

Only what the backend already records, every 30 minutes:

- **App reports** -- the ladder rungs in `client_attempts` from signed-in
  customers on networks registered in the country, for direct routes. A
  network counts when several distinct customers on it got nothing
  through recently, where the server did carry for people on that network
  in the days before. One customer, however many reports, is never enough.
  Relayed routes are left out: their failure may be the relay's leg abroad.
- **Traffic** -- how many people sent data upstream through the server
  lately, against the same hours on the previous days. Node-wide.
- **Probes** -- the Iran Reachability checks (`node_reachability_checks`).

A server whose agent is offline, whose camouflage destination is down, or
whose port does not answer from the panel host either is an **outage**,
not a block, and is never reported as one. Heartbeat gaps are paged
separately (below).

## Verdicts

- **Suspect** -- one signal. Panel and daily digest only.
- **Likely blocked** -- two signals at once; or app reports failing on
  several networks for a while; or probes alone for hours with too little
  residential data to contradict them (the page says so).

Incidents clear on their own after quiet evaluations.

## Turning it on

`BLOCK_WATCH` in `infra/.env`, then recreate the backend container:

| Value | Effect |
|---|---|
| blank / `off` | Nothing runs (default). |
| `record` | Verdicts in the panel only. |
| `digest` | Also a daily digest by webhook + email; no pages. Run this first, for about two weeks, and note wrong verdicts. |
| `notify` | Pages for likely blocks (one per incident, one reminder after 24 h, a notice when it clears, several at once grouped into one message, at most 4 an hour); suspects in the daily digest. |

Pages go through the owner's pager: `ALERT_WEBHOOK_URL` and every
SUPERADMIN's mailbox. Delivery is recorded on the incident.

## The owner's answers (SUPERADMIN)

- **Replace** -- you are moving it to a new server. Closes the incident;
  evidence from before it stops counting for that server.
- **Retire** -- closes it and stops watching the server while it keeps
  that address.
- **Keep** -- it is fine; no more pages or reminders for this incident.
- **Snooze 24h** -- holds pages and the reminder.

## Heartbeat gaps

Separate from the block watch and on by default: a node with no heartbeat
for `HEARTBEAT_GAP_PAGE_MINUTES` (blank = 10, `0` = off) pages the owner
once, and once more when it is back. Gaps already older than a day when
first seen (a node long gone) stay with the six-hourly webhook reminder.
