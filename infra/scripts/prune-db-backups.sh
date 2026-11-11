#!/usr/bin/env bash
# Thins out the ad-hoc database dumps taken before admin steps on the
# panel host (the *.sql.gz files in /root/db-backups, written by hand as
# "pg_dump ... | gzip > /root/db-backups/pre-<what>-<time>.sql.gz").
#
# These are NOT the nightly backups. Those are the tarballs backup.sh
# writes to /var/backups/neoxify, and backup.sh rotates them itself.
# This script never looks there.
#
# Why it exists: a dump was taken before every small step, sometimes 15
# in one day, and nothing ever deleted them. By 2026-11-11 there were 78
# of them filling 9.4 GB of a 38 GB disk. The owner approved thinning
# them by the rule below and asked for it to happen automatically.
#
# The rule (all dates are UTC, taken from each file's modification time):
#   - keep the newest dump of each of the last 7 days (today and the
#     6 days before it);
#   - keep the newest dump of each of the 8 ISO weeks before that;
#   - always keep the newest dump overall, whatever else happens;
#   - delete everything else, including anything older than those 8
#     weeks.
# So a bad change can be rolled back to any recent day, and to roughly
# one point per week for two months back.
#
# Only files matching *.sql.gz directly in the directory are considered.
# Notes, logs, json and anything else in the folder are left alone.
#
# Safety: it refuses to run if the directory holds fewer than 3 dumps
# (something is off, or there is nothing worth thinning), or if the
# keep set would come out empty.
#
# Usage: prune-db-backups.sh [--dry-run] [dir]
#   dir        defaults to /root/db-backups
#   --dry-run  print what would be deleted, delete nothing
#
# Prints the files it deletes (or would delete), then one summary line:
#   <time> kept N, deleted M, freed X MB
#
# Installed on the panel host as /usr/local/sbin/neoxify-prune-db-backups,
# run daily at 03:40 UTC by /etc/cron.d/neoxify-db-backups-prune, which
# appends the output to /var/log/neoxify-db-backups-prune.log.
set -euo pipefail

DRY_RUN=0
DIR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown option $arg" >&2; exit 2 ;;
    *) DIR="$arg" ;;
  esac
done
DIR="${DIR:-/root/db-backups}"

if [[ ! -d "$DIR" ]]; then
  echo "ERROR: $DIR is not a directory." >&2
  exit 1
fi

# One line per dump: "<mtime seconds> <size bytes> <name>", newest first.
# Names here never contain newlines (we write them ourselves).
mapfile -t dumps < <(find "$DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %s %f\n' \
  | awk '{ split($1, t, "."); $1 = t[1]; print }' | sort -rn -k1,1)

if [[ "${#dumps[@]}" -lt 3 ]]; then
  echo "ERROR: only ${#dumps[@]} dump(s) in $DIR -- refusing to prune fewer than 3." >&2
  exit 1
fi

# The first day of the recent window: today minus 6 days, as YYYY-MM-DD.
today="$(date -u +%F)"
window_start="$(date -u -d "$today -6 days" +%F)"

# The 8 ISO weeks before the window: the week holding the day just
# before the window, and the 7 weeks before that. (That first week can
# overlap the window; its days inside the window are covered by the
# per-day rule, the older ones by this one.)
declare -A allowed_week=()
for i in 0 1 2 3 4 5 6 7; do
  allowed_week["$(date -u -d "$window_start -$((1 + 7 * i)) days" +%G-W%V)"]=1
done

declare -A seen=()
keep=()
drop=()
drop_bytes=0
first=1
for line in "${dumps[@]}"; do
  read -r mtime size name <<<"$line"
  day="$(date -u -d "@$mtime" +%F)"
  if [[ "$day" > "$window_start" || "$day" == "$window_start" ]]; then
    bucket="day $day"
  else
    week="$(date -u -d "@$mtime" +%G-W%V)"
    if [[ -n "${allowed_week[$week]:-}" ]]; then
      bucket="week $week"
    else
      bucket=""   # older than the 8 weeks: no bucket, always deleted
    fi
  fi

  # The list is newest first, so the first file seen in a bucket is the
  # one to keep. The very first file is the newest overall and is kept
  # no matter which bucket it falls in.
  if [[ "$first" -eq 1 ]] || { [[ -n "$bucket" ]] && [[ -z "${seen[$bucket]:-}" ]]; }; then
    [[ -n "$bucket" ]] && seen["$bucket"]=1
    keep+=("$name")
  else
    drop+=("$size $name")
    drop_bytes=$((drop_bytes + size))
  fi
  first=0
done

if [[ "${#keep[@]}" -eq 0 ]]; then
  echo "ERROR: the keep set came out empty -- refusing to delete anything." >&2
  exit 1
fi

for entry in "${drop[@]}"; do
  read -r size name <<<"$entry"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would delete: $name ($size bytes)"
  else
    echo "deleted: $name ($size bytes)"
    rm -f -- "$DIR/$name"
  fi
done

prefix=""
[[ "$DRY_RUN" -eq 1 ]] && prefix="DRY RUN: "
echo "$(date -u +%FT%TZ) ${prefix}kept ${#keep[@]}, deleted ${#drop[@]}, freed $((drop_bytes / 1048576)) MB ($DIR)"
