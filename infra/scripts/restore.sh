#!/usr/bin/env bash
# Restores a panel server from a backup produced by backup.sh: drops and
# recreates the Postgres database from the bundled pg_dump, and
# optionally restores the agent-gateway TLS certs and infra/.env.
#
# Usage:
#   sudo ./restore.sh /var/backups/neoxify/neoxify-backup-20260723-030000.tar.gz
#   sudo ./restore.sh --latest [backup-dir]   # picks the newest backup in backup-dir (default /var/backups/neoxify)
#
# This is destructive: it drops the live database before restoring.
# Requires typing "yes" at a confirmation prompt (skip with --yes for
# non-interactive/scripted disaster-recovery runs, e.g. from a fresh
# box's own first-boot script).
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: this script must be run as root (try: sudo ./restore.sh <backup.tar.gz>)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROD_COMPOSE="$REPO_ROOT/infra/docker-compose.prod.yml"
PROD_ENV="$REPO_ROOT/infra/.env"
CERTS_DIR="/etc/neoxify/certs"

skip_confirm=false
backup_arg=""
latest_dir="/var/backups/neoxify"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) skip_confirm=true; shift ;;
    --latest)
      shift
      [[ $# -gt 0 && "$1" != --* ]] && { latest_dir="$1"; shift; }
      backup_arg="__latest__"
      ;;
    *) backup_arg="$1"; shift ;;
  esac
done

if [[ -z "$backup_arg" ]]; then
  echo "Usage: sudo ./restore.sh <backup.tar.gz> | --latest [backup-dir]" >&2
  exit 1
fi

if [[ "$backup_arg" == "__latest__" ]]; then
  # shellcheck disable=SC2012
  archive="$(ls -1t "$latest_dir"/neoxify-backup-*.tar.gz 2>/dev/null | head -n1)"
  if [[ -z "$archive" ]]; then
    echo "ERROR: no neoxify-backup-*.tar.gz found in $latest_dir" >&2
    exit 1
  fi
else
  archive="$backup_arg"
fi

if [[ ! -f "$archive" ]]; then
  echo "ERROR: backup file not found: $archive" >&2
  exit 1
fi

if [[ ! -f "$PROD_COMPOSE" ]]; then
  echo "ERROR: $PROD_COMPOSE not found -- run this from a checked-out copy of the repo." >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "Extracting $archive..."
tar -xzf "$archive" -C "$work_dir"

if [[ ! -f "$work_dir/database.dump" ]]; then
  echo "ERROR: $archive does not contain a database.dump -- not a valid backup.sh archive." >&2
  exit 1
fi

has_certs=false
[[ -d "$work_dir/certs" ]] && has_certs=true
has_env=false
[[ -f "$work_dir/infra.env" ]] && has_env=true

echo
echo "About to restore from: $archive"
echo "  - database.dump ($(stat -c%s "$work_dir/database.dump" 2>/dev/null || stat -f%z "$work_dir/database.dump") bytes) -> will REPLACE the live 'neoxify' database"
[[ "$has_certs" == true ]] && echo "  - certs/ -> will replace $CERTS_DIR"
[[ "$has_env" == true ]] && echo "  - infra.env -> available to restore over $PROD_ENV (asked separately below)"
echo

if [[ "$skip_confirm" != true ]]; then
  read -r -p "Type 'yes' to proceed with the database restore: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

restore_env=false
if [[ "$has_env" == true ]]; then
  if [[ ! -f "$PROD_ENV" ]]; then
    echo "No existing $PROD_ENV -- restoring it from the backup (needed to bring the stack up at all)."
    restore_env=true
  elif [[ "$skip_confirm" == true ]]; then
    restore_env=false
  else
    read -r -p "Also overwrite $PROD_ENV with the backed-up copy? [y/N]: " env_confirm
    [[ "${env_confirm,,}" == "y" ]] && restore_env=true
  fi
fi

if [[ "$restore_env" == true ]]; then
  install -d -m 755 "$(dirname "$PROD_ENV")"
  cp "$work_dir/infra.env" "$PROD_ENV"
  chmod 600 "$PROD_ENV"
  echo "Restored $PROD_ENV."
fi

if [[ ! -f "$PROD_ENV" ]]; then
  echo "ERROR: $PROD_ENV still doesn't exist and the backup had none to restore -- cannot start the stack." >&2
  exit 1
fi

echo "Ensuring postgres is up..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" up -d postgres
echo "Waiting for postgres to become healthy..."
tries=0
until docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" exec -T postgres pg_isready -U neoxify >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [[ $tries -gt 30 ]]; then
    echo "ERROR: postgres did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

echo "Stopping backend/panel so nothing writes during restore..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" stop backend panel 2>/dev/null || true

echo "Dropping and recreating the 'neoxify' database..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" exec -T postgres psql -U neoxify -d postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'neoxify' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS neoxify;
CREATE DATABASE neoxify OWNER neoxify;
SQL

echo "Restoring database from dump..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" exec -T postgres \
  pg_restore -U neoxify -d neoxify --no-owner < "$work_dir/database.dump"

if [[ "$has_certs" == true ]]; then
  echo "Restoring $CERTS_DIR..."
  install -d -m 755 "$CERTS_DIR"
  cp -a "$work_dir/certs/." "$CERTS_DIR/"
  chmod 644 "$CERTS_DIR"/*.pem 2>/dev/null || true
fi

echo "Starting the full stack..."
docker compose -f "$PROD_COMPOSE" --env-file "$PROD_ENV" up -d

echo "Waiting for the backend to become healthy..."
tries=0
until curl -fsS http://127.0.0.1:4000/health >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [[ $tries -gt 60 ]]; then
    echo "ERROR: backend did not become healthy after restore. Check: docker compose -f $PROD_COMPOSE logs backend" >&2
    exit 1
  fi
  sleep 2
done

echo "Restore complete."
