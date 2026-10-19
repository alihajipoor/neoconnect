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
# `bash website/make-zip.sh` zips the whole website/ tree, account/
# included, and the zip is unzipped over the document root by hand
# (website/README.md, "Deploying"). Nothing built the portal before zipping,
# so a stale account/ shipped unless someone remembered; nothing kept the
# previous version; and an unzip over a live site is never atomic.
#
# What this does instead, for account/ only
# -----------------------------------------
#   1. Builds the portal, requiring a real endpoint bundle: a portal built
#      without one cannot reach the API's mirrors from a censored network.
#   2. Checks the build locally: the page, its script, stylesheet, typeface,
#      licences and Content-Security-Policy are all there.
#   3. Connects as the neoxify.net site's own user. The host is SHARED with
#      other sites and a hosting panel (owner, 2026-10-19), so: never root,
#      nothing outside the site's own folder, no service reloads, no
#      server-wide changes.
#   4. Finds the site's document root in the nginx configuration (read
#      only), unless NEOXIFY_WEB_ROOT says it, and refuses any directory
#      that is not this PHP site (no index.php and inc/bootstrap.php).
#   5. Backs up the live account/ to $NEOXIFY_WEB_BACKUPS/account-<UTC>.tgz,
#      outside the document root.
#   6. Uploads the build to a staging directory beside it, then swaps it in:
#      atomically where the host's mv has --exchange, otherwise by two
#      renames a few microseconds apart.
#   7. Checks https://neoxify.net/account/ answers 200 with the new build's
#      own file names, that those files are served, and that no server
#      Content-Security-Policy would block the page's loader. If a check
#      fails, it swaps the previous build back (unless --no-auto-rollback).
#   8. Prints how to roll back.
#
# Usage
#   NEOXIFY_WEB_USER=<site user> scripts/deploy-portal.sh [--dry-run]
#   NEOXIFY_WEB_USER=<site user> scripts/deploy-portal.sh --rollback <backup .tgz on the host>
#
# Options
#   --dry-run            build and check locally, print the plan, never connect.
#   --skip-build         deploy website/account/ as it is (it must be built).
#   --rollback <path>    put a backup made by an earlier run back live.
#   --no-auto-rollback   on a failed check, leave the new build live.
#
# Environment
#   NEOXIFY_WEB_USER     required (not for --dry-run). The neoxify.net site's
#                        SSH/SFTP user. root is refused.
#   NEOXIFY_WEB_HOST     default neoxify.net (the address may be given instead).
#   NEOXIFY_WEB_PORT     default 22.
#   NEOXIFY_WEB_KEY      default ~/.ssh/neoxify_web. Key only: never a password.
#   NEOXIFY_WEB_ROOT     the document root on the host; discovered when unset.
#   NEOXIFY_WEB_BACKUPS  default web-backups in the user's home on the host.
#   NEOXIFY_SITE_URL     default https://neoxify.net.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO/website/account"

WEB_USER="${NEOXIFY_WEB_USER:-}"
WEB_HOST="${NEOXIFY_WEB_HOST:-neoxify.net}"
WEB_PORT="${NEOXIFY_WEB_PORT:-22}"
WEB_KEY="${NEOXIFY_WEB_KEY:-$HOME/.ssh/neoxify_web}"
WEB_ROOT="${NEOXIFY_WEB_ROOT:-}"
WEB_BACKUPS="${NEOXIFY_WEB_BACKUPS:-}"
SITE_URL="${NEOXIFY_SITE_URL:-https://neoxify.net}"
SITE_URL="${SITE_URL%/}"

DRY_RUN=0
SKIP_BUILD=0
AUTO_ROLLBACK=1
ROLLBACK_FROM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
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

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
say() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

# --- 1. Build ------------------------------------------------------------
if [ -z "$ROLLBACK_FROM" ] && [ "$SKIP_BUILD" = 0 ]; then
  say "Building the portal (a real endpoint bundle is required)"
  (cd "$REPO" && NEOXIFY_REQUIRE_SEED=1 pnpm --filter @neoxify/web-portal build)
fi

# --- 2. Check the build locally ---------------------------------------------
# The file names the page will ask for, from <meta name="pa-boot"> that
# apps/web-portal/portal-html.ts writes.
boot_attr() { grep -o "<meta name=\"pa-boot\"[^>]*>" "$1" | grep -o " data-$2=\"[^\"]*\"" | cut -d'"' -f2; }
loader_hash() { grep -o "script-src 'self' 'sha256-[^']*'" "$1" | grep -o "sha256-[^']*"; }

if [ -z "$ROLLBACK_FROM" ]; then
  say "Checking the build in website/account/"
  [ -f "$BUILD_DIR/index.html" ] || die "no website/account/index.html: build the portal first (or drop --skip-build)"
  JS="$(boot_attr "$BUILD_DIR/index.html" js)"
  CSS="$(boot_attr "$BUILD_DIR/index.html" css)"
  FONT="$(boot_attr "$BUILD_DIR/index.html" font)"
  HASH="$(loader_hash "$BUILD_DIR/index.html")"
  [ -n "$JS" ] && [ -n "$CSS" ] && [ -n "$FONT" ] || die "index.html has no <meta name=\"pa-boot\">: not a build of this portal"
  [ -n "$HASH" ] || die "index.html carries no Content-Security-Policy with the loader's hash"
  for path in "$JS" "$CSS" "$FONT"; do
    case "$path" in /account/*) ;; *) die "unexpected asset path $path (the portal is served from /account/)" ;; esac
    [ -f "$BUILD_DIR/${path#/account/}" ] || die "the page asks for $path, which the build does not contain"
  done
  for lic in Inter-OFL.txt InterTight-OFL.txt Vazirmatn-OFL.txt world-atlas-LICENSE.txt; do
    [ -f "$BUILD_DIR/licenses/$lic" ] || die "licence missing from the build: licenses/$lic"
  done
  # A real seed only: the placeholder bundle carries no endpoints, and a
  # portal built on it cannot find the API's mirrors from a censored
  # network. The build reads it from here (ensure-seed-bundle.mjs).
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.payload && s.key !== "placeholder" ? 0 : 1)' \
    "$REPO/apps/desktop-windows/src/lib/seed-bundle.json" \
    || die "the portal was built on the placeholder endpoint bundle, not the signed one"
  echo "page   $SITE_URL/account/"
  echo "script $JS"
  echo "styles $CSS"
  echo "font   $FONT"
  echo "csp    script-src 'self' '$HASH'"
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

# --- 3. Connect --------------------------------------------------------------
[ -n "$WEB_USER" ] || die "set NEOXIFY_WEB_USER to the neoxify.net site's own SSH user"
[ "$WEB_USER" != root ] || die "refusing to deploy as root: the host is shared, use the neoxify.net site's own user"
[ -f "$WEB_KEY" ] || die "no SSH key at $WEB_KEY"

SSH=(ssh -i "$WEB_KEY" -p "$WEB_PORT"
  -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new
  "$WEB_USER@$WEB_HOST")
remote() { "${SSH[@]}" "$@"; }
# Each argument quoted for the remote shell.
q() { printf '%q ' "$@"; }

# --- 4. Find and check the document root (read only) ---------------------------
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
  roots="$(remote "bash -s" <<<"$FIND_ROOT" || true)"
  count="$(printf '%s\n' "$roots" | grep -c . || true)"
  if [ "$count" != 1 ]; then
    printf 'Found %s candidate document root(s) for neoxify.net in the nginx configuration this user can read:\n%s\n' "$count" "${roots:-  (none)}" >&2
    die "set NEOXIFY_WEB_ROOT to the site's document root and run again"
  fi
  WEB_ROOT="$roots"
  case "$WEB_ROOT" in *'$'*) die "the nginx root is not a plain path ($WEB_ROOT): set NEOXIFY_WEB_ROOT" ;; esac
  echo "nginx says: root $WEB_ROOT"
fi

# Resolves and checks the root and the backup directory; prints KEY=value.
PREFLIGHT=$(cat <<'REMOTE'
set -eu
root="$1"; backups="$2"
case "$root" in /*) ;; *) echo "FAIL=the document root must be an absolute path" ; exit 0 ;; esac
[ -d "$root" ] || { echo "FAIL=no directory $root"; exit 0; }
root="$(cd "$root" && pwd -P)"
case "$root" in /|/root|/home|"$HOME") echo "FAIL=refusing $root as a document root"; exit 0 ;; esac
[ -f "$root/index.php" ] && [ -f "$root/inc/bootstrap.php" ] || { echo "FAIL=$root is not the neoxify.net PHP site (no index.php and inc/bootstrap.php)"; exit 0; }
[ -w "$root" ] || { echo "FAIL=this user cannot write to $root"; exit 0; }
[ -L "$root/account" ] && { echo "FAIL=$root/account is a symlink; not touching an unexpected layout"; exit 0; }
[ -n "$backups" ] || backups="$HOME/web-backups"
case "$backups" in /*) ;; *) backups="$HOME/$backups" ;; esac
inside="FAIL=the backup directory $backups is inside the document root, where it would be served"
case "$backups/" in "$root"/*) echo "$inside"; exit 0 ;; esac
mkdir -p "$backups" && chmod 700 "$backups"
backups="$(cd "$backups" && pwd -P)"
case "$backups/" in "$root"/*) echo "$inside"; exit 0 ;; esac
echo "ROOT=$root"
echo "BACKUPS=$backups"
echo "HAS_ACCOUNT=$([ -d "$root/account" ] && echo yes || echo no)"
echo "EXCHANGE=$(mv --help 2>/dev/null | grep -q -- '--exchange' && echo yes || echo no)"
echo "FREE_KB=$(df -Pk "$root" | awk 'NR==2 {print $4}')"
echo "HOME=$HOME"
REMOTE
)

pre="$(remote "bash -s -- $(q "$WEB_ROOT" "$WEB_BACKUPS")" <<<"$PREFLIGHT")"
kv() { printf '%s\n' "$pre" | sed -n "s/^$1=//p" | head -1; }
[ -z "$(kv FAIL)" ] || die "$(kv FAIL)"
WEB_ROOT="$(kv ROOT)"
WEB_BACKUPS="$(kv BACKUPS)"
HAS_ACCOUNT="$(kv HAS_ACCOUNT)"
echo "root    $WEB_ROOT (account/ live: $HAS_ACCOUNT)"
echo "backups $WEB_BACKUPS"
echo "swap    $([ "$(kv EXCHANGE)" = yes ] && echo 'atomic (mv --exchange)' || echo 'two renames')"
echo "free    $(kv FREE_KB) KB"
REMOTE_HOME="$(kv HOME)"
[ -n "$REMOTE_HOME" ] || die "could not read the user's home directory on the host"

# Puts the account/ inside a .tgz on the host live: unpacks it next to the
# live one, swaps the two, and keeps the one taken down in the staging
# directory until the caller removes it. Prints STAGE=, BACKUP=, SWAP=.
SWAP_IN=$(cat <<'REMOTE'
set -eu
root="$1"; backups="$2"; stamp="$3"; tgz="$4"; backup_first="$5"
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

# --- 5 and 6. Back up, upload, swap ----------------------------------------------
# Uploads go to the user's home, never the document root, where a
# half-written archive would be served.
UPLOAD_DIR="$REMOTE_HOME/.neoxify-deploy"
UPLOADED=""
if [ -n "$ROLLBACK_FROM" ]; then
  say "Rolling back to $ROLLBACK_FROM"
  case "$ROLLBACK_FROM" in /*) ;; *) die "give the backup's absolute path on the host" ;; esac
  remote "test -f $(q "$ROLLBACK_FROM")" || die "no such file on the host: $ROLLBACK_FROM"
  TGZ_REMOTE="$ROLLBACK_FROM"
else
  say "Uploading the build"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  tar -czf "$TMP/account.tgz" -C "$REPO/website" account
  local_sum="$(sha256sum "$TMP/account.tgz" | cut -d' ' -f1)"
  TGZ_REMOTE="$UPLOAD_DIR/account-$STAMP.tgz"
  remote "umask 077 && mkdir -p $(q "$UPLOAD_DIR") && cat > $(q "$TGZ_REMOTE")" <"$TMP/account.tgz"
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
echo "swap   $(sv SWAP)"
echo "backup ${BACKUP:-none (there was no live account/)}"

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

# --- 7. Check what the world now gets ----------------------------------------------
if [ -n "$ROLLBACK_FROM" ]; then
  # What the restored page should ask for, read from the restored copy.
  JS="$(remote "grep -o '<meta name=\"pa-boot\"[^>]*>' $(q "$WEB_ROOT/account/index.html") | grep -o ' data-js=\"[^\"]*\"' | cut -d'\"' -f2" || true)"
  CSS="" FONT="" HASH=""
fi

check_live() {
  local page code headers
  page="$(curl -sS --compressed -H 'Cache-Control: no-cache' -w '\n%{http_code}' "$SITE_URL/account/?deploy=$STAMP")" || return 1
  code="${page##*$'\n'}"
  [ "$code" = 200 ] || { echo "  /account/ answered $code"; return 1; }
  if [ -n "$JS" ]; then
    case "$page" in *"data-js=\"$JS\""*) ;; *) echo "  /account/ does not serve this build yet (no $JS in it)"; return 1 ;; esac
  else
    case "$page" in *'id="root"'*) ;; *) echo "  /account/ does not look like the portal"; return 1 ;; esac
  fi
  for path in $JS $CSS $FONT /account/licenses/Inter-OFL.txt; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$SITE_URL$path")" || return 1
    [ "$code" = 200 ] || { echo "  $path answered $code"; return 1; }
  done
  # A Content-Security-Policy header from the server applies on top of the
  # page's own; without the loader's hash it would leave the page blank.
  headers="$(curl -sS -D - -o /dev/null "$SITE_URL/account/")" || return 1
  if [ -n "$HASH" ] && printf '%s' "$headers" | grep -qi '^content-security-policy:'; then
    if ! printf '%s' "$headers" | grep -i '^content-security-policy:' | grep -q -- "$HASH"; then
      echo "  the server sends a Content-Security-Policy without '$HASH': the page's loader would be blocked"
      return 1
    fi
  fi
  return 0
}

say "Checking $SITE_URL/account/"
ok=0
for attempt in 1 2 3 4 5 6; do
  if check_live; then ok=1; break; fi
  sleep 5
done

if [ "$ok" = 1 ]; then
  echo "200, serving ${JS:-the restored build}; its files load."
  enc="$(curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip, br' "$SITE_URL${JS:-/account/}" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p' | head -1)"
  echo "compression of the script: ${enc:-none (the host does not compress it)}"
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
  remote "cd $(q "$WEB_ROOT") && { mv --exchange -T $(q "$STAGE/account") account 2>/dev/null || { mv -T account $(q "$STAGE/account.failed") && mv -T $(q "$STAGE/account") account; }; }" \
    && echo "Previous build restored. The failed one is in $STAGE on the host." \
    || echo "Could not swap back automatically: roll back by hand, below."
else
  echo "The new build is still live (--no-auto-rollback, or there was nothing to go back to)."
fi
rollback_help
exit 1
