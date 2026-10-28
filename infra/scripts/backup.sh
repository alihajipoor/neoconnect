#!/usr/bin/env bash
# Backs up everything needed to rebuild a panel server from scratch:
# the Postgres database (pg_dump custom format, via the running
# container -- no separate postgres-client install needed on the host),
# the agent-gateway TLS cert copies, and infra/.env (JWT/encryption
# secrets, Stripe/NowPayments keys). All three are bundled into one
# timestamped tarball so retention/rotation only has to reason about one
# file per backup.
#
# Usage: sudo ./backup.sh [backup-dir]
#   BACKUP_DIR   defaults to /var/backups/neoxify, override via arg or env
#   BACKUP_KEEP  how many recent backups to retain (default 14)
#
# Intended to run daily via cron/systemd timer, e.g.:
#   0 3 * * * /path/to/neoxify-hub/infra/scripts/backup.sh
#
# The resulting tarball contains real secrets (DB contents, JWT
# secrets, payment provider API keys) -- it is created 0600 root-only,
# but that only protects it on this box. Copy backups off-box to
# separate storage; this script does not do that for you.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: this script must be run as root (try: sudo ./backup.sh)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROD_COMPOSE="$REPO_ROOT/infra/docker-compose.prod.yml"
PROD_ENV="$REPO_ROOT/infra/.env"
CERTS_DIR="/etc/neoxify/certs"

BACKUP_DIR="${1:-${BACKUP_DIR:-/var/backups/neoxify}}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

if [[ ! -f "$PROD_ENV" ]]; then
  echo "ERROR: $PROD_ENV not found -- is this a panel server? (run installer/install.sh first)" >&2
  exit 1
fi

if ! docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" ps postgres --status running --quiet >/dev/null 2>&1 \
    || [[ -z "$(docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" ps postgres --status running --quiet)" ]]; then
  echo "ERROR: the postgres container isn't running (docker compose -f $PROD_COMPOSE ps). Nothing to back up." >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

install -d -m 700 "$BACKUP_DIR"

echo "Dumping database..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" exec -T postgres \
  pg_dump -U neoxify -Fc neoxify > "$work_dir/database.dump"

dump_size=$(stat -c%s "$work_dir/database.dump" 2>/dev/null || stat -f%z "$work_dir/database.dump")
if [[ "$dump_size" -lt 100 ]]; then
  echo "ERROR: database dump looks empty/truncated ($dump_size bytes) -- aborting, not writing a backup." >&2
  exit 1
fi
echo "  database.dump: $dump_size bytes"

if [[ -d "$CERTS_DIR" ]]; then
  echo "Copying agent-gateway TLS certs..."
  cp -a "$CERTS_DIR" "$work_dir/certs"
else
  echo "  (no $CERTS_DIR -- TLS not configured yet, skipping)"
fi

echo "Copying infra/.env..."
cp "$PROD_ENV" "$work_dir/infra.env"

archive="$BACKUP_DIR/neoxify-backup-$timestamp.tar.gz"
tar -czf "$archive" -C "$work_dir" .
chmod 600 "$archive"

archive_size=$(stat -c%s "$archive" 2>/dev/null || stat -f%z "$archive")
echo "Backup written: $archive ($archive_size bytes)"

echo "Applying retention (keeping last $BACKUP_KEEP)..."
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/neoxify-backup-*.tar.gz 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r old; do
  echo "  removing old backup: $old"
  rm -f "$old"
done

echo "Done."
