#!/usr/bin/env bash
#
# Runs scripts/deploy-portal.sh against a stand-in host, end to end.
#
# Stand-ins on PATH: `ssh` runs the remote commands here, as the site
# user would, with HOME pointed at a stand-in home; `curl` answers from
# the stand-in document root the way the live nginx does
# (try_files $uri $uri/ =404, index index.php index.html), optionally
# with a server Content-Security-Policy or a PHP fallback for missing
# files; `ssh-keyscan` offers a key generated here. The script itself
# runs from a copy inside a throwaway git checkout, so the build it finds
# and the commit it records are this test's.
#
# What it pins: a deploy goes live and keeps the old build's hashed
# files; a rollback to a backup of the portal from before the redesign
# (no <meta name="pa-boot">, no licences/) passes its own check and is
# never swapped back; a failed check after a deploy puts the previous
# build back; a server policy that would block the loader, the first
# paint's styles or the mirrors fails the check; a fallback that answers
# a missing file with a page fails it; backup and upload directories
# that are the document root, above it or inside it are refused without
# touching their permissions; a key that cannot log in says so; a dirty
# tree is refused; an unknown host key is added only when it matches the
# fingerprint the owner confirmed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  printf '%s\n' '----- output -----' && sed 's/^/  | /' "$T/out" && printf '%s\n' '------------------'
  failures=$((failures + 1))
}

SITE=https://site.test
# Laid out as shared hosting usually is: the site user's home, and the
# document root inside it.
RHOME="$T/host/home"
ROOT="$RHOME/public_html"
BIN="$T/bin"
R="$T/repo"
mkdir -p "$BIN" "$RHOME" "$ROOT/inc" "$T/local"

# --- Stand-ins -----------------------------------------------------------------
cat >"$BIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -i | -p | -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift # user@host
if [ -n "${FAKE_SSH_DENY:-}" ]; then
  echo "site@site.test: Permission denied (publickey)." >&2
  exit 255
fi
export HOME="$FAKE_HOME"
cd "$HOME"
exec bash -c "$*"
EOF

cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
out="" dump="" fmt="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) dump="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="${url#"$FAKE_SITE"}"
path="${path%%\?*}"
file="$FAKE_ROOT$path"
code=200
[ ! -d "$file" ] || file="${file%/}/index.html"
missing=0
[ -f "$file" ] || missing=1
case " ${FAKE_MISSING:-} " in *" $path "*) missing=1 ;; esac
if [ "$missing" = 1 ]; then
  if [ -n "${FAKE_FALLBACK:-}" ]; then file="$FAKE_ROOT/index.php"; else code=404 file=""; fi
fi
case "$file" in
  *.html | *.php | "") type="text/html; charset=utf-8" ;;
  *.js) type="application/javascript" ;;
  *.css) type="text/css" ;;
  *.woff2) type="font/woff2" ;;
  *.txt) type="text/plain; charset=utf-8" ;;
  *) type="application/octet-stream" ;;
esac
headers="HTTP/1.1 $code\r\nContent-Type: $type\r\n"
case "$type" in text/html*) [ -z "${FAKE_CSP:-}" ] || headers="${headers}Content-Security-Policy: $FAKE_CSP\r\n" ;; esac
headers="$headers\r\n"
if [ -n "$dump" ]; then
  if [ "$dump" = - ]; then printf '%b' "$headers"; else printf '%b' "$headers" >"$dump"; fi
fi
if [ "$out" != /dev/null ]; then
  if [ -n "$file" ]; then cat "$file"; else printf '404'; fi
fi
if [ -n "$fmt" ]; then
  fmt="${fmt//%\{http_code\}/$code}"
  fmt="${fmt//%\{content_type\}/$type}"
  printf '%b' "$fmt"
fi
EOF

ssh-keygen -q -t ed25519 -N "" -C "" -f "$T/hostkey" >/dev/null
HOSTLINE="site.test $(cut -d' ' -f1,2 "$T/hostkey.pub")"
HOSTPRINT="$(ssh-keygen -lf "$T/hostkey.pub" | awk '{print $2}')"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%s"\n' "$HOSTLINE" >"$BIN/ssh-keyscan"
chmod +x "$BIN/ssh" "$BIN/curl" "$BIN/ssh-keyscan"
: >"$T/local/key"

# --- The host: the PHP site, with the portal as it was before the redesign -----
printf '<?php\n' >"$ROOT/index.php"
printf '<?php\n' >"$ROOT/inc/bootstrap.php"
mkdir -p "$ROOT/account/assets"
cat >"$ROOT/account/index.html" <<'EOF'
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <title>Your account</title>
    <script type="module" crossorigin src="/account/assets/index-OLD.js"></script>
    <link rel="stylesheet" crossorigin href="/account/assets/index-OLD.css">
  </head>
  <body><div id="root"></div></body>
</html>
EOF
echo 'console.log("old")' >"$ROOT/account/assets/index-OLD.js"
echo 'body{}' >"$ROOT/account/assets/index-OLD.css"

# --- The checkout, with a build of the redesigned portal --------------------------
mkdir -p "$R/scripts" "$R/apps/desktop-windows/src/lib" "$R/website/account/assets" "$R/website/account/licenses"
cp "$HERE/deploy-portal.sh" "$R/scripts/"
printf 'website/account/\napps/desktop-windows/src/lib/seed-bundle.json\n' >"$R/.gitignore"
printf '{"payload":"eyJ2IjoxfQ==","sig":"SIG-OF-THE-TEST-BUNDLE","key":"test"}\n' >"$R/apps/desktop-windows/src/lib/seed-bundle.json"
B="$R/website/account"
cat >"$B/index.html" <<'EOF'
<!doctype html>
<html lang="en" class="dark" data-surface="auth">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'sha256-LOADERHASH='; style-src 'self' 'sha256-STYLEHASH='; connect-src 'self' https:" />
    <meta name="pa-boot" data-js="/account/assets/index-NEW.js" data-css="/account/assets/index-NEW.css" data-font="/account/assets/Inter-NEW.woff2" />
  </head>
  <body><div class="pa-scene"></div><div id="root"></div></body>
</html>
EOF
echo 'const seed={sig:"SIG-OF-THE-TEST-BUNDLE"}' >"$B/assets/index-NEW.js"
echo 'body{}' >"$B/assets/index-NEW.css"
echo 'wOF2' >"$B/assets/Inter-NEW.woff2"
for lic in Inter-OFL.txt InterTight-OFL.txt Vazirmatn-OFL.txt world-atlas-LICENSE.txt; do echo licence >"$B/licenses/$lic"; done
git -C "$R" init -q
git -C "$R" add -A
git -C "$R" -c user.name=test -c user.email=test@example.invalid commit -q -m test

# --- Running it -------------------------------------------------------------------
KNOWN="$T/local/known_hosts"
printf '%s\n' "$HOSTLINE" >"$KNOWN"
deploy() {
  local want="$1" got
  shift
  set +e
  (
    cd "$R" &&
      env PATH="$BIN:$PATH" FAKE_HOME="$RHOME" FAKE_ROOT="$ROOT" FAKE_SITE="$SITE" \
        NEOXIFY_WEB_USER=site NEOXIFY_WEB_HOST=site.test NEOXIFY_WEB_KEY="$T/local/key" \
        NEOXIFY_WEB_KNOWN_HOSTS="${KNOWN_HOSTS_FILE:-$KNOWN}" NEOXIFY_WEB_ROOT="$ROOT" \
        NEOXIFY_SITE_URL="$SITE" NEOXIFY_DEPLOY_CHECK_WAIT=0 \
        bash scripts/deploy-portal.sh --skip-build "$@"
  ) >"$T/out" 2>&1
  got=$?
  set -e
  [ "$got" = "$want" ]
}
live_has() { grep -qF -- "$1" "$ROOT/account/index.html"; }
said() { grep -qF -- "$1" "$T/out"; }

# 1. A deploy goes live, keeps the old build's hashed files, and is logged.
if deploy 0 && live_has index-NEW.js && [ -f "$ROOT/account/assets/index-OLD.js" ] && [ -f "$ROOT/account/licenses/Inter-OFL.txt" ]; then
  pass "a deploy goes live and keeps the previous build's hashed files"
else
  fail "a deploy goes live and keeps the previous build's hashed files"
fi
BACKUP_OLD="$(ls "$RHOME"/web-backups/account-*.tgz | head -1)"
if grep -q "deploy of $(git -C "$R" rev-parse HEAD)" "$RHOME/web-backups/deploys.log" && grep -qx index-NEW.js "$RHOME/web-backups/live-assets.txt"; then
  pass "the deploy is logged with its commit, and the live build's own files are listed"
else
  fail "the deploy is logged with its commit, and the live build's own files are listed"
fi
if [ -z "$(ls -A "$ROOT" | grep '^\.account-deploy-' || true)" ] && [ -z "$(ls -A "$RHOME/.neoxify-deploy")" ]; then
  pass "nothing is left behind in the document root or the upload directory"
else
  fail "nothing is left behind in the document root or the upload directory"
fi

# 2. Rolling back to the pre-redesign portal: no pa-boot, no licences.
sleep 1 # a new UTC stamp for the next run's backup
if deploy 0 --rollback "$BACKUP_OLD" && live_has index-OLD.js && ! live_has pa-boot; then
  pass "a rollback to the portal from before the redesign passes its own check"
else
  fail "a rollback to the portal from before the redesign passes its own check"
fi

# 3. A rollback whose check fails leaves what it restored live.
sleep 1
BACKUP_NEW="$(ls -t "$RHOME"/web-backups/account-*.tgz | head -1)"
if FAKE_CSP="default-src 'self'; connect-src 'self' https://*.neoxify.site:*" deploy 1 --rollback "$BACKUP_NEW" &&
  live_has index-NEW.js && said "a rollback never puts back the build it replaced"; then
  pass "a rollback that fails its check is not swapped back"
else
  fail "a rollback that fails its check is not swapped back"
fi
# Back to the pre-redesign build for the next cases.
sleep 1
deploy 0 --rollback "$BACKUP_OLD" || fail "setup: roll back to the old build"

# 4. Server policies the page cannot live with.
check_policy() {
  local name="$1" policy="$2" reason="$3"
  sleep 1
  if FAKE_CSP="$policy" deploy 1 && live_has index-OLD.js && said "$reason" && said "Previous build restored"; then
    pass "$name"
  else
    fail "$name"
  fi
}
check_policy "a server policy without the loader's hash fails, and the previous build is put back" \
  "default-src 'self'; script-src 'self'; connect-src 'self' https:" "the page's loader would be blocked"
check_policy "a server policy without the first paint's hash fails" \
  "default-src 'self'; script-src 'self' 'sha256-LOADERHASH='; style-src 'self'; connect-src 'self' https:" "the first paint would be unstyled"
check_policy "a server policy that limits connect-src to some mirrors fails" \
  "default-src 'self'; script-src 'self' 'sha256-LOADERHASH='; style-src 'self' 'sha256-STYLEHASH='; connect-src 'self' https://*.neoxify.site:*" "sign-in could not reach the API's mirrors"
check_policy "a server policy whose default-src would limit connections fails" \
  "default-src 'self' 'sha256-LOADERHASH=' 'sha256-STYLEHASH='" "sign-in could not reach the API's mirrors"
sleep 1
if FAKE_CSP="frame-ancestors 'none'" deploy 0 && live_has index-NEW.js; then
  pass "a server policy that only forbids framing passes"
else
  fail "a server policy that only forbids framing passes"
fi
sleep 1
deploy 0 --rollback "$BACKUP_OLD" || fail "setup: roll back to the old build"

# 5. A host that answers a missing file with a page.
sleep 1
if FAKE_FALLBACK=1 FAKE_MISSING=/account/licenses/Inter-OFL.txt deploy 1 && live_has index-OLD.js &&
  said "answered 200 as 'text/html; charset=utf-8', not text/plain"; then
  pass "a missing file answered with a page fails the check"
else
  fail "a missing file answered with a page fails the check"
fi

# 6. Backup and upload directories.
mkdir -p "$T/host"
chmod 755 "$T/host"
before="$(stat -c %a "$T/host" 2>/dev/null || true)"
if NEOXIFY_WEB_BACKUPS="$T/host" deploy 1 && said "is the document root or a directory above it" && live_has index-OLD.js; then
  pass "a backup directory above the document root is refused"
else
  fail "a backup directory above the document root is refused"
fi
if [ "$(stat -c %a "$T/host" 2>/dev/null || true)" = "$before" ]; then
  pass "and its permissions are left alone"
else
  fail "and its permissions are left alone"
fi
if NEOXIFY_WEB_BACKUPS=. deploy 1 && said "is the document root or a directory above it"; then
  pass "a backup directory of '.' (the home above the site) is refused"
else
  fail "a backup directory of '.' (the home above the site) is refused"
fi
if NEOXIFY_WEB_BACKUPS="$ROOT/backups" deploy 1 && said "is inside the document root"; then
  pass "a backup directory inside the document root is refused"
else
  fail "a backup directory inside the document root is refused"
fi
if NEOXIFY_WEB_BACKUPS="$ROOT" deploy 1 && said "is the document root or a directory above it"; then
  pass "the document root itself is refused as a backup directory"
else
  fail "the document root itself is refused as a backup directory"
fi

# 7. Logging in.
if FAKE_SSH_DENY=1 deploy 1 && said "cannot log in as site@site.test"; then
  pass "a key that cannot log in says so, not that no document root was found"
else
  fail "a key that cannot log in says so, not that no document root was found"
fi

# 8. A dirty tree.
echo change >>"$R/scripts/deploy-portal.sh"
if deploy 1 && said "uncommitted changes"; then
  pass "a working tree with uncommitted changes is refused"
else
  fail "a working tree with uncommitted changes is refused"
fi
git -C "$R" checkout -q -- scripts/deploy-portal.sh

# 9. The host key.
: >"$T/local/empty_known_hosts"
if KNOWN_HOSTS_FILE="$T/local/empty_known_hosts" deploy 1 && said "$HOSTPRINT" && said "NEOXIFY_WEB_HOST_KEY"; then
  pass "an unknown host key is not trusted, and its fingerprint is shown for the owner to confirm"
else
  fail "an unknown host key is not trusted, and its fingerprint is shown for the owner to confirm"
fi
if KNOWN_HOSTS_FILE="$T/local/empty_known_hosts" NEOXIFY_WEB_HOST_KEY="SHA256:not-this-one" deploy 1 && said "Not connecting" &&
  [ ! -s "$T/local/empty_known_hosts" ]; then
  pass "a host key that does not match the confirmed fingerprint is refused"
else
  fail "a host key that does not match the confirmed fingerprint is refused"
fi
sleep 1
if KNOWN_HOSTS_FILE="$T/local/empty_known_hosts" NEOXIFY_WEB_HOST_KEY="$HOSTPRINT" deploy 0 &&
  grep -qF "$(cut -d' ' -f2 "$T/hostkey.pub")" "$T/local/empty_known_hosts"; then
  pass "the confirmed host key is added, and the deploy goes ahead"
else
  fail "the confirmed host key is added, and the deploy goes ahead"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all deploy-portal checks passed"
