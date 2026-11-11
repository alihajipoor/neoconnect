# Database retention: usage records and server commands

The owner's rule (2026-11-11):

- **usage_records**: the detailed 30-second rows are kept for 35 days.
  Older rows are added up into `usage_hourly`, one row per subscription,
  node and UTC hour, kept forever. The detailed rows are then deleted.
  The roll-up and the delete happen in one statement, inside one
  transaction per batch.
- **agent_commands**: finished commands (`ACKED`, `FAILED`) older than 7
  days are deleted. `QUEUED` and `SENT` rows are never touched. That
  includes the pending remove-user and disable-user commands of retired
  servers, which are kept on purpose.
- **No outage.** Space comes back through plain `VACUUM` and
  `REINDEX INDEX CONCURRENTLY`, one index at a time. **Never VACUUM
  FULL**: its exclusive lock stalls every stats write, and with no
  database timeouts that drops every node's stream.

Code: `apps/backend/src/modules/data-retention/` (the rules and the SQL),
`apps/backend/src/cli/data-retention.ts` (the command line). The
migration `20261112_usage_hourly` only adds the empty table.

## What stays the same, and what does not

The number of days kept is never fewer than what a reader needs. It is
the largest of these: the owner's 35 days; the apps' daily history (31
days, plus 14 h for time zones, plus a day); the idle-device sweep (30
days); the profile traffic (14 days); the block watch's baseline with
`BLOCK_WATCH_TUNING` applied; and, while a block incident is open (or was
cleared within 48 h), its age plus that baseline. The cutoff is rounded
down to the UTC hour, so no hour is ever split between the two tables.

Readers that can reach further back also read the roll-up:

- **Last seen** on the customer profile is the newer of the detailed
  rows and `usage_hourly.lastUpAt`. That is the newest report with
  upload bytes, so a WireGuard ghost hour (download only) still does not
  count as seen.
- **Block watch**, for an incident open longer than the days kept: the
  traffic baseline and the customers-reached check add the rolled-up
  hours whose middle falls in their 2-hour windows. Past the days kept,
  these counts are approximate to the hour.

What is lost past the days kept: detail finer than an hour, and the
credential behind a row, so also the protocol and route split.

Deleting a node, a subscription or a customer deletes its rolled-up
hours too, in the code and through the foreign keys' `ON DELETE CASCADE`.

## Why a run can be stopped and run again

Each batch is one statement. It deletes up to 5,000 detailed rows of one
node and adds exactly the rows that the `DELETE ... RETURNING` gave back
into their hours. A row is either still in `usage_records` and not yet
counted, or it is gone and counted in the same commit. It is never both,
and never neither. So a run that is stopped, crashes or times out loses
nothing, and a second run finds nothing left to count twice. Hours are
added to (`ON CONFLICT ... DO UPDATE` with `+`), never overwritten,
because one hour can be filled by more than one batch.

Each batch sets `lock_timeout = 2s` and `statement_timeout = 120s` and
takes a transaction-level advisory lock. That lock is released at every
commit, so it keeps two runs from running a batch at the same instant,
not from taking turns between batches (a nightly run and a run by hand,
say). That does no harm: each batch is one statement over rows it has
locked, so no row is counted by both. Rows another transaction holds,
such as a credential being deleted, are skipped rather than waited on
(`FOR UPDATE SKIP LOCKED`) and go in a later batch, so a customer-facing
change is never the one Postgres aborts. If a batch cannot get a lock in
time, that node is left for the next run and the run moves on.

A run first compares the backend's clock with the database's `now()`
and refuses, changing nothing, if they differ by more than five
minutes. Every cutoff comes from the backend's clock, and one running
ahead would delete detail early.

## The first run, by hand

Do not run any of this between 03:00 and 04:00 UTC: the nightly
`pg_dump` holds a lock on every table during that hour. Every command
below runs on the panel host.

### 1. Check free disk, then dump the two tables

Deleting about 1.5 million rows and then vacuuming writes roughly 1-2 GB
of WAL (estimate). Each REINDEX needs about the size of its new index.

```sh
df -h /
TS=$(date -u +%Y%m%dT%H%MZ)
docker exec neoxify-postgres-1 sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -t usage_records -t agent_commands -t usage_hourly "$POSTGRES_DB"' \
  > /root/db-backups/pre-retention-$TS.dump
docker exec -i neoxify-postgres-1 pg_restore --list < /root/db-backups/pre-retention-$TS.dump | grep -c 'TABLE DATA'   # expect 3
```

That dump holds the old command rows, and with them customers'
connection secrets. Shred it when the undo window is over
(`shred -u`), and no later than the time the nightly backups from
before the run age out.

### 2. Dry run

This prints counts only and changes nothing:

```sh
docker exec neoxify-backend-1 node dist/cli/data-retention.js
```

It prints JSON: `usage.cutoff` and `usage.setBy` (the reader that set
the cutoff), the rows and hours per node, and the finished commands that
would go by status. It also prints `keptPendingOlderThanCutoff`: the
QUEUED and SENT rows older than 7 days, which stay. Compare these with
the numbers the owner was shown: about 1.5 million usage rows, about
234,000 commands, and about 8,300 pending rows kept.

### 3. Real run

```sh
TS=$(date -u +%Y%m%dT%H%MZ)
docker exec neoxify-backend-1 node dist/cli/data-retention.js --run \
  > /root/retention-run-$TS.json 2> /root/retention-run-$TS.log
```

Optional flags: `--only usage` or `--only commands`, `--batch N`, and
`--node <name>` (which can be repeated, for example to try one node
first). To stop the run between batches:
`docker exec neoxify-backend-1 pkill -INT -f data-retention.js`.
Running it again carries on from where it stopped.

In the JSON, `usage.totalsEqual` must be `true`. It compares, per node,
the bytes of all detailed rows before the cutoff plus all rolled-up
hours, before and after the run. If it is `false` (exit code 2),
something lost or double-counted bytes, unless a subscription or node
was deleted during the run. Stop and look before anything else runs.

### 4. Plain VACUUM

This takes no exclusive lock. Run it once the delete is done. It does
not make `usage_records` itself smaller on disk: the deleted rows are
the oldest, at the front of the file, so their space is marked free and
reused by new rows. `df` shows only what the REINDEXes of step 5 free.
An unchanged table size here is expected, not a failure, and is never a
reason for `VACUUM FULL`.

```sh
docker exec -i neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
VACUUM (ANALYZE) usage_records;
VACUUM (ANALYZE) agent_commands;
SQL
```

### 5. REINDEX CONCURRENTLY, one index at a time

Run each statement on its own and wait for it to finish before starting
the next. None of them blocks reads or writes.

```sh
docker exec -i neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
REINDEX INDEX CONCURRENTLY "usage_records_subscriptionId_reportedAt_idx";
SQL
```

Then do the same with each of these:

- `"usage_records_nodeId_reportedAt_idx"`
- `"usage_records_pkey"`
- `"usage_records_protocolUserId_idx"`
- `"agent_commands_pkey"`
- `"agent_commands_nodeId_status_idx"`

If one fails (a lock timeout, a cancel, or not enough disk), Postgres
leaves an invalid index behind: `<name>_ccnew` (or `_ccnew1` and so on
after repeated failures), or `<name>_ccold` if it failed after the swap.
Run the index query of step 6. Drop every index it shows with
`indisvalid = false`, one at a time, with
`DROP INDEX CONCURRENTLY "<that name>";`, then run the REINDEX again if
the original index is not valid.

### 6. Check the result

```sh
docker exec -i neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total
  FROM pg_class WHERE relname IN ('usage_records', 'usage_hourly', 'agent_commands');
SELECT indexrelid::regclass AS index, indisvalid
  FROM pg_index WHERE indrelid IN ('usage_records'::regclass, 'agent_commands'::regclass);
SELECT count(*) AS old_detail FROM usage_records WHERE "reportedAt" < now() AT TIME ZONE 'UTC' - interval '35 days';
SELECT status, count(*) FROM agent_commands WHERE "createdAt" < now() AT TIME ZONE 'UTC' - interval '7 days' GROUP BY 1;
SELECT count(*) AS hours, sum(records) AS rows_in_them FROM usage_hourly;
SQL
df -h /
```

Expected: every index is valid. `old_detail` is 0, or close to it (an
open block incident can hold more days back; the dry run's `setBy` says
so). The old commands left are QUEUED or SENT only. Run the dry run once
more: it should find nothing to do. In the panel, open a customer who
has been idle for more than 35 days: their last-seen time should be the
same as before the run.

One ranking changes, by design: when a customer is over their device
limit, a device idle for more than 35 days is ranked by its last use
only (`lastUsedAt`), since its traffic rows are rolled up. Only stale
devices are affected, and the 30-day idle sweep removes those anyway.

### 7. Turn the nightly run on

The nightly job runs at 01:15 UTC. It is **off until `DATA_RETENTION` is
set**:

- `DATA_RETENTION=` (blank) or `off`: nothing runs. This is the default.
- `DATA_RETENTION=dry`: logs what it would do.
- `DATA_RETENTION=on`: rolls up and deletes.

Set it in `infra/.env` and recreate the backend with the usual
`docker compose -f infra/docker-compose.prod.yml --env-file infra/.env up -d`.
Each night logs one line, `data retention: usage before ... removed N
row(s) ...`, in the backend's log. The nightly does not vacuum.
Autovacuum is enough for one day of rows, and the freed space is reused.

## Undo, from the dump of step 1

The deletes can only be undone from that dump. The steps below write to
production, so do them only with the owner's yes. First set
`DATA_RETENTION=off` and recreate the backend.

`D` below is the dump's time (`$TS` from step 1), rounded down to the
hour, in UTC. Every rolled-up hour before `D` was made only from rows
that are in the dump. Rows reported after the dump stay rolled up, and
their hours start at `D` or later.

```sh
# Load the dump's two tables into staging tables
docker exec -i neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
CREATE TABLE usage_records_restore (LIKE usage_records);
CREATE TABLE agent_commands_restore (LIKE agent_commands);
SQL
for t in usage_records agent_commands; do
  docker exec -i neoxify-postgres-1 pg_restore --data-only -t $t -f - < /root/db-backups/pre-retention-$TS.dump \
    | sed "s/^COPY public\.$t /COPY public.${t}_restore /" \
    | docker exec -i neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
done
```

```sql
BEGIN;
-- Put back the detailed rows the roll-up replaced, skipping rows of
-- nodes or subscriptions deleted since, and rows still present.
INSERT INTO usage_records
  SELECT r.* FROM usage_records_restore r
  WHERE r."reportedAt" < 'D'
    AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = r."subscriptionId")
    AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = r."nodeId")
  ON CONFLICT (id) DO NOTHING;
-- Their hours must go, or those bytes are counted twice.
DELETE FROM usage_hourly WHERE "hourStart" < 'D';
-- The command history. It brings back the old rows that hold
-- connection secrets.
INSERT INTO agent_commands
  SELECT c.* FROM agent_commands_restore c
  WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = c."nodeId")
  ON CONFLICT (id) DO NOTHING;
COMMIT;
DROP TABLE usage_records_restore;
DROP TABLE agent_commands_restore;
```

`usage_records."protocolUserId"` can point at a credential deleted since
the dump. If the INSERT fails on that foreign key, set it to NULL in the
staging table first: `UPDATE usage_records_restore r SET "protocolUserId"
= NULL WHERE NOT EXISTS (SELECT 1 FROM protocol_users p WHERE p.id =
r."protocolUserId");`. That is what the live foreign key does when a
credential is deleted.
