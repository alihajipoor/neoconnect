# Backup & restore runbook

Covers the main panel server (Postgres database, agent-gateway TLS certs,
and `infra/.env` secrets). Agent nodes carry no durable state of their own
worth backing up — an agent re-enrolls and gets its config pushed back
down from the panel on reconnect (see `docs/architecture.md`).

## What gets backed up

`infra/scripts/backup.sh` bundles three things into one timestamped
`.tar.gz`:

1. **Database** — `pg_dump -Fc` (Postgres custom format) of the whole
   `neoxify` database: admins, customers, subscriptions, nodes, protocol
   configs/users (credentials encrypted at rest via
   `CREDENTIALS_ENCRYPTION_KEY`, see `apps/backend/src/modules/protocol-users/credentials-crypto.ts`),
   usage records, payment transactions, audit log.
2. **Agent-gateway TLS certs** — `/etc/neoxify/certs/{fullchain,privkey}.pem`
   (copies of the Let's Encrypt cert used for the gRPC gateway; nginx's own
   copy under `/etc/letsencrypt` is not included since certbot re-issues
   that independently and it isn't panel-specific state).
3. **`infra/.env`** — JWT secrets, `CREDENTIALS_ENCRYPTION_KEY`, Stripe/
   NowPayments API keys, `POSTGRES_PASSWORD`.

**The resulting archive contains real secrets.** It's written `0600`
root-only, but that only protects it on the box it was made on. Copy
backups to separate off-box storage (S3, another VPS, wherever) — the
scripts don't do this for you, since the right destination depends on
what you're already paying for.

## Scheduled backups

The panel installer (`installer/lib/panel.sh`, action 1 — Install Panel)
installs `/etc/cron.d/neoxify-backup`, which runs `backup.sh` daily at
03:00 server time, keeping the last 14 by default (`BACKUP_KEEP` env var
on the cron line to change it), logging to `/var/log/neoxify-backup.log`.

Backups land in `/var/backups/neoxify/neoxify-backup-<timestamp>.tar.gz`.

## Manual backup

From the panel management menu (`sudo ./install.sh` on an already-installed
box) → **4) Backup now**, or directly:

```bash
sudo infra/scripts/backup.sh                 # -> /var/backups/neoxify
sudo infra/scripts/backup.sh /some/other/dir  # custom location
BACKUP_KEEP=30 sudo infra/scripts/backup.sh   # keep 30 instead of the default 14
```

Run this before any risky operation: a major version upgrade, a schema
migration you're not 100% sure about, moving the panel to new hardware.

## Restore

**This is destructive** — it drops and recreates the `neoxify` database.
Restoring onto a live server discards everything written since the
backup being restored.

From the panel menu → **5) Restore from backup** (prompts for a backup
path, defaults to the newest one in `/var/backups/neoxify`), or directly:

```bash
sudo infra/scripts/restore.sh /var/backups/neoxify/neoxify-backup-20260723-030000.tar.gz
sudo infra/scripts/restore.sh --latest                    # newest in /var/backups/neoxify
sudo infra/scripts/restore.sh --latest /custom/backup/dir
```

You'll be asked to type `yes` to confirm the database restore. If
`infra/.env` already exists on this box, you're separately asked whether
to overwrite it with the backed-up copy (say no if you're restoring the
database onto a box that already has its own, possibly different,
secrets configured — e.g. a fresh disaster-recovery box that's meant to
keep serving the same domain/JWT sessions isn't the usual case; a
same-box "undo a bad migration" restore is). If `infra/.env` does *not*
exist yet (a genuinely fresh box), it's restored automatically since the
stack can't start without it.

What it does, in order:
1. Extracts the archive.
2. Confirms with you.
3. Brings Postgres up (if not already) and waits for it to be healthy.
4. Stops `backend`/`panel` so nothing writes mid-restore.
5. Drops and recreates the `neoxify` database, `pg_restore`s the dump into it.
6. Restores `/etc/neoxify/certs` (if the backup had them).
7. Restores `infra/.env` (conditionally, see above).
8. Brings the full stack back up and waits for `/health` to respond.

For non-interactive/scripted disaster recovery (e.g. a fresh box's own
first-boot automation), pass `--yes` to skip the confirmation prompt —
in that mode `infra/.env` is only auto-restored when it doesn't already
exist, never silently overwritten.

## Disaster recovery: fresh box

1. Provision a new VPS, point DNS at it.
2. `git clone` this repo, `cd` into `installer`, `sudo ./install.sh` →
   choose **Main Panel Server**. Let it generate fresh `infra/.env`
   secrets and get as far as a working (but empty) panel.
3. Copy the latest backup archive onto the box (`scp` from your off-box
   backup storage).
4. `sudo infra/scripts/restore.sh /path/to/neoxify-backup-....tar.gz`,
   confirm, and say **yes** to restoring `infra/.env` too — you want the
   *original* JWT/encryption secrets back, not the fresh ones step 2
   generated, otherwise `CREDENTIALS_ENCRYPTION_KEY` won't match what
   encrypted the restored `ProtocolUser.credentialsJson` rows and every
   read will throw.
5. Re-point DNS/TLS if the new box has a different IP (re-run certbot via
   the panel menu's nginx/TLS step if needed).
6. Every agent node needs to reconnect: their gRPC stream will retry
   against the same panel hostname automatically once DNS resolves to
   the new box and the agent-gateway TLS cert (restored in step 4) is in
   place — no agent-side action needed.

## Testing a restore without touching production

Point a throwaway box (or a local Docker Compose stack using
`infra/docker-compose.prod.yml` with dummy `POSTGRES_PASSWORD`) at a copy
of a real backup archive and run `restore.sh` there. This is exactly how
`backup.sh`/`restore.sh` were verified during development: a real
Postgres container was seeded with data, backed up, corrupted, restored,
and the restored data was diffed against the original — including the
`--yes`-mode behavior for `infra/.env` (skipped when one already exists,
auto-restored when one doesn't) and the certs restore. Re-run that same
exercise periodically (e.g. after any schema migration) rather than
trusting backups you've never actually restored from.
