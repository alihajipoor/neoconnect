#!/usr/bin/env bash
#
# Deploys the web portal (apps/web-portal) to https://neoxify.net/account/.
#
# How /account/ was deployed before this script
# ---------------------------------------------
# By hand, with the rest of the site. `pnpm --filter @neoxify/web-portal
# build` writes the portal straight into website/account/ (vite.config.ts:
# outDir, base "/account/"; the directory is gitignored), whose prebuild
# fetches the signed endpoint bundle the portal is built against. Then
# `bash website/make-zip.sh` zipped the whole website/ tree, account/
# included, and the zip was unzipped over the document root by hand.
# Nothing built the portal before zipping, so a stale account/ shipped
# unless someone remembered; nothing kept the previous version; and an
# unzip over a live site is never atomic.
#
# What this does instead, for account/ only
# -----------------------------------------
#   1. Refuses a working tree with uncommitted changes (--allow-dirty to
#      override), and records the commit it deploys.
#   2. Builds the portal, requiring a real endpoint bundle: a portal built
#      without one cannot reach the API's mirrors from a censored network.
#   3. Checks the build locally: the page, its script, stylesheet, typeface,
#      licences and Content-Security-Policy are all there, and the script
#      carries the signed bundle the checkout has.
#   4. Connects as the neoxify.net site's own user, to a host key the owner
#      has confirmed. The host is SHARED with other sites and a hosting panel
#      (owner, 2026-10-19), so: never root, nothing outside the site's own
#      folder, no service reloads, no server-wide changes.
#   5. Finds the site's document root in the nginx configuration (read
#      only), unless NEOXIFY_WEB_ROOT says it, and refuses any directory
#      that is not this PHP site (no index.php and inc/bootstrap.php).
#   6. Backs up the live account/ to $NEOXIFY_WEB_BACKUPS/account-<UTC>.tgz,
#      outside the document root.
#   7. Uploads the build to a staging directory beside it, copies in the
#      hashed files of the build going down (a browser still holding the old
#      page asks for them; see SWAP_IN), then swaps it in: atomically where
#      the host's mv has --exchange, otherwise by two renames a few
#      microseconds apart.
#   8. Checks https://neoxify.net/account/ answers 200 with the new build's
#      own file names, that those files are served as what they are (a
#      fallback that answers a missing file with a page is a failure), and
#      that no server Content-Security-Policy would block the page's loader,
#      its first-paint styles or its calls to the API's mirrors. If a check
#      fails, it swaps the previous build back (unless --no-auto-rollback).
#   9. Logs what went live to $NEOXIFY_WEB_BACKUPS/deploys.log on the host,
#      and prints how to roll back.
#
# A rollback (--rollback) puts a backup back live and checks it the same
# way, as far as that backup's own page says what to check. It never swaps
# itself back: if its check fails, the restored build stays live and the
# script says so -- putting back the build being rolled away from is never
# what a rollback is for.
#
# Usage
#   NEOXIFY_WEB_USER=<site user> scripts/deploy-portal.sh [--dry-run]
#   NEOXIFY_WEB_USER=<site user> scripts/deploy-portal.sh --rollback <backup .tgz on the host>
#
# Options
#   --dry-run            build and check locally, print the plan, never connect.
#   --skip-build         deploy website/account/ as it is (it must be built).
#   --allow-dirty        deploy from a working tree with uncommitted changes.
#   --rollback <path>    put a backup made by an earlier run back live.
#   --no-auto-rollback   on a failed check, leave the new build live.
#
# Environment
#   NEOXIFY_WEB_USER         required (not for --dry-run). The neoxify.net site's
#                            SSH/SFTP user. root is refused.
#   NEOXIFY_WEB_HOST         default neoxify.net (the address may be given instead).
#   NEOXIFY_WEB_PORT         default 22.
#   NEOXIFY_WEB_KEY          default ~/.ssh/neoxify_web. Key only: never a password.
#   NEOXIFY_WEB_KNOWN_HOSTS  default ~/.ssh/known_hosts. The host's key must be in
#                            it; nothing is trusted on first sight.
#   NEOXIFY_WEB_HOST_KEY     the host key's SHA256 fingerprint as the owner read it
#                            on the host (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).
#                            Needed once, while the host is not yet known: the key
#                            the host offers is added only if it matches.
#   NEOXIFY_WEB_ROOT         the document root on the host; discovered when unset.
#   NEOXIFY_WEB_BACKUPS      default web-backups in the user's home on the host.
#   NEOXIFY_SITE_URL         default https://neoxify.net.
#   NEOXIFY_DEPLOY_CHECK_WAIT  seconds between live checks, default 5.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO/website/account"
SEED="$REPO/apps/desktop-windows/src/lib/seed-bundle.json"

WEB_USER="${NEOXIFY_WEB_USER:-}"
WEB_HOST="${NEOXIFY_WEB_HOST:-neoxify.net}"
WEB_PORT="${NEOXIFY_WEB_PORT:-22}"
WEB_KEY="${NEOXIFY_WEB_KEY:-$HOME/.ssh/neoxify_web}"
KNOWN_HOSTS="${NEOXIFY_WEB_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
HOST_KEY_SHA256="${NEOXIFY_WEB_HOST_KEY:-}"
WEB_ROOT="${NEOXIFY_WEB_ROOT:-}"
WEB_BACKUPS="${NEOXIFY_WEB_BACKUPS:-}"
SITE_URL="${NEOXIFY_SITE_URL:-https://neoxify.net}"
SITE_URL="${SITE_URL%/}"
CHECK_WAIT="${NEOXIFY_DEPLOY_CHECK_WAIT:-5}"

DRY_RUN=0
SKIP_BUILD=0
ALLOW_DIRTY=0
AUTO_ROLLBACK=1
ROLLBACK_FROM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --no-auto-rollback) AUTO_ROLLBACK=0 ;;
    --rollback)
      [ $# -ge 2 ] || { echo "error: --rollback needs the backup's path on the host" >&2; exit 2; }
      ROLLBACK_FROM="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown option $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

# A rollback that fails its check leaves what it restored live: swapping
# back would put up the very build it was run to take down.
[ -z "$ROLLBACK_FROM" ] || AUTO_ROLLBACK=0

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
say() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. What is being deployed ----------------------------------------------
COMMIT=""
if [ -z "$ROLLBACK_FROM" ]; then
  COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    if [ "$ALLOW_DIRTY" = 1 ]; then
      COMMIT="$COMMIT-dirty"
    elif [ "$DRY_RUN" = 1 ]; then
      echo "note: the working tree has uncommitted changes; a real run refuses it without --allow-dirty"
      COMMIT="$COMMIT-dirty"
    else
      git -C "$REPO" status --short >&2
      die "the working tree has uncommitted changes: commit them first, or pass --allow-dirty (the deploy is then logged as $COMMIT-dirty)"
    fi
  fi
  if [ "$COMMIT" != unknown ] && [ -z "$(git -C "$REPO" branch -r --contains "${COMMIT%-dirty}" 2>/dev/null)" ]; then
    echo "note: commit ${COMMIT%-dirty} is not on any remote branch yet"
  fi
  [ "$SKIP_BUILD" = 0 ] || COMMIT="$COMMIT (working tree; website/account/ built earlier, --skip-build)"
fi

# --- 2. Build ------------------------------------------------------------
if [ -z "$ROLLBACK_FROM" ] && [ "$SKIP_BUILD" = 0 ]; then
  say "Building the portal (a real endpoint bundle is required)"
  (cd "$REPO" && NEOXIFY_REQUIRE_SEED=1 pnpm --filter @neoxify/web-portal build)
fi

# --- 3. Reading a page ---------------------------------------------------------
# What a built page will ask for, and the hashes its own policy allows.
# A build of this portal names its files in <meta name="pa-boot">
# (apps/web-portal/portal-html.ts); the portal before it did not, and is
# read from its module script and stylesheet tags instead.
boot_attr() { grep -o "<meta name=\"pa-boot\"[^>]*>" "$1" | grep -o " data-$2=\"[^\"]*\"" | cut -d'"' -f2 || true; }
policy_hash() { grep -o "$2 'self' 'sha256-[^']*'" "$1" | grep -o "sha256-[^']*" | head -1 || true; }
read_page() {
  BOOT=0 JS="" CSS="" FONT="" HASH="" STYLE_HASH=""
  if grep -q '<meta name="pa-boot"' "$1"; then
    BOOT=1
    JS="$(boot_attr "$1" js)"
    CSS="$(boot_attr "$1" css)"
    FONT="$(boot_attr "$1" font)"
  else
    JS="$(grep -o '<script type="module"[^>]* src="[^"]*"' "$1" | grep -o 'src="[^"]*"' | cut -d'"' -f2 | head -1 || true)"
    CSS="$(grep -o '<link rel="stylesheet"[^>]* href="[^"]*"' "$1" | grep -o 'href="[^"]*"' | cut -d'"' -f2 | head -1 || true)"
  fi
  HASH="$(policy_hash "$1" script-src)"
  STYLE_HASH="$(policy_hash "$1" style-src)"
}

if [ -z "$ROLLBACK_FROM" ]; then
  say "Checking the build in website/account/"
  [ -f "$BUILD_DIR/index.html" ] || die "no website/account/index.html: build the portal first (or drop --skip-build)"
  read_page "$BUILD_DIR/index.html"
  [ "$BOOT" = 1 ] && [ -n "$JS" ] && [ -n "$CSS" ] && [ -n "$FONT" ] || die "index.html has no complete <meta name=\"pa-boot\">: not a build of this portal"
  [ -n "$HASH" ] && [ -n "$STYLE_HASH" ] || die "index.html carries no Content-Security-Policy with the loader's and the first paint's hashes"
  for path in "$JS" "$CSS" "$FONT"; do
    case "$path" in /account/*) ;; *) die "unexpected asset path $path (the portal is served from /account/)" ;; esac
    [ -f "$BUILD_DIR/${path#/account/}" ] || die "the page asks for $path, which the build does not contain"
  done
  for lic in Inter-OFL.txt InterTight-OFL.txt Vazirmatn-OFL.txt world-atlas-LICENSE.txt; do
    [ -f "$BUILD_DIR/licenses/$lic" ] || die "licence missing from the build: licenses/$lic"
  done
  # A real seed only: the placeholder bundle carries no endpoints, and a
  # portal built on it cannot find the API's mirrors from a censored
  # network. And the one this checkout has, inside the build: with
  # --skip-build, website/account/ may predate it.
  [ -f "$SEED" ] || die "no endpoint bundle at apps/desktop-windows/src/lib/seed-bundle.json"
  sig="$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!s.payload || !s.sig || s.key === "placeholder") process.exit(1); process.stdout.write(s.sig)' "$SEED")" \
    || die "the endpoint bundle here is the placeholder, not the signed one"
  grep -rqF -- "$sig" "$BUILD_DIR/assets" \
    || die "website/account/ was not built on this checkout's signed endpoint bundle: rebuild it (drop --skip-build)"
  echo "commit $COMMIT"
  echo "page   $SITE_URL/account/"
  echo "script $JS"
  echo "styles $CSS"
  echo "font   $FONT"
  echo "csp    script-src 'self' '$HASH'; style-src 'self' '$STYLE_HASH'"
  echo "files  $(find "$BUILD_DIR" -type f | wc -l | tr -d ' '), $(du -sk "$BUILD_DIR" | cut -f1) KB"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: nothing was uploaded"
  cat <<EOF
A real run would connect as \${NEOXIFY_WEB_USER} to $WEB_HOST:$WEB_PORT with $WEB_KEY,
find neoxify.net's document root (${WEB_ROOT:-from the nginx config}), back up
its account/ to ${WEB_BACKUPS:-~/web-backups}/account-$STAMP.tgz, upload this build to a
staging directory beside it, swap it in, and check $SITE_URL/account/.
EOF
  exit 0
fi

# --- 4. Connect --------------------------------------------------------------
[ -n "$WEB_USER" ] || die "set NEOXIFY_WEB_USER to the neoxify.net site's own SSH user"
[ "$WEB_USER" != root ] || die "refusing to deploy as root: the host is shared, use the neoxify.net site's own user"
[ -f "$WEB_KEY" ] || die "no SSH key at $WEB_KEY"

# The host's key, as the owner confirmed it -- never whatever answers first.
hostspec="$WEB_HOST"
[ "$WEB_PORT" = 22 ] || hostspec="[$WEB_HOST]:$WEB_PORT"
if ! ssh-keygen -F "$hostspec" -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
  offered="$(ssh-keyscan -p "$WEB_PORT" "$WEB_HOST" 2>/dev/null | grep -v '^#' || true)"
  [ -n "$offered" ] || die "$WEB_HOST is not in $KNOWN_HOSTS, and ssh-keyscan could not read its key either"
  prints="$(printf '%s\n' "$offered" | while IFS= read -r line; do printf '%s\n' "$line" | ssh-keygen -lf - 2>/dev/null; done)"
  if [ -z "$HOST_KEY_SHA256" ]; then
    printf 'The host offers:\n%s\n' "$prints" >&2
    die "$hostspec is not in $KNOWN_HOSTS. Have the owner read the key on the host (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub); if it matches one above, run again with NEOXIFY_WEB_HOST_KEY=<that SHA256:... fingerprint>"
  fi
  match=""
  while IFS= read -r line; do
    [ "$(printf '%s\n' "$line" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')" = "$HOST_KEY_SHA256" ] && match="$line"
  done <<<"$offered"
  [ -n "$match" ] || die "$WEB_HOST does not offer the key $HOST_KEY_SHA256 (it offers: $(printf '%s' "$prints" | awk '{print $2}' | tr '\n' ' ')). Not connecting."
  mkdir -p "$(dirname "$KNOWN_HOSTS")"
  printf '%s\n' "$match" >>"$KNOWN_HOSTS"
  echo "host key $HOST_KEY_SHA256 confirmed and added to $KNOWN_HOSTS"
fi

SSH=(ssh -i "$WEB_KEY" -p "$WEB_PORT"
  -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no
  -o ConnectTimeout=20 -o ServerAliveInterval=15
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS"
  "$WEB_USER@$WEB_HOST")
remote() { "${SSH[@]}" "$@"; }
# Each argument quoted for the remote shell.
q() { printf '%q ' "$@"; }

remote true || die "cannot log in as $WEB_USER@$WEB_HOST: the key $WEB_KEY is not authorised for that user, or it is an SFTP-only account (this script needs a shell)"

# --- 5. Find and check the document root (read only) ---------------------------
say "Finding neoxify.net's document root on $WEB_HOST"
# Prints the server-level `root` of every nginx server block whose
# server_name list has neoxify.net itself (not www.), from whatever
# configuration this user can read. Comments are dropped; includes are
# not followed (the files that hold the server block are read directly).
FIND_ROOT=$(cat <<'REMOTE'
set -u
files=$(grep -rlsE 'server_name[^;]*[[:space:]]neoxify\.net([[:space:]]|;)' \
  /etc/nginx /usr/local/nginx/conf /usr/local/etc/nginx /www/server/panel/vhost/nginx \
  /var/www/vhosts/system/neoxify.net/conf /etc/sentora /usr/local/lsws/conf 2>/dev/null | sort -u)
{ [ -n "$files" ] && cat $files; nginx -T 2>/dev/null; } | awk '
  function trim(x) { gsub(/^[ \t\r\n]+|[ \t\r\n]+$/, "", x); return x }
  { sub(/#.*/, ""); buf = buf $0 " " }
  END {
    depth = 0; stmt = ""; inserver = 0; sdepth = -1
    n = length(buf)
    for (i = 1; i <= n; i++) {
      c = substr(buf, i, 1)
      if (c == "{") {
        s = trim(stmt); stmt = ""; depth++
        if (!inserver && s == "server") { inserver = 1; sdepth = depth; names = " "; root = "" }
      } else if (c == "}") {
        if (inserver && depth == sdepth) {
          if (names ~ / neoxify\.net / && root != "") print root
          inserver = 0; sdepth = -1
        }
        depth--; stmt = ""
      } else if (c == ";") {
        s = trim(stmt); stmt = ""
        if (inserver && depth == sdepth) {
          if (s ~ /^server_name[ \t]/) { sub(/^server_name[ \t]+/, "", s); gsub(/[ \t]+/, " ", s); names = names s " " }
          else if (s ~ /^root[ \t]/) { sub(/^root[ \t]+/, "", s); gsub(/["\047]/, "", s); root = s }
        }
      } else stmt = stmt c
    }
  }' | sort -u
REMOTE
)

if [ -z "$WEB_ROOT" ]; then
  roots="$(remote "bash -s" <<<"$FIND_ROOT")" || die "could not read the nginx configuration on $WEB_HOST: set NEOXIFY_WEB_ROOT"
  count="$(printf '%s\n' "$roots" | grep -c . || true)"
  if [ "$count" != 1 ]; then
    printf 'Found %s candidate document root(s) for neoxify.net in the nginx configuration this user can read:\n%s\n' "$count" "${roots:-  (none)}" >&2
    die "set NEOXIFY_WEB_ROOT to the site's document root and run again"
  fi
  WEB_ROOT="$roots"
  case "$WEB_ROOT" in *'$'*) die "the nginx root is not a plain path ($WEB_ROOT): set NEOXIFY_WEB_ROOT" ;; esac
  echo "nginx says: root $WEB_ROOT"
fi

# Resolves and checks the root, the backup directory and the upload
# directory; prints KEY=value.
PREFLIGHT=$(cat <<'REMOTE'
set -eu
root="$1"; backups="$2"
# Canonical without needing the path to exist yet.
canon() { realpath -m -- "$1" 2>/dev/null || readlink -m -- "$1" 2>/dev/null || printf '%s\n' "$1"; }
# Whether $1 is $2 or inside it.
within() { case "$1/" in "${2%/}"/*) return 0 ;; esac; return 1; }
case "$root" in /*) ;; *) echo "FAIL=the document root must be an absolute path" ; exit 0 ;; esac
[ -d "$root" ] || { echo "FAIL=no directory $root"; exit 0; }
root="$(cd "$root" && pwd -P)"
case "$root" in /|/root|/home|"$HOME") echo "FAIL=refusing $root as a document root"; exit 0 ;; esac
[ -f "$root/index.php" ] && [ -f "$root/inc/bootstrap.php" ] || { echo "FAIL=$root is not the neoxify.net PHP site (no index.php and inc/bootstrap.php)"; exit 0; }
[ -w "$root" ] || { echo "FAIL=this user cannot write to $root"; exit 0; }
[ -L "$root/account" ] && { echo "FAIL=$root/account is a symlink; not touching an unexpected layout"; exit 0; }
[ -n "$backups" ] || backups="$HOME/web-backups"
case "$backups" in /*) ;; *) backups="$HOME/$backups" ;; esac
backups="$(canon "$backups")"
uploads="$(canon "$HOME/.neoxify-deploy")"
# Neither may be served (inside the root), and neither may be the root or
# a directory above it: making that private would take the site down.
place() {
  if within "$root" "$2"; then echo "FAIL=the $1 directory $2 is the document root or a directory above it; give one beside it"; return 1; fi
  if within "$2" "$root"; then echo "FAIL=the $1 directory $2 is inside the document root, where it would be served"; return 1; fi
  return 0
}
place backup "$backups" || exit 0
place upload "$uploads" || exit 0
# Made private only when this run creates it: a directory that is already
# there keeps its permissions.
[ -d "$backups" ] || { mkdir -p "$backups" && chmod 700 "$backups"; }
[ -d "$uploads" ] || { mkdir -p "$uploads" && chmod 700 "$uploads"; }
backups="$(cd "$backups" && pwd -P)"
uploads="$(cd "$uploads" && pwd -P)"
place backup "$backups" || exit 0
place upload "$uploads" || exit 0
echo "ROOT=$root"
echo "BACKUPS=$backups"
echo "UPLOADS=$uploads"
echo "HAS_ACCOUNT=$([ -d "$root/account" ] && echo yes || echo no)"
echo "EXCHANGE=$(mv --help 2>/dev/null | grep -q -- '--exchange' && echo yes || echo no)"
echo "FREE_KB=$(df -Pk "$root" | awk 'NR==2 {print $4}')"
REMOTE
)

pre="$(remote "bash -s -- $(q "$WEB_ROOT" "$WEB_BACKUPS")" <<<"$PREFLIGHT")"
kv() { printf '%s\n' "$pre" | sed -n "s/^$1=//p" | head -1; }
[ -z "$(kv FAIL)" ] || die "$(kv FAIL)"
WEB_ROOT="$(kv ROOT)"
WEB_BACKUPS="$(kv BACKUPS)"
UPLOAD_DIR="$(kv UPLOADS)"
HAS_ACCOUNT="$(kv HAS_ACCOUNT)"
[ -n "$WEB_ROOT" ] && [ -n "$WEB_BACKUPS" ] && [ -n "$UPLOAD_DIR" ] || die "the host's preflight answered nothing usable"
echo "root    $WEB_ROOT (account/ live: $HAS_ACCOUNT)"
echo "backups $WEB_BACKUPS"
echo "swap    $([ "$(kv EXCHANGE)" = yes ] && echo 'atomic (mv --exchange)' || echo 'two renames')"
echo "free    $(kv FREE_KB) KB"

# Puts the account/ inside a .tgz on the host live: unpacks it next to the
# live one, carries over the hashed files of the build going down, swaps
# the two, and keeps the one taken down in the staging directory until the
# caller removes it. Prints STAGE=, BACKUP=, SWAP=, CARRIED=, DROPPED=.
#
# Why carry files over: the host sends no Cache-Control, so a browser may
# reuse the old index.html for a while (heuristically, a tenth of its age)
# and then ask for the old build's script and stylesheet by their hashed
# names. Deleting them would leave that visitor on the map with no card.
# Hashed names cannot collide. The live build's own files are carried and
# dated today -- the day they went out of use; files carried by an earlier
# run are carried again only while they are under KEEP_DAYS old, which is
# how they are pruned. $backups/live-assets.txt names the live build's own
# files; the caller puts this run's list there once the new build stays.
SWAP_IN=$(cat <<'REMOTE'
set -eu
root="$1"; backups="$2"; stamp="$3"; tgz="$4"; backup_first="$5"
KEEP_DAYS=30
case "$backups/" in "$root"/*) echo "FAIL=the backup directory is inside the document root"; exit 0 ;; esac
cd "$root"
umask 022
if [ "$backup_first" = yes ] && [ -d account ]; then
  backup="$backups/account-$stamp.tgz"
  tar -czf "$backup" -C "$root" account
  tar -tzf "$backup" >/dev/null
  echo "BACKUP=$backup"
fi
stage=".account-deploy-$stamp"
rm -rf -- "$stage"
mkdir "$stage"
tar -xzf "$tgz" -C "$stage" --no-same-owner
[ -f "$stage/account/index.html" ] || { echo "FAIL=the archive holds no account/index.html"; rm -rf -- "$stage"; exit 0; }
mkdir -p "$stage/account/assets"
(cd "$stage/account/assets" && ls -A) >"$backups/assets-$stamp.txt"
carried=0 dropped=0
own="$backups/live-assets.txt"
if [ -d account/assets ]; then
  for f in account/assets/*; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    [ -e "$stage/account/assets/$name" ] && continue
    if [ ! -f "$own" ] || grep -qxF -- "$name" "$own"; then
      cp -- "$f" "$stage/account/assets/$name"
      carried=$((carried + 1))
    elif [ -n "$(find "$f" -mtime -"$KEEP_DAYS" -print)" ]; then
      cp -p -- "$f" "$stage/account/assets/$name"
      carried=$((carried + 1))
    else
      dropped=$((dropped + 1))
    fi
  done
fi
echo "CARRIED=$carried"
echo "DROPPED=$dropped"
chmod -R u=rwX,go=rX "$stage/account"
if [ -d account ]; then chmod --reference=account "$stage/account" 2>/dev/null || true; fi
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$stage/account" 2>/dev/null || true; fi
if [ -d account ]; then
  if mv --exchange -T "$stage/account" account 2>/dev/null; then
    echo "SWAP=exchange"
  else
    mv -T account "$stage/account.previous" && mv -T "$stage/account" account
    mv -T "$stage/account.previous" "$stage/account"
    echo "SWAP=rename"
  fi
else
  mv -T "$stage/account" account
  echo "SWAP=new"
fi
echo "STAGE=$root/$stage"
REMOTE
)

# --- 6 and 7. Back up, upload, swap ----------------------------------------------
# Uploads go to a private directory outside the document root (checked
# above), where a half-written archive is never served.
UPLOADED=""
if [ -n "$ROLLBACK_FROM" ]; then
  say "Rolling back to $ROLLBACK_FROM"
  case "$ROLLBACK_FROM" in /*) ;; *) die "give the backup's absolute path on the host" ;; esac
  remote "test -f $(q "$ROLLBACK_FROM")" || die "no such file on the host: $ROLLBACK_FROM"
  TGZ_REMOTE="$ROLLBACK_FROM"
else
  say "Uploading the build"
  tar -czf "$TMP/account.tgz" -C "$REPO/website" account
  local_sum="$(sha256sum "$TMP/account.tgz" | cut -d' ' -f1)"
  TGZ_REMOTE="$UPLOAD_DIR/account-$STAMP.tgz"
  remote "umask 077 && cat > $(q "$TGZ_REMOTE")" <"$TMP/account.tgz"
  remote_sum="$(remote "sha256sum $(q "$TGZ_REMOTE")" | cut -d' ' -f1)"
  [ "$local_sum" = "$remote_sum" ] || die "upload corrupted (sha256 $local_sum here, $remote_sum there)"
  UPLOADED="$TGZ_REMOTE"
fi

# The build that is live now is always backed up first -- on a rollback
# too, so that a rollback can itself be undone.
say "Backing up the live account/ and swapping the new one in"
swap="$(remote "bash -s -- $(q "$WEB_ROOT" "$WEB_BACKUPS" "$STAMP" "$TGZ_REMOTE" yes)" <<<"$SWAP_IN")"
sv() { printf '%s\n' "$swap" | sed -n "s/^$1=//p" | head -1; }
[ -z "$(sv FAIL)" ] || die "$(sv FAIL)"
STAGE="$(sv STAGE)"
BACKUP="$(sv BACKUP)"
# Everything below removes or moves this directory: it must be exactly the
# one this run made.
[ "$STAGE" = "$WEB_ROOT/.account-deploy-$STAMP" ] || die "unexpected staging directory reported by the host: '$STAGE'"
echo "swap   $(sv SWAP)"
echo "backup ${BACKUP:-none (there was no live account/)}"
echo "kept   $(sv CARRIED) hashed file(s) of earlier builds for pages still open; pruned $(sv DROPPED)"

SSH_HINT="ssh -i $WEB_KEY -p $WEB_PORT $WEB_USER@$WEB_HOST"
rollback_help() {
  [ -n "$BACKUP" ] || return 0
  cat <<EOF

To roll back to the build that was live before this run:
  NEOXIFY_WEB_USER=$WEB_USER NEOXIFY_WEB_ROOT=$WEB_ROOT scripts/deploy-portal.sh --rollback $BACKUP
or by hand on the host ($SSH_HINT):
  cd $WEB_ROOT && mkdir .account-rollback && tar -xzf $BACKUP -C .account-rollback \\
    && { mv --exchange -T .account-rollback/account account 2>/dev/null \\
         || { mv -T account .account-rollback/account.bad && mv -T .account-rollback/account account; }; } \\
    && rm -rf .account-rollback
EOF
}

# The build now live keeps its file list, and the log says what went up.
settle() {
  local result="$1" what
  if [ -n "$ROLLBACK_FROM" ]; then what="rollback to $ROLLBACK_FROM"; else what="deploy of $COMMIT"; fi
  remote "mv -f $(q "$WEB_BACKUPS/assets-$STAMP.txt" "$WEB_BACKUPS/live-assets.txt") && printf '%s\n' $(q "$STAMP $what: $result; previous build in ${BACKUP:-(none)}") >> $(q "$WEB_BACKUPS/deploys.log")" \
    || echo "note: could not write $WEB_BACKUPS/deploys.log on the host"
}

# --- 8. Check what the world now gets ----------------------------------------------
if [ -n "$ROLLBACK_FROM" ]; then
  # What the restored page should ask for, read from the restored copy.
  remote "cat $(q "$WEB_ROOT/account/index.html")" >"$TMP/restored.html" || die "could not read the restored account/index.html"
  read_page "$TMP/restored.html"
fi

# What each kind of file must be served as. A host that answers a missing
# file with a page (`try_files ... /index.php`) says 200 text/html; a
# module script or a stylesheet under any other type is refused by the
# browser. A font only has to not be a page.
expected_type() {
  case "$1" in
    *.js) echo javascript ;;
    *.css) echo text/css ;;
    *.txt) echo text/plain ;;
    *) echo "not text/html" ;;
  esac
}
type_ok() {
  case "$2" in
    "not text/html") case "$1" in text/html*) return 1 ;; esac; return 0 ;;
    javascript) case "$1" in *javascript*) return 0 ;; esac; return 1 ;;
    *) case "$1" in "$2"*) return 0 ;; esac; return 1 ;;
  esac
}

# The sources of the first of the named directives a policy has; fails
# when it has none of them (a directive with no sources prints nothing).
csp_sources() {
  local policy="$1" name line
  shift
  for name in "$@"; do
    line="$(printf '%s\n' "$policy" | tr ';' '\n' | awk -v n="$name" '{ $1 = tolower($1) } $1 == n { $1 = ""; print "=" $0; exit }')"
    if [ -n "$line" ]; then
      printf '%s\n' "${line#=}"
      return 0
    fi
  done
  return 1
}
has_source() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }
# What a server policy would break, applied on top of the page's own: its
# loader, its first-paint styles, or its calls to the API's mirrors, which
# live on several domains and change without a release.
csp_problem() {
  local policy="$1" src
  if [ -n "$HASH" ] && src="$(csp_sources "$policy" script-src-elem script-src default-src)" && ! has_source "$src" "'$HASH'"; then
    echo "has no '$HASH' for scripts: the page's loader would be blocked"
  elif [ -n "$STYLE_HASH" ] && src="$(csp_sources "$policy" style-src-elem style-src default-src)" && ! has_source "$src" "'$STYLE_HASH'"; then
    echo "has no '$STYLE_HASH' for styles: the first paint would be unstyled"
  elif src="$(csp_sources "$policy" connect-src default-src)" && ! has_source "$src" "https:" && ! has_source "$src" "*"; then
    echo "limits connect-src to$src: sign-in could not reach the API's mirrors"
  fi
}

check_live() {
  local page code type out headers policy problem paths path
  page="$(curl -sS --compressed -H 'Cache-Control: no-cache' -w '\n%{http_code}' "$SITE_URL/account/?deploy=$STAMP")" || return 1
  code="${page##*$'\n'}"
  [ "$code" = 200 ] || { echo "  /account/ answered $code"; return 1; }
  if [ "$BOOT" = 1 ]; then
    case "$page" in *"data-js=\"$JS\""*) ;; *) echo "  /account/ does not serve this build yet (no $JS in it)"; return 1 ;; esac
  elif [ -n "$JS" ]; then
    case "$page" in *"src=\"$JS\""*) ;; *) echo "  /account/ does not serve the restored build (no $JS in it)"; return 1 ;; esac
  else
    case "$page" in *'id="root"'*) ;; *) echo "  /account/ does not look like the portal"; return 1 ;; esac
  fi
  # The licences shipped with this portal's typefaces and map; the portal
  # before it had none, and is not failed for that.
  paths="$JS $CSS $FONT"
  [ "$BOOT" = 0 ] || paths="$paths /account/licenses/Inter-OFL.txt"
  for path in $paths; do
    out="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$SITE_URL$path")" || return 1
    code="${out%% *}" type="${out#* }"
    [ "$code" = 200 ] || { echo "  $path answered $code"; return 1; }
    type_ok "$type" "$(expected_type "$path")" || { echo "  $path answered 200 as '$type', not $(expected_type "$path")"; return 1; }
  done
  # A Content-Security-Policy header from the server is enforced on top of
  # the page's own.
  headers="$(curl -sS -D - -o /dev/null "$SITE_URL/account/")" || return 1
  while IFS= read -r policy; do
    [ -n "$policy" ] || continue
    problem="$(csp_problem "$policy")"
    [ -z "$problem" ] || { echo "  the server sends a Content-Security-Policy that $problem"; return 1; }
  done < <(printf '%s\n' "$headers" | tr -d '\r' | grep -i '^content-security-policy:' | sed 's/^[^:]*:[[:space:]]*//')
  return 0
}

say "Checking $SITE_URL/account/"
ok=0
for attempt in 1 2 3 4 5 6; do
  if check_live; then ok=1; break; fi
  [ "$attempt" = 6 ] || sleep "$CHECK_WAIT"
done

if [ "$ok" = 1 ]; then
  echo "200, serving ${JS:-the restored build}; its files load."
  enc="$(curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip, br' "$SITE_URL${JS:-/account/}" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p' | head -1)"
  echo "compression of the script: ${enc:-none (the host does not compress it)}"
  settle "checked"
  # The build taken down (kept in the backup) and the uploaded archive.
  # shellcheck disable=SC2086 # UPLOADED is empty on a rollback.
  remote "rm -rf -- $(q "$STAGE" $UPLOADED)" || echo "note: could not remove $STAGE on the host"
  say "Done"
  rollback_help
  exit 0
fi

say "The live check failed"
if [ "$AUTO_ROLLBACK" = 1 ] && [ "$HAS_ACCOUNT" = yes ]; then
  echo "Putting the previous build back (it is in $STAGE/account)."
  if remote "cd $(q "$WEB_ROOT") && { mv --exchange -T $(q "$STAGE/account") account 2>/dev/null || { mv -T account $(q "$STAGE/account.failed") && mv -T $(q "$STAGE/account") account; }; }"; then
    remote "rm -f $(q "$WEB_BACKUPS/assets-$STAMP.txt") && printf '%s\n' $(q "$STAMP deploy of $COMMIT: check failed, previous build put back") >> $(q "$WEB_BACKUPS/deploys.log")" || true
    echo "Previous build restored. The failed one is in $STAGE on the host."
  else
    echo "Could not swap back automatically: roll back by hand, below."
  fi
elif [ -n "$ROLLBACK_FROM" ]; then
  settle "check FAILED, left live"
  echo "The restored build is still live: a rollback never puts back the build it replaced."
  echo "Fix what the check reports, or roll back to another backup."
else
  settle "check FAILED, left live"
  echo "The new build is still live (--no-auto-rollback, or there was nothing to go back to)."
fi
rollback_help
exit 1
