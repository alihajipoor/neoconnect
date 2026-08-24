#!/usr/bin/env bash
# Takes port 80 back from Ubuntu's default nginx vhost on a node that is
# already live.
#
# The installer now does this on every fresh install (ensure_port80_site
# in ../lib/agent.sh). Nodes built before that change are still answering
# "Welcome to nginx!" -- byte-identical across the fleet, with the nginx
# version and the distro in the Server header -- to anyone who scans
# them. A fix that only helps future installs is not a fix here: the
# nodes carrying customers today are the ones being fingerprinted.
#
# Safe to run more than once. Reports first and changes nothing unless
# --apply is given, and the report is worth reading before the change:
# what it does about certificate renewal depends on what it finds.
#
#   sudo ./fix-node-port-80.sh            # look, change nothing
#   sudo ./fix-node-port-80.sh --apply    # do it
#
# It does NOT restart Xray, strongSwan, WireGuard, OpenVPN or the agent,
# and it does not touch any protocol configuration. The only running
# service it disturbs is nginx, and only with a reload -- which does not
# drop the loopback fallback connections Xray is holding.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent.sh
. "$SCRIPT_DIR/../lib/agent.sh"

APPLY="no"
[[ "${1:-}" == "--apply" ]] && APPLY="yes"

say() { printf '  %s\n' "$*"; }

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this as root: it edits /etc/nginx and /etc/letsencrypt." >&2
  exit 1
fi

if [[ ! -f /etc/neoxify/agent.json ]]; then
  echo "No /etc/neoxify/agent.json here, so this is not a Neoxify node." >&2
  echo "Refusing to rearrange somebody else's nginx." >&2
  exit 1
fi

echo
echo "== What this node serves on port 80 right now =="
if ! command -v nginx >/dev/null 2>&1; then
  say "nginx is not installed. Nothing is fingerprinting this node on 80,"
  say "and there is nothing to fix."
  exit 0
fi
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  say "Ubuntu's default vhost IS enabled -- this node serves 'Welcome to nginx!'"
else
  say "Ubuntu's default vhost is not enabled."
fi
if [[ -e /etc/nginx/sites-enabled/neoxify-http ]]; then
  say "The deliberate port 80 site is already in place."
fi
say "Listening on 80: $(ss -tln 2>/dev/null | grep -cE '[^0-9]:80[[:space:]]') socket(s)"
say "Answered locally: $(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/ 2>/dev/null || echo 'no answer')"
if curl -s -m 5 http://127.0.0.1/ 2>/dev/null | grep -q "Welcome to nginx"; then
  say "The default page is what comes back."
fi

echo
echo "== Certificate renewal, which is why port 80 stays open =="
# This is the part to get right. Let's Encrypt's HTTP-01 challenge needs
# inbound TCP 80 at every renewal, and certbot replays whichever
# authenticator is recorded per certificate. Closing port 80 -- or
# removing the vhost that serves /var/www/html without putting one
# back -- breaks renewal silently, and the node loses every TLS inbound
# about ninety days later when Xray refuses a config it cannot read.
standalone_certs=()
webroot_certs=()
if [[ -d /etc/letsencrypt/renewal ]]; then
  for conf in /etc/letsencrypt/renewal/*.conf; do
    [[ -e "$conf" ]] || continue
    name="$(basename "$conf" .conf)"
    if grep -qE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*standalone' "$conf"; then
      standalone_certs+=("$name")
    elif grep -qE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*webroot' "$conf"; then
      webroot_certs+=("$name")
    fi
  done
fi
if [[ ${#webroot_certs[@]} -gt 0 ]]; then
  say "webroot: ${webroot_certs[*]}"
  say "  These renew through whatever serves /var/www/html on port 80."
  say "  The replacement vhost keeps serving it, so they are unaffected."
fi
if [[ ${#standalone_certs[@]} -gt 0 ]]; then
  say "standalone: ${standalone_certs[*]}"
  say "  These renew by binding port 80 themselves, which cannot work while"
  say "  nginx holds it. If nginx is already listening on 80, that renewal is"
  say "  ALREADY broken and this script fixes it as well as the fingerprint."
fi
if [[ ${#webroot_certs[@]} -eq 0 && ${#standalone_certs[@]} -eq 0 ]]; then
  say "No Let's Encrypt certificates on this node."
fi

if [[ "$APPLY" != "yes" ]]; then
  echo
  echo "Nothing was changed. Re-run with --apply to:"
  echo "  * disable Ubuntu's default vhost"
  echo "  * install /etc/nginx/sites-available/neoxify-http, which serves a"
  echo "    dull per-node page, hides the nginx version, and keeps"
  echo "    /.well-known/acme-challenge/ working out of /var/www/html"
  echo "  * move any standalone certificate renewal to the webroot challenge"
  echo "  * nginx -t, then reload (never restart)"
  echo
  echo "Afterwards, prove it rather than assuming it:"
  echo "  curl -sI http://<node>/            # no Server version, not the default page"
  echo "  certbot renew --dry-run            # renewal still works"
  exit 0
fi

echo
echo "== Applying =="
backup="/root/neoxify-port80-backup-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup"
cp -a /etc/nginx/sites-enabled "$backup/sites-enabled" 2>/dev/null || true
cp -a /etc/nginx/sites-available "$backup/sites-available" 2>/dev/null || true
[[ -d /etc/letsencrypt/renewal ]] && cp -a /etc/letsencrypt/renewal "$backup/renewal"
say "Backed up nginx and certbot renewal config to $backup"

# ensure_port80_site is the installer's own function, sourced above
# rather than copied. A remediation script that reimplements the fix is
# a second thing to keep in step with the first, and this repo has been
# bitten by exactly that: a hotfix applied to a live box is not done
# until a fresh install produces the same result. One function, both
# paths.
if ensure_port80_site; then
  say "Port 80 now serves the deliberate site."
else
  echo "  ensure_port80_site failed. nginx was left as it was; the backup at" >&2
  echo "  $backup has the previous configuration." >&2
  exit 1
fi

echo
echo "== Proof, from this node =="
say "curl -sI http://127.0.0.1/"
curl -sI -m 5 http://127.0.0.1/ 2>/dev/null | sed 's/^/    /'
printf 'neoxify-acme-check' > /var/www/html/.well-known/acme-challenge/neoxify-check
say "ACME path: $(curl -s -m 5 http://127.0.0.1/.well-known/acme-challenge/neoxify-check 2>/dev/null || echo FAILED)"
rm -f /var/www/html/.well-known/acme-challenge/neoxify-check

echo
echo "Still to do by hand, because neither should be guessed at:"
echo "  certbot renew --dry-run     # proves renewal, and takes about a minute"
echo "  curl -sI http://<public-ip>/   # from off the node, through any cloud firewall"
