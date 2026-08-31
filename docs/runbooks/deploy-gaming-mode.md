# Runbook — bringing production from `85bfaa9` to `main`

Written 2026-08-31. Production has been on `85bfaa9` (2026-08-23) since
before Gaming Mode existed. This is the plan to close a **239-commit**
gap on a live system with **33 customers and 30 subscriptions**.

Nothing in here has been executed. Read the whole thing first — step 1
is not optional and step 5 is the one that bites.

## What is actually shipping

Gaming Mode in full: the 1,480-entry catalogue built from Valve's launch
configs, per-game exits, exit groups, Custom mode. Plus the bounded list
endpoints and the panel's pager, the cron cursors, the sort indexes, and
API compression. 26 commits touch `apps/backend`, 4 touch `apps/panel`,
2 the agent, 12 the installer.

Three migrations, none applied:

| Migration | Shape | Risk |
|---|---|---|
| `20260824_gaming_mode` | 1 enum, 4 tables, 6 indexes, 3 FKs | **Additive only — zero DROPs** |
| `20260826_list_ordering_indexes` | transactional index build | fine on a fresh DB, **locks a live one** — see step 6 |
| `20260826_list_ordering_indexes/concurrent.sql` | the live-system equivalent | **hand-run, never by Prisma** |

## Preconditions

**Disk is the blocker. Do this before anything else.**

`/` is at **84% (6.1 G free of 38 G)** and a Docker build of the backend
plus a Next.js panel will not fit comfortably. **21.86 GB is reclaimable
buildx cache** — `docker system df` reports it; `du` on
`/var/lib/docker` does not, which is why it is easy to miss:

```bash
docker buildx du            # confirm ~21.86GB, Reclaimable ~21.59GB
docker buildx prune -af     # takes / from ~84% to ~27%
df -h /
```

**Memory is tight but survivable.** 3.7 GiB total, ~467 MiB free,
2.3 GiB available, with a 4 GB swapfile already configured (217 MB used).
A Next.js production build on this box while it is serving customers is
the single most likely thing to OOM. If the panel build dies, that is
why — build it with a bounded heap rather than adding RAM in a panic:
`NODE_OPTIONS=--max-old-space-size=2048`.

**Backups are healthy** — daily 03:00 timer, four retained, today's is
28 MB and the database is 328 MB. Take a fresh one anyway; the last one
is up to a day old and this is a schema change.

## Decision to make before you start

The keepalive fix (`claude/single-machine-rebaseline`) is **not in
`main`**. It changes `agent-gateway.service.ts`, so it lands in the same
container as everything else.

- **Merge it first, deploy once.** One outage instead of two, and the
  wedge that took germany-1 and singapore-1 out for six days stops being
  possible. Costs you attribution: if the backend misbehaves afterwards
  you are looking at 239 commits *plus* an unproven change.
- **Deploy `main` alone, fix after.** Clean attribution, but you ship
  knowing the hang can recur, and you take a second restart later.

Recommendation: **merge it first.** The change is small, additive, tested,
and confined to server construction. 239 commits is already past the
point where one more makes attribution meaningfully harder.

Either way the *agent* half of that fix needs a separate fleet rollout —
see the last section.

## Order of operations

Steps 1–3 are safe and reversible. The window where customers can notice
anything is step 6, and it is seconds.

### 1. Prune, then verify headroom

```bash
docker buildx prune -af && df -h /
```

Do not continue below ~15 G free.

### 2. Fresh backup, verified

```bash
sudo /root/neoconnect/infra/scripts/backup.sh
ls -la /var/backups/neoxify/ | tail -2
```

Confirm a new tarball with today's timestamp and a plausible size
(~28 MB). A backup you did not look at is not a backup. Copy it off-box
— `backup.sh` says in its own header that it does not do that for you,
and a rollback plan that lives only on the machine you are changing is
not a rollback plan.

### 3. Fetch the new code, do not build yet

```bash
cd /root/neoconnect
git fetch origin
git log --oneline HEAD..origin/main | wc -l     # expect 239
git status --short                              # expect empty
git checkout main && git pull --ff-only
```

The working tree was clean when surveyed. **If `git status` is not empty,
stop** — something was hand-patched since, and that changes the plan.

### 4. Build the images

```bash
cd /root/neoconnect/infra
docker compose -f docker-compose.prod.yml build backend panel
```

Nothing is swapped yet; the running containers are untouched. If the
panel build OOMs, retry with the bounded heap above.

### 5. The indexes — hand-run, in this order

**This is the step with a trap in it.** `concurrent.sql` is deliberately
not named `migration.sql` because Prisma sends a migration as one
implicit transaction and `CREATE INDEX CONCURRENTLY` cannot run inside
one.

```bash
docker exec -i neoxify-postgres-1 psql -U neoxify -d neoxify \
  -f - < apps/backend/prisma/migrations/20260826_list_ordering_indexes/concurrent.sql
```

`psql -f` is safe here — it sends statements individually. **Never wrap
it in BEGIN/COMMIT and never paste it into a client that batches.**

Then check for invalid indexes *before* moving on. A failed
`CONCURRENTLY` build leaves an INVALID index that the planner ignores but
every write still maintains, and `IF NOT EXISTS` skips past it forever:

```bash
docker exec neoxify-postgres-1 psql -U neoxify -d neoxify -c \
  "SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE NOT x.indisvalid;"
```

Expect zero rows. Anything listed must be dropped with
`DROP INDEX CONCURRENTLY IF EXISTS` and rebuilt before you continue.

At 33 customers these tables are tiny and this should be near-instant.
`CONCURRENTLY` waits out any open long transaction — expect slow rather
than failed.

### 6. Swap — the container migrates itself

**There is no separate migrate command, and that is the reason step 5
cannot be skipped.** The backend image's own `Cmd` is:

```
sh -c "node_modules/.bin/prisma migrate deploy && node dist/main.js"
```

So starting the container *is* running the migration. There is no manual
gate between "I started the new backend" and "the migration ran".

```bash
docker compose -f docker-compose.prod.yml up -d backend panel
```

With step 5 done, `migrate deploy` applies `20260824_gaming_mode`, finds
every index from `concurrent.sql` already present, does nothing for them
— every statement in `migration.sql` is `IF NOT EXISTS` / `IF EXISTS` —
and records both migrations as applied. No lock is ever taken.

**Without step 5**, the same boot runs the transactional `migration.sql`
instead, whose plain `CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock on
`customers`, `subscriptions` and `protocol_users` — blocking reads *and*
writes on the customer-facing path for the length of the build.

Sizing that honestly: at 33 customers and a 328 MB database those builds
are milliseconds, so skipping step 5 today would probably go unnoticed.
Do it anyway. The order is free, the habit is what matters when the
tables are not small, and `protocol_users` is the one that grows fastest.

### 7. Verify — in this order, and actually look

```bash
# migrations recorded
docker exec neoxify-postgres-1 psql -U neoxify -d neoxify -tAc \
  "select migration_name from _prisma_migrations order by started_at desc limit 3;"

# API up
curl -sS https://connect.neoxify.site/api/health

# every node still connected -- this is the one that matters
docker exec neoxify-postgres-1 psql -U neoxify -d neoxify -F'  ' -A -c \
  "select name, status, round(extract(epoch from (now()-\"lastHeartbeatAt\")))::int as secs
     from nodes order by name;"
```

All six nodes must be ONLINE with a heartbeat inside ~60s. The backend
restart drops every agent stream; they should reconnect on their own. **If
a node does not come back within two minutes, that is the wedge bug** —
`kill -QUIT` its `neoxify-agentd` (`Restart=always` brings it straight
back, and the QUIT captures the goroutine dump). See
`docs/journal/log.md`, 2026-08-30.

Then log into the panel and open the Gaming Mode page, which is new.

## Rollback

Nothing here drops a column or a table, so the schema is forward-safe:
the old code ignores the new tables. That means **rollback is a code
rollback, not a database restore.**

```bash
cd /root/neoconnect && git checkout 85bfaa9
cd infra && docker compose -f docker-compose.prod.yml build backend panel \
  && docker compose -f docker-compose.prod.yml up -d backend panel
```

Leave the migrations applied. Restore from the step-2 tarball only if the
database itself is wrong — not merely because the app misbehaves.

## The agent fleet — separate, and do it after

Do not bundle this with the above.

The fleet is on skewed binaries: **de1, tr1, fr1 and sg1 all run one
identical pre-v0.2.6 build** (sha `8cc30b52d612`, dated 08-18 to 08-22,
reporting `agentVersion "dev"` because they predate the `--version`
flag), while **ir1 alone is on v0.2.6** (`f3a6215f13c4`). Only the relay
was upgraded when v0.2.6 shipped.

The agent half of the keepalive fix has to reach all six for the hang to
be gone, and the two halves are coupled — the backend's
`min_ping_interval_without_data_ms` must stay at or below the agent's
30s keepalive or the server severs healthy connections with
GOAWAY/ENHANCE_YOUR_CALM. **Deploy the backend half first** (it is
backward-compatible with agents that never ping) **and the agents after.**

Roll one node first — `sg1` or `tr1`, not the Iran relay — and leave it
for a day before the rest.

**fi1 has a different root password** and would not accept the session
key. Fix that before a fleet rollout, or Finland gets skipped silently.
