#!/usr/bin/env bash
# Installs and manages a VPN agent node: downloads the compiled agentd
# binary (no source tree needed, unlike the panel role), sets up protocol
# engines as systemd units, and enrolls with the control-plane panel.
set -euo pipefail

AGENT_REPO="${AGENT_REPO:-alihajipoor/neoconnect}"

# Where the admin access token is cached for the life of this install.
#
# A fixed path derived from the script's own PID, computed here at file
# scope, because every consumer runs inside a command substitution and
# so cannot see anything a subshell assigns -- including the path
# itself, had this been an mktemp inside the function. `$$` is the
# original shell's PID and stays the same in subshells, which is
# precisely the property needed.
ADMIN_TOKEN_CACHE="${TMPDIR:-/tmp}/neoxify-admin-token.$$"
trap 'rm -f "$ADMIN_TOKEN_CACHE"' EXIT

# Picks the agent's newest release out of a GitHub /releases response
# fed on stdin, and prints its tag. See resolve_agent_release_base below
# for why the tag prefix is the thing that has to be matched.
#
# Split out from the curl on purpose: the failure this guards against
# cannot be reproduced against the live API on demand, so the only way
# to know the ordering is right is to feed it a releases list that
# contains the bad shapes.
select_newest_agent_tag() {
  jq -r '
    [ .[]
      | select(.draft == false and .prerelease == false)
      | .tag_name // empty
      | select(test("^v[0-9]+[.][0-9]+[.][0-9]+$"))
    ]
    | sort_by(ltrimstr("v") | split(".") | map(tonumber))
    | last // empty
  '
}

# The newest *agent* release, resolved by tag rather than by asking
# GitHub for "latest".
#
# /releases/latest/download used to be here and it broke the moment the
# desktop client started publishing releases: "latest" is the newest
# release of *any* tag, so it began resolving to desktop-v0.8.5 and
# every node install 404'd looking for agentd-linux-amd64 in a release
# containing a Windows installer.
#
# The two artefacts ship on independent schedules under deliberately
# separate tag prefixes -- v* for the agent, desktop-v* for the client
# (see .github/workflows/release-agent.yml and
# release-desktop-windows.yml) -- so the prefix is what has to be
# matched. Anything else is a race between two release cadences.
#
# Override for a self-hosted or pinned build, e.g.:
#   AGENT_RELEASE_URL_BASE=https://example.com/releases/v0.1.0 sudo -E ./install.sh
resolve_agent_release_base() {
  if [[ -n "${AGENT_RELEASE_URL_BASE:-}" ]]; then
    echo "$AGENT_RELEASE_URL_BASE"
    return 0
  fi

  local releases tag
  # per_page is at the API maximum rather than 50 because this list is
  # shared with desktop-v* and android-v*, which both ship far more
  # often than the agent does. A window too small does not fail loudly;
  # it just stops containing any agent release.
  releases="$(curl -fsSL "https://api.github.com/repos/$AGENT_REPO/releases?per_page=100" 2>/dev/null || true)"

  # `| first` used to be here, which is GitHub's own ordering --
  # created_at descending. That is not the newest *version*: a release
  # that is re-published, back-dated, or promoted from a draft sorts to
  # the front while being an older build, and every downstream step
  # (checksum, install, restart) would have succeeded on the wrong
  # binary without a word. Ordering by the version the tag actually
  # states is the only thing that cannot drift.
  tag="$(printf '%s' "$releases" | select_newest_agent_tag 2>/dev/null || true)"

  if [[ -z "$tag" ]]; then
    echo "ERROR: could not find an agent release (tag vX.Y.Z) in $AGENT_REPO." >&2
    echo "Pin one by hand, e.g.:" >&2
    echo "  AGENT_RELEASE_URL_BASE=https://github.com/$AGENT_REPO/releases/download/v0.2.1 sudo -E ./install.sh" >&2
    return 1
  fi

  echo "https://github.com/$AGENT_REPO/releases/download/$tag"
}

# Where the binary being replaced is kept, so a bad build has something
# to go back to.
#
# The v0.2.3 and v0.2.6 rollouts both did this by hand -- the operator
# copied /usr/local/bin/agentd aside before running menu option 2 --
# and the journal entry for each said afterwards that it was worth
# having kept. A step that is only ever remembered is a step that gets
# skipped on the one node where it mattered, so it is the installer's
# job now. Path matches what the v0.2.6 rollout used by hand, so the
# binaries already sitting on ir1 are in the right place.
AGENT_ROLLBACK_DIR="${AGENT_ROLLBACK_DIR:-/root/agent-rollback}"
# Deliberately small. These are ~20MB apiece and the useful window is
# "the release before this one", not the node's whole history.
AGENT_ROLLBACK_KEEP="${AGENT_ROLLBACK_KEEP:-5}"
# Set by backup_current_agent so fetch_agent_binary can put the old
# binary back without re-deriving the name.
AGENT_ROLLBACK_LAST=""

# Copies the installed agentd aside before it is overwritten, recording
# its sha256 alongside.
#
# Named `agentd-<version>-<first 12 of sha256>` because neither half is
# enough on its own: every release before v0.2.6 reports `dev` (no -X
# stamp -- see release-agent.yml), so the version cannot tell two of
# them apart, and a bare hash cannot be read.
backup_current_agent() {
  local target="/usr/local/bin/agentd"
  AGENT_ROLLBACK_LAST=""
  # A fresh install has nothing to keep, and that is not a problem.
  [[ -f "$target" ]] || return 0

  local sum short ver name
  sum="$(sha256sum "$target" | awk '{print $1}')"
  short="${sum:0:12}"

  # The outgoing binary's own idea of what it is. Anything before
  # v0.2.6 has no --version flag at all and exits non-zero on it, so an
  # empty reading is expected rather than an error -- hence `|| true`,
  # which pipefail would otherwise turn into an aborted update.
  ver="$( { "$target" --version 2>/dev/null || true; } | awk 'NR==1 {print $2}')"
  # This ends up in a filename, so keep it to what a version can contain.
  ver="${ver//[^A-Za-z0-9._-]/}"
  [[ -n "$ver" ]] || ver="unknown"

  name="agentd-${ver}-${short}"
  install -d -m 700 "$AGENT_ROLLBACK_DIR"
  install -m 755 "$target" "$AGENT_ROLLBACK_DIR/$name"
  # Written in sha256sum's own format, so checking a rollback candidate
  # is `sha256sum -c agentd-v0.2.5-8cc30b52.sha256` rather than
  # eyeballing hex.
  echo "$sum  $name" > "$AGENT_ROLLBACK_DIR/$name.sha256"
  AGENT_ROLLBACK_LAST="$AGENT_ROLLBACK_DIR/$name"
  echo "Backed up the current agent to $AGENT_ROLLBACK_LAST"

  # Bounded, or a node that updates weekly grows a 20MB file a week
  # forever on the same disk the engines log to.
  local stale entry
  mapfile -t stale < <(find "$AGENT_ROLLBACK_DIR" -maxdepth 1 -type f -name 'agentd-*' ! -name '*.sha256' -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n "+$((AGENT_ROLLBACK_KEEP + 1))" | cut -d' ' -f2-)
  for entry in ${stale[@]+"${stale[@]}"}; do
    [[ -n "$entry" ]] || continue
    rm -f "$entry" "$entry.sha256"
  done
}

# Confirms the binary now on disk is the release that was just asked
# for, before anything restarts the service.
#
# This is the check six nodes needed and did not have: until v0.2.6
# stamped the tag in, every node reported agentVersion=dev, so a rollout
# that silently no-op'd looked exactly like one that worked and the only
# way to tell them apart was sha256 on each box. `--version` exists to
# make that assertable (agent/cmd/agentd/main.go handles it before it
# reads any config), so assert it.
check_agentd_version() {
  local want="$1" reported
  reported="$( { /usr/local/bin/agentd --version 2>/dev/null || true; } | head -n 1)"

  # Nothing printed means a pre-v0.2.6 binary, which has no --version
  # flag and exits on it. Pinning an old release deliberately is a real
  # thing to do, so this is the unverifiable case, not the wrong one --
  # said out loud rather than passed silently.
  if [[ -z "$reported" ]]; then
    echo "WARNING: the installed binary does not support --version, so it is a" >&2
    echo "         pre-v0.2.6 build and $want could not be confirmed. Check it with" >&2
    echo "         sha256sum /usr/local/bin/agentd against the release's sha256sums.txt." >&2
    return 0
  fi

  # Exactly the string release-agent.yml asserts on the artefact at
  # build time, so the two cannot drift apart:  agentd v0.2.6 (linux/amd64)
  if [[ "$reported" == "agentd $want (linux/$AGENT_ARCH)" ]]; then
    echo "Verified: $reported"
    return 0
  fi

  echo "ERROR: $want was requested but the installed binary reports:" >&2
  echo "         $reported" >&2
  return 1
}

fetch_agent_binary() {
  local asset_name="agentd-linux-$AGENT_ARCH"
  local base tag
  base="$(resolve_agent_release_base)" || exit 1
  # The last path segment of a release download base is its tag, for the
  # resolved URL and for a pinned AGENT_RELEASE_URL_BASE alike.
  tag="${base##*/}"

  echo "Downloading agent binary for linux/$AGENT_ARCH from ${base##*/}..."
  # Saved under the same name sha256sums.txt references (not a generic
  # "agentd") -- sha256sum -c verifies by matching the exact filename in
  # each checksum line against a file of that name in the cwd. (This
  # tripped up an earlier version of this function -- see git history.)
  curl -fsSL "$base/$asset_name" -o "/tmp/$asset_name"
  curl -fsSL "$base/sha256sums.txt" -o /tmp/sha256sums.txt

  if ! (cd /tmp && grep "$asset_name" sha256sums.txt | sha256sum -c -); then
    echo "ERROR: checksum verification failed, aborting install." >&2
    exit 1
  fi

  backup_current_agent
  install -m 755 "/tmp/$asset_name" /usr/local/bin/agentd
  rm -f "/tmp/$asset_name" /tmp/sha256sums.txt

  # Only when the tag is a version we can compare against. A self-hosted
  # AGENT_RELEASE_URL_BASE need not end in one, and refusing to install
  # from it would be inventing a restriction that was never there.
  if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    if ! check_agentd_version "$tag"; then
      if [[ -n "$AGENT_ROLLBACK_LAST" && -f "$AGENT_ROLLBACK_LAST" ]]; then
        install -m 755 "$AGENT_ROLLBACK_LAST" /usr/local/bin/agentd
        echo "Put the previous binary back from $AGENT_ROLLBACK_LAST." >&2
      else
        rm -f /usr/local/bin/agentd
        echo "Removed it -- there was no previous binary to restore." >&2
      fi
      echo "The service was NOT restarted, so this node is still running what it was." >&2
      exit 1
    fi
  fi
}

action_install_agent() {
  require_root
  detect_os
  install_base_deps
  fetch_agent_binary
  install_agentd_unit

  # Must include /api -- nginx only proxies the backend under that
  # prefix (see installer/assets/nginx-panel.conf.template); the bare
  # domain hits the Next.js panel itself and 404s.
  read -r -p "Panel URL, including /api (e.g. https://connect.example.com/api): " panel_url

  cat <<'EOF'

Signing in to the panel. This install registers the node, its engines and
their routes for you, so there is nothing to copy into the panel by hand
afterwards -- the login is used for those API calls and is not stored.

EOF
  local token
  token="$(get_admin_bearer_token)" || exit 1

  # Two independent readings, because neither is right on its own and
  # getting this wrong is silent: the node enrols, looks healthy, and
  # every client dials an address that accepts nothing.
  #
  #   egress_ip    what the internet sees us come FROM (api.ipify.org)
  #   iface_ip     the address on the interface holding the default route
  #
  # They disagree in two opposite situations. On a cloud VM behind 1:1
  # NAT the interface holds a private address and ipify is correct. On a
  # host whose outbound traffic is NAT'd or proxied through a different
  # address than it accepts inbound on -- seen for real on the Iran node,
  # where ipify reported one address while inbound only worked on a
  # different one -- the interface address is correct and ipify is
  # actively wrong. (Both addresses redacted; node addresses are not
  # committed, see docs/node-address-hygiene.md.)
  #
  # Nothing here can tell those apart, so when they differ we say so and
  # make it a deliberate choice instead of defaulting into a broken node.
  local egress_ip iface_ip detected_ip
  egress_ip="$(curl -fsSL --max-time 10 https://api.ipify.org || true)"
  iface_ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"

  # Prefer the interface address when it is a real public one: it is the
  # address we actually accept connections on, which is what a client
  # needs. A private interface address means we are behind NAT and the
  # egress reading is the useful one.
  if [[ -n "$iface_ip" && ! "$iface_ip" =~ ^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
    detected_ip="$iface_ip"
  else
    detected_ip="$egress_ip"
  fi

  if [[ -n "$egress_ip" && -n "$iface_ip" && "$egress_ip" != "$iface_ip" ]]; then
    echo
    echo "  NOTE: this host's outbound address differs from its interface address."
    echo "    interface (what we accept connections on): $iface_ip"
    echo "    outbound  (what the internet sees):        $egress_ip"
    echo "  Customers must be given the one that accepts INBOUND connections."
    echo "  Suggesting $detected_ip -- override it below if that is wrong."
  fi

  echo
  read -r -p "Name for this node (e.g. finland-1): " node_name
  read -r -p "Region label (e.g. fi-finland): " node_region
  read -r -p "Public IP [$detected_ip]: " node_ip
  node_ip="${node_ip:-$detected_ip}"

  cat <<'EOF'

Node role:
  1) STANDALONE -- customers connect to it and it exits to the internet here
  2) EXIT       -- traffic exits here, fed by relay nodes elsewhere
  3) RELAY      -- customers connect here, traffic is forwarded to an exit node
                   (for censored networks; you'll pick the exit node next)
EOF
  local role_choice node_role
  read -r -p "Choice [1]: " role_choice
  case "${role_choice:-1}" in
    2) node_role="EXIT" ;;
    3) node_role="RELAY" ;;
    *) node_role="STANDALONE" ;;
  esac
  # Consulted by create_route_for_config for every engine installed
  # below, so the exit node is chosen once rather than per protocol.
  node_is_relay="n"
  [[ "$node_role" == "RELAY" ]] && node_is_relay="y"

  echo
  echo "Creating this node in the panel..."
  local node_response
  node_response="$(curl -sSL -X POST "$panel_url/nodes" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$(jq -n --arg name "$node_name" --arg role "$node_role" --arg region "$node_region" --arg ip "$node_ip" \
      '{name: $name, role: $role, region: $region, publicIp: $ip}')")"

  local node_id
  node_id="$(echo "$node_response" | jq -r '.id // empty')"
  if [[ -z "$node_id" ]]; then
    echo "ERROR: could not create the node in the panel." >&2
    echo "  Response: $(echo "$node_response" | jq -r '.message // .' 2>/dev/null || echo "$node_response")" >&2
    exit 1
  fi

  # The enrollment token is minted here rather than copied out of the
  # panel by hand. It's still single-use and short-lived -- it just never
  # has to cross a human's clipboard.
  local enroll_token
  enroll_token="$(curl -sSL -X POST "$panel_url/nodes/$node_id/enrollment-tokens" \
    -H "Authorization: Bearer $token" | jq -r '.token // empty')"
  if [[ -z "$enroll_token" ]]; then
    echo "ERROR: could not issue an enrollment token for this node." >&2
    exit 1
  fi

  # Where the agent will reach the control plane's gRPC, which is NOT
  # necessarily the panel's hostname.
  #
  # The agent defaults to <panel host>:50051. That is right for a panel
  # exposed directly and wrong for one behind Cloudflare, which proxies
  # 80 and 443 and nothing else -- the agent then dials a Cloudflare
  # address on 50051, gets "network is unreachable", and retries every
  # second forever while the panel shows the node PENDING with no
  # explanation. Two nodes have been lost to this, and both times the
  # fix was one field in a config file nobody knew to edit.
  #
  # So it is measured rather than assumed: if the panel's own hostname
  # answers on 50051, the default is correct and nothing is asked.
  local panel_host grpc_target
  panel_host="$(printf '%s' "$panel_url" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  grpc_target="${NEOXIFY_GRPC_TARGET:-}"
  if [[ -z "$grpc_target" ]]; then
    if timeout 6 bash -c "cat < /dev/null > /dev/tcp/$panel_host/50051" 2>/dev/null; then
      echo "  gRPC reaches $panel_host:50051; using it."
    else
      cat <<EOF

  $panel_host does not answer on 50051, so the agent cannot reach the
  control plane there. That is normal when the panel sits behind a CDN:
  only 80 and 443 are proxied. Give the panel's own address instead --
  the one you SSH to -- and the agent will use it for gRPC only.

EOF
      read -r -p "Panel gRPC address [host:50051, blank to use $panel_host:50051]: " grpc_target
    fi
  fi

  echo "Enrolling agent..."
  if [[ -n "$grpc_target" ]]; then
    [[ "$grpc_target" == *:* ]] || grpc_target="$grpc_target:50051"
    /usr/local/bin/agentd --enroll-init --panel-url "$panel_url"       --token "$enroll_token" --grpc-target "$grpc_target"
  else
    /usr/local/bin/agentd --enroll-init --panel-url "$panel_url" --token "$enroll_token"
  fi

  install -d -m 755 /etc/neoxify
  echo "agent" > /etc/neoxify/role

  # Started here, before any protocol is registered, and deliberately
  # not at the end.
  #
  # It used to run last, so anything that failed during registration --
  # a rate limit, an unset variable, a bad password -- left a node with
  # its engines installed, its configs in the panel, and the agent never
  # switched on. Nothing said so: the error was about whatever had
  # actually failed, and the missing agent was silent. A real second-node
  # install ended exactly there, showing PENDING with no clue why, and
  # the fix was a single `systemctl start` nobody knew to run.
  #
  # An agent with no protocols yet is harmless -- it connects, reports
  # in, and has nothing to do. So the ordering costs nothing and means a
  # partial install leaves something alive and visible in the panel
  # rather than something that looks finished and is inert.
  start_agentd

  echo
  read -r -p "Install Xray (VLESS+REALITY) on this node now? [Y/n]: " install_xray_choice
  if [[ "${install_xray_choice,,}" != "n" ]]; then
    install_xray
  fi

  echo
  read -r -p "Install WireGuard on this node now? [Y/n]: " install_wg_choice
  if [[ "${install_wg_choice,,}" != "n" ]]; then
    install_wireguard
  fi

  echo
  read -r -p "Install OpenVPN on this node now? [Y/n]: " install_ovpn_choice
  if [[ "${install_ovpn_choice,,}" != "n" ]]; then
    install_openvpn
  fi

  # Defaults to no, unlike the others. IKEv2 is the easiest protocol
  # here to fingerprint, so it belongs on a node kept apart from the
  # stealth ones rather than added everywhere out of habit.
  echo
  read -r -p "Install IKEv2 (strongSwan) on this node now? [y/N]: " install_ikev2_choice
  if [[ "${install_ikev2_choice,,}" == "y" ]]; then
    install_ikev2
  fi

  cat <<EOF

Done. "$node_name" is registered with its engines and routes, and should
already show as ONLINE in the panel.

ONE STEP REMAINS, and without it this node serves nobody:

  Its routes are not in any plan yet. Plans carry an explicit list of
  the routes they allow, and enrolling a node does not add it to them --
  so until you do, the node is ONLINE with every protocol working and
  invisible to every customer. Open each plan in the panel and tick this
  node's routes.

  This is not hypothetical: germany-1 was built with all eight protocols
  and a verified exit IP, and a real subscription still could not see a
  single one of them.

To change ports or parameters later, edit the Protocol Config in the
panel.

Check the agent with: systemctl status neoxify-agentd
EOF
}

# One dull page, written where it is asked for.
#
# Deliberately dull and impersonal. A page claiming to be some real
# organisation would be a lie told to whoever looks, and a page saying
# "VPN" would undo the entire point.
#
# Different on every node, which is the part that took a second pass.
# This page is what an active prober gets when it opens a port and
# speaks ordinary HTTP or HTTPS -- and at one point every node in the
# fleet returned the same 118 bytes. That is a fingerprint of *us*:
# probe a suspected address, hash the response, compare against a known
# Neoxify node, and the whole fleet is enumerable without breaking a
# single tunnel. Varying the text, the title and the length means a
# match has to be made some other way.
#
# Not idempotent by design: a re-run picks again. Nothing depends on the
# page's contents, and a node whose disguise changes occasionally is if
# anything the more ordinary-looking one.
write_disguise_page() {
  local dir="$1"
  install -d -m 755 "$dir" || return 1
  local pages=(
    "Welcome|This site is being set up."
    "Coming soon|Content will appear here shortly."
    "Index of /|Nothing to see here yet."
    "Under construction|This page is not finished."
    "Hello|Server is running."
  )
  local choice="${pages[RANDOM % ${#pages[@]}]}"
  local title="${choice%%|*}"
  local body="${choice##*|}"
  cat > "$dir/index.html" <<HTML
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p>
<!-- $(openssl rand -hex 8) --></body>
</html>
HTML
}

# What port 80 answers, and why it answers at all.
#
# Installing nginx for the loopback fallback also enables Ubuntu's stock
# default vhost, and that one listens on 0.0.0.0:80 no matter what the
# fallback does. Four of the five live nodes were therefore serving
# "Welcome to nginx!" -- byte-identical, 615 bytes, `Server:
# nginx/1.24.0 (Ubuntu)` and all -- to anyone who asked. Nobody chose
# that. It is a fleet-wide fingerprint on a product whose entire value is
# not looking like a VPN, and it is exactly what a sweep for "default
# nginx on a VPS with odd high ports open" is built to find.
#
# Three options were on the table, and two of them are wrong:
#
#   * Close port 80. Wrong, and this is the expensive way to find out.
#     Let's Encrypt's HTTP-01 challenge needs inbound TCP 80 at *every
#     renewal*, not just at issue, and certbot replays whatever
#     authenticator is recorded in /etc/letsencrypt/renewal/*.conf. On
#     the live fleet that is `webroot` with /var/www/html on france-1 and
#     turkey-1 -- served today by the very default vhost we are
#     removing -- and `standalone` on finland1 and singapore-1. Closing
#     80 breaks the first pair immediately and the second pair as soon as
#     anything else takes the port. Certificates expire silently, and
#     Xray fails its whole config on an unreadable certificate, so the
#     node loses every TLS inbound at once about ninety days later.
#   * Redirect to https. Wrong for a node specifically. Port 443 here is
#     REALITY, which impersonates somebody else's site: a 301 to
#     https://<this node> walks the scanner into a handshake that returns
#     a certificate for a Turkish hardware forum on a Scaleway address.
#     That is a louder mismatch than the page we are trying to remove,
#     and a node addressed by IP has no name to redirect to anyway.
#   * Serve a plain static page. Chosen. It is the same dull, per-node
#     page the loopback fallback already serves, so the two agree with
#     each other; `server_tokens off` drops the version banner the
#     default vhost was volunteering; and an ACME location keeps the
#     renewal path that france-1 and turkey-1 depend on today working
#     unchanged.
#
# Taking the port also means taking responsibility for the two nodes
# whose certificates renew with `standalone`, which cannot bind a port
# nginx is holding. Those are migrated to webroot here rather than left
# to fail in the quietest possible way three months from now.
ensure_port80_site() {
  command -v nginx >/dev/null 2>&1 || return 0

  # The webroot ACME wants, whether or not certbot is on the box yet:
  # install_ikev2 looks for this directory before it decides between the
  # webroot and standalone challenges.
  install -d -m 755 /var/www/html/.well-known/acme-challenge
  write_disguise_page /var/www/html || return 1

  cat > /etc/nginx/sites-available/neoxify-http <<'CONF'
# Managed by the Neoxify agent installer.
#
# Ubuntu's default vhost used to hold this port and announce both nginx's
# version and the fact that nobody had configured it. This replaces it
# with something an internet-wide scan has no reason to record.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # The version string is a fingerprint of its own, and the default
    # vhost was handing it out.
    server_tokens off;

    root /var/www/html;
    index index.html;

    # Let's Encrypt's HTTP-01 challenge, for both the Xray certificate
    # and IKEv2's. This location is the reason port 80 stays open at all;
    # deleting it breaks certificate renewal on every node that uses the
    # webroot authenticator, and the failure surfaces ninety days later
    # as expired certificates rather than as anything pointing here.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
CONF

  # The distro default and this one both claim default_server, so the
  # old link has to go before nginx will accept the new one.
  local had_default="n"
  [[ -e /etc/nginx/sites-enabled/default ]] && had_default="y"
  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/neoxify-http /etc/nginx/sites-enabled/neoxify-http

  # A node with IPv6 disabled cannot bind [::]:80 and nginx refuses the
  # whole config for it. Drop that one line and retry rather than leave
  # the port to whatever was there.
  if ! nginx -t >/dev/null 2>&1; then
    sed -i '/listen \[::\]:80 default_server;/d' /etc/nginx/sites-available/neoxify-http
  fi

  if ! nginx -t >/dev/null 2>&1; then
    # Put the port back the way it was, fingerprint and all. An ugly
    # page is survivable; a port 80 that answers nothing is not, because
    # the webroot ACME challenge renews through it and the certificate
    # failure would surface three months later as dead TLS inbounds.
    echo "nginx rejected the port 80 site -- something else may already claim" >&2
    echo "default_server there. Restoring what was there before." >&2
    rm -f /etc/nginx/sites-enabled/neoxify-http
    [[ "$had_default" == "y" ]] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    nginx -t >/dev/null 2>&1 && { systemctl reload nginx 2>/dev/null || true; }
    return 1
  fi
  systemctl reload nginx 2>/dev/null || systemctl restart nginx

  migrate_standalone_acme_to_webroot
}

# Certificates that renew by binding port 80 themselves cannot do that
# once nginx holds it.
#
# certbot records its authenticator per certificate and replays it at
# renewal, so a certificate first issued with --standalone keeps trying
# to bind :80 forever. That is fine on a node with nothing else there and
# fatal the moment nginx arrives -- and nginx arrives with the fallback
# site, on every node that serves Trojan or VLESS over TLS. singapore-1
# is in exactly that state today: `authenticator = standalone` recorded,
# nginx listening on 0.0.0.0:80, and a renewal that will fail with an
# address already in use.
#
# Rewriting the renewal file is the documented way to change an
# authenticator without forcing an early renewal; `certbot renew
# --dry-run` afterwards is what proves it, and the caller is told to run
# it rather than being told it worked.
migrate_standalone_acme_to_webroot() {
  local conf name changed=0
  [[ -d /etc/letsencrypt/renewal ]] || return 0
  for conf in /etc/letsencrypt/renewal/*.conf; do
    [[ -e "$conf" ]] || continue
    grep -qE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*standalone' "$conf" || continue
    name="$(basename "$conf" .conf)"
    cp -a "$conf" "${conf}.bak-$(date +%s)"
    # Drop any stale webroot keys first so this is safe to run twice.
    sed -i -E '/^[[:space:]]*webroot_path[[:space:]]*=/d; /^\[\[webroot_map\]\]/,$d' "$conf"
    sed -i -E 's|^([[:space:]]*authenticator[[:space:]]*=[[:space:]]*)standalone[[:space:]]*$|\1webroot|' "$conf"
    printf 'webroot_path = /var/www/html,\n[[webroot_map]]\n%s = /var/www/html\n' "$name" >> "$conf"
    echo "  $name renewed with --standalone, which cannot bind a port nginx now holds."
    echo "  Switched it to the webroot challenge under /var/www/html."
    changed=1
  done
  if [[ "$changed" == 1 ]]; then
    echo "  Verify before trusting it:  certbot renew --dry-run"
  fi
  return 0
}

# The site a wrong Trojan password is handed to.
#
# This is the disguise, not decoration. Without a fallback, a prober who
# guesses wrong gets a connection reset, which says "something that is
# not a web server is listening here". With one, they get a real page and
# a real certificate, and the port is indistinguishable from any other
# small HTTPS site.
#
# Bound to loopback because it is only ever reached through Xray. Nothing
# on the public internet should be able to fetch it directly and notice
# an unused nginx sitting on a high port.
ensure_fallback_site() {
  if ! command -v nginx >/dev/null 2>&1; then
    echo "Installing nginx for the Trojan fallback site..."
    apt-get install -y -qq nginx || return 1
  fi

  write_disguise_page /var/www/neoxify-fallback || return 1

  # nginx is on the box now, and on Ubuntu that means its stock default
  # site is on the box too -- listening on 0.0.0.0:80 whatever this
  # loopback-only vhost does. Take port 80 deliberately before anything
  # else, so a fresh install never has a window where it is answering
  # "Welcome to nginx!" to the whole internet.
  ensure_port80_site || return 1

  # Where this node's API mirror forwards to. Read from the agent's own
  # config rather than a shell variable: this also runs on re-runs from
  # the management menu, where nothing prompted for a panel URL, and that
  # file is the one place the answer is already correct. It already ends
  # in /api -- see the prompt at enrollment.
  local panel_api=""
  if [[ -f /etc/neoxify/agent.json ]]; then
    panel_api="$(jq -r '.panelUrl // empty' /etc/neoxify/agent.json 2>/dev/null || true)"
  fi
  [[ -z "$panel_api" ]] && panel_api="${panel_url:-}"

  # This node as a mirror of the panel's API.
  #
  # It exists because one hardcoded control-plane address was a single
  # point of failure for the whole product, and it failed: the panel's IP
  # was filtered in Iran and every customer there lost sign-in, purchase,
  # support and updates at once -- on nodes that were not blocked at all.
  # With this, the set of reachable API endpoints is the set of reachable
  # VPN nodes, and if every node is blocked there is no product anyway.
  #
  # No new port and no new certificate: Xray's TLS inbounds already
  # answer anything that is not a valid VPN connection with this server,
  # so an ordinary HTTPS request to the same port and name lands here. To
  # anyone probing, it is the fallback site -- the same disguise the
  # tunnel already relies on.
  # Split the panel URL so proxy_pass can name the host in a variable,
  # and find a resolver for it. systemd-resolved is what Ubuntu ships;
  # a node without it would otherwise get a config nginx refuses to load.
  local panel_scheme panel_host mirror_resolver
  panel_scheme="${panel_api%%://*}"
  [[ "$panel_scheme" == "$panel_api" ]] && panel_scheme="https"
  panel_host="${panel_api#*://}"
  panel_host="${panel_host%%/*}"
  if grep -qs "127.0.0.53" /etc/resolv.conf; then
    mirror_resolver="127.0.0.53"
  else
    mirror_resolver="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)"
    [[ -z "$mirror_resolver" ]] && mirror_resolver="1.1.1.1"
  fi

  local api_mirror=""
  if [[ -n "$panel_api" ]]; then
    printf -v api_mirror '%s\n' \
      "" \
      "    location /api/ {" \
      "        # Re-resolved at runtime rather than once at config load." \
      "        #" \
      "        # nginx caches the address of a literal hostname in" \
      "        # proxy_pass for the life of the process. When the panel" \
      "        # moved to a new VPS the nodes carried on proxying to the" \
      "        # old box, which was still up and answered every request" \
      "        # with 502 because its backend was gone. Only customers" \
      "        # reaching the API through a node mirror were affected --" \
      "        # which is to say only the ones in Iran, the people this" \
      "        # mirror exists for -- and they saw 502 the moment they" \
      "        # opened the app. The node logged no upstream error," \
      "        # because a 502 is a valid response, so nothing pointed" \
      "        # at the cause." \
      "        #" \
      "        # A resolver plus a variable forces a fresh lookup, so a" \
      "        # panel move is picked up within the TTL instead of" \
      "        # needing a manual reload on every node. \$request_uri" \
      "        # carries path and query through unchanged, which a" \
      "        # variable proxy_pass does not do on its own." \
      "        resolver ${mirror_resolver} valid=30s ipv6=off;" \
      "        resolver_timeout 5s;" \
      "        set \$neoxify_panel ${panel_host};" \
      "        proxy_pass ${panel_scheme}://\$neoxify_panel\$request_uri;" \
      "        proxy_set_header Host \$neoxify_panel;" \
      "        # The panel rate-limits per client address, so the real" \
      "        # one has to survive the hop -- otherwise every customer" \
      "        # arriving through this node looks like one very busy" \
      "        # client and they throttle each other." \
      "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;" \
      "        proxy_set_header X-Forwarded-Proto https;" \
      "        proxy_ssl_server_name on;" \
      "        # Support threads and update downloads are the long ones." \
      "        proxy_read_timeout 120s;" \
      "    }"
  else
    echo "  Note: no panel URL on record, so this node will not mirror the API." >&2
  fi

  # The same site twice, on two sockets: 8080 for HTTP/1.1, 8081 for
  # HTTP/2, with Xray choosing between them on the negotiated ALPN.
  #
  # This is not a preference, it is an nginx version limit. Before 1.25.1
  # there is no `http2 on;` directive that auto-detects, and the `http2`
  # listen flag on a cleartext socket forces h2c -- verified live on
  # nginx 1.24: adding it fixed HTTP/2 and broke HTTP/1.1 outright, three
  # runs, against an untouched node as a control.
  #
  # It has to work over HTTP/2 at all because the TLS inbounds advertise
  # h2 so they look like an ordinary web server, and anything modern
  # takes that offer. While these listeners were HTTP/1.1-only, every
  # HTTP/2 client got ERR_HTTP2_PROTOCOL_ERROR -- which silently disabled
  # the node API mirrors, the fallback path the clients rely on when the
  # control plane's own address is blocked.
  : > /etc/nginx/sites-available/neoxify-fallback
  for listen_directive in "8080" "8081 http2"; do
    cat >> /etc/nginx/sites-available/neoxify-fallback <<CONF
server {
    # proxy_protocol because Xray's fallback opens a fresh loopback
    # connection to get here. Without it nginx sees 127.0.0.1 as the
    # client for every request, which makes the API mirror above report
    # the wrong address to /health/ip -- breaking the check that proves
    # a tunnel carries traffic -- and puts every customer arriving
    # through this node into a single rate-limit bucket.
    #
    # Paired with "xver": 1 on the Xray fallbacks; neither works alone.
    listen 127.0.0.1:$listen_directive proxy_protocol;
    set_real_ip_from 127.0.0.1;
    real_ip_header proxy_protocol;

    server_name _;
    root /var/www/neoxify-fallback;
    index index.html;
    # No server tokens: the version string is a fingerprint of its own.
    server_tokens off;
$api_mirror
}
CONF
  done
  ln -sf /etc/nginx/sites-available/neoxify-fallback /etc/nginx/sites-enabled/neoxify-fallback
  nginx -t >/dev/null 2>&1 || { echo "nginx rejected the fallback site config" >&2; return 1; }
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
}

# Obtains a certificate for the Trojan inbound's domain.
#
# certbot standalone rather than the nginx plugin the panel installer
# uses: a node has no public web server to hook into, and the fallback
# site above is loopback-only on purpose. Standalone binds port 80 for
# the duration of the challenge, which is why this runs before Xray is
# reconfigured rather than alongside it.
issue_tls_certificate() {
  local domain="$1"

  if ! command -v certbot >/dev/null 2>&1; then
    echo "Installing certbot..."
    apt-get update -qq && apt-get install -y -qq certbot || return 1
  fi

  if [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
    echo "Certificate for $domain already present -- reusing it."
  else
    echo "Requesting a certificate for $domain..."
    echo "Inbound TCP 80 must reach this node and $domain must already resolve here."
    read -r -p "Email for expiry notices: " le_email
    # Webroot when something already holds port 80, standalone only on a
    # node that genuinely has nothing there -- the same order install_ikev2
    # uses, and for the same reason.
    #
    # On a fresh install this runs before nginx exists, so standalone is
    # what fires and the renewal file records `standalone`. That is the
    # state singapore-1 and finland1 are in, and it is a slow-motion
    # outage: nginx arrives minutes later for the fallback site, takes
    # port 80, and every future renewal fails to bind it. ensure_port80_site
    # migrates those records to webroot once it owns the port. Re-runs
    # from the management menu reach here with nginx already up, and take
    # the webroot branch directly.
    local acme_args=(--standalone)
    if [[ -d /var/www/html ]] && ss -tln 2>/dev/null | grep -qE "[^0-9]:80[[:space:]]"; then
      echo "Something already serves port 80; using the webroot challenge."
      acme_args=(--webroot -w /var/www/html)
    fi
    if ! certbot certonly "${acme_args[@]}" -d "$domain" -m "$le_email" --agree-tos --non-interactive; then
      echo "Could not obtain a certificate for $domain." >&2
      echo "Check that its DNS record points here, that inbound TCP 80 reaches" >&2
      echo "this node including any cloud firewall, and that whatever holds" >&2
      echo "port 80 serves /var/www/html." >&2
      return 1
    fi
  fi

  # Unconditionally, not only on a fresh issue. Returning early when
  # certbot already had the certificate skipped the copy into a place
  # Xray can read, so a node with an existing certificate and no copy
  # got a config pointing at files Xray cannot open -- and an unreadable
  # certificate fails the whole config, taking the working VLESS inbound
  # down with it. That is the outage this function's comments already
  # describe; the early return reintroduced it for a different reason.
  # Safe to repeat: the copy and the renewal hook are both idempotent.
  install_cert_for_xray "$domain" || return 1
}

# Copies the certificate somewhere Xray can actually read it.
#
# Xray's unit runs as User=nobody while certbot keeps /etc/letsencrypt
# at 0700 root, so Xray cannot open the live files -- and an unreadable
# certificate fails the entire config, taking every other inbound on the
# node down with it. Copying is the narrow fix; loosening
# /etc/letsencrypt would hand every key on the box to every process
# running as nobody.
install_cert_for_xray() {
  local domain="$1"

  install -d -m 755 /usr/local/etc/xray/certs
  cat > /usr/local/bin/neoxify-sync-certs <<SYNC
#!/bin/sh
set -e
DEST="/usr/local/etc/xray/certs"
install -d -m 755 "\$DEST"
cp "/etc/letsencrypt/live/$domain/fullchain.pem" "\$DEST/fullchain.pem"
cp "/etc/letsencrypt/live/$domain/privkey.pem" "\$DEST/privkey.pem"
chown nobody:nogroup "\$DEST/fullchain.pem" "\$DEST/privkey.pem"
chmod 644 "\$DEST/fullchain.pem"
chmod 400 "\$DEST/privkey.pem"
SYNC
  chmod +x /usr/local/bin/neoxify-sync-certs
  /usr/local/bin/neoxify-sync-certs || return 1

  install_verified_xray_restart

  # Xray reads its certificate once at startup, so a renewal it is never
  # told about means serving an expired certificate roughly three months
  # from now -- long after anyone would connect the two events. The copy
  # has to be refreshed first, or the restart just re-reads the old one.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-xray.sh <<'HOOK'
#!/bin/sh
set -e
# Copy the renewed certificate where Xray can read it, and stop there.
#
# This used to read `systemctl reload xray 2>/dev/null || systemctl
# restart xray`, with a comment saying a renewal was no reason to drop
# every connected customer. It always dropped them: xray.service ships no
# ExecReload -- `systemctl show xray -p CanReload` answers `no` on every
# node in the fleet -- so the reload could never succeed and the `||`
# swallowed the reason. Every renewal was a full restart, announced as a
# reload, and a restart erases every hot-added inbound, user and relay
# route from the running process.
#
# Nothing needs to be signalled at all. Xray re-reads certificateFile and
# keyFile from disk by itself, on roughly an hourly cycle: measured
# 2026-08-24 on a throwaway loopback instance, files swapped at 00:06:16
# and the new certificate served between +55min and +60min, with no
# signal and no restart. certbot renews with thirty days to spare, so an
# hour of lag costs nothing.
#
# The unit could not have been given a working ExecReload in any case.
# Xray does not handle SIGHUP: sent to a running instance it terminates
# the process (measured the same day), so
# `ExecReload=/bin/kill -HUP $MAINPID` would be a restart wearing a
# different name, and `ExecReload=/bin/true` would be worse still -- a
# renewal reporting success while the old certificate is served until it
# expires.
#
# If a restart is ever genuinely needed, use neoxify-xray-restart, which
# checks that everything came back.
/usr/local/bin/neoxify-sync-certs
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-xray.sh
}

# A restart of Xray that reports what it cost.
#
# Installed as its own command so anything that has to restart Xray goes
# through the same check, and so an operator can run it by hand.
#
# Not wired into certificate renewal any more -- that path no longer
# restarts anything, because Xray reloads certificate files on its own.
# This is for the cases where a restart is genuinely unavoidable, such as
# a config.json change.
#
# The failure it exists to catch: a restart empties everything hot-added
# over the gRPC API. Customers and relay routes are re-asserted
# by the control plane within ~60s, but an inbound that was added at
# runtime and never written to config.json is gone for good -- and the
# node would keep reporting itself healthy, because nothing compares what
# is listening against what should be.
#
# Exits non-zero when an inbound does not come back, which is what makes
# certbot's own output and `systemctl status certbot.timer` show it
# rather than the whole thing passing in silence.
install_verified_xray_restart() {
  cat > /usr/local/bin/neoxify-xray-restart <<'RESTART'
#!/bin/sh
set -u
API="127.0.0.1:10085"
XRAY="/usr/local/bin/xray"
MARKER="/var/log/neoxify-xray-restart.log"

tags() {
  "$XRAY" api lsi -s "$API" 2>/dev/null | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p' | sort
}

say() {
  echo "$(date -Is) $*" >> "$MARKER"
  logger -t neoxify-xray-restart "$*" 2>/dev/null || true
  echo "$*"
}

BEFORE="$(tags)"
say "restarting xray; inbounds before: $(echo "$BEFORE" | tr '\n' ' ')"

systemctl restart xray || { say "FAILED: systemctl restart xray returned non-zero"; exit 1; }

# The API is not up the instant systemd returns. Poll rather than sleep a
# guessed amount: too short reports a false loss, too long is dead time on
# a node that is currently serving nobody.
i=0
while [ "$i" -lt 30 ]; do
  AFTER="$(tags)"
  [ -n "$AFTER" ] && break
  i=$((i + 1))
  sleep 1
done

if [ -z "${AFTER:-}" ]; then
  say "FAILED: xray restarted but its API never answered -- the node is serving nothing"
  exit 1
fi

TMPB="$(mktemp)"; TMPA="$(mktemp)"
printf '%s\n' "$BEFORE" > "$TMPB"
printf '%s\n' "$AFTER" > "$TMPA"
MISSING="$(comm -23 "$TMPB" "$TMPA")"
rm -f "$TMPB" "$TMPA"
if [ -n "$MISSING" ]; then
  say "FAILED: inbound(s) did not come back after restart: $(echo "$MISSING" | tr '\n' ' ')"
  say "        these existed only in the running process. Add them to /usr/local/etc/xray/config.json."
  exit 1
fi

say "ok: all inbounds back ($(echo "$AFTER" | tr '\n' ' ')). Users and relay routes are re-asserted by the control plane within ~60s."
RESTART
  chmod +x /usr/local/bin/neoxify-xray-restart
}

# Candidate camouflage destinations for REALITY, checked against this
# node before any of them is offered.
#
# Two groups, and which one is right depends on where this node is
# hosted -- see the note printed with the prompt. The list is short on
# purpose: it is a starting point that has been verified reachable, not
# a claim that these are the only good answers. Anything the operator
# knows to be a better fit for this node's address wins.
#
# What is NOT here is as deliberate as what is:
#   * cloudflare.com, google.com and the other stock tutorial answers.
#     Their address ranges are published, so "SNI says Cloudflare, the
#     packet is going to a Hetzner box" is a check a filter runs at line
#     rate with no inspection at all. The same argument rules out any
#     centrally-hosted property -- Google, Fastly, Apple, Akamai.
#   * www.microsoft.com. Endpoint security software on real customer
#     machines intercepts it, and REALITY then fails with "received real
#     certificate" because the interceptor's certificate arrives instead
#     of the expected one. Found live on a customer's machine; see
#     docs/detection-resistance.md.
#   * A country's own big CDN, which is the same mistake wearing local
#     clothes. Measured while choosing ir1's dest: varzesh3.com resolves
#     into AbrArvan's published anycast range and divar.ir/zoomit.ir into
#     Sotoon's. Claiming one of those names from an address in an
#     ordinary hosting block is exactly the one-lookup mismatch
#     cloudflare.com was rejected for.
#   * A household name on its own branded block. digikala.com answers
#     from a range registered "Digikala-B4" and aparat.com from
#     "SABAIDEA-NETWORK". Those are trivial to enumerate and to check,
#     and they are the names a filter has most reason to have mapped
#     already.
#
# What is left, and what these lists now hold, is the awkward middle: a
# real site with real traffic, hosted on some hosting company's address
# space rather than on a CDN or its own vanity block. The check a censor
# would need is then per-domain rather than per-range, which is the whole
# point.
#
# The IR entries were each verified from ir1 itself -- TLS 1.3, ALPN h2,
# certificate verified -- and their address blocks looked up. Do not take
# that as permanent: hosting moves, and the probe below is what decides,
# not this list.
REALITY_DEST_CANDIDATES_IR=(
  # AS215708 Mobin Arvand Infrastructure -- an ordinary Iranian hosting
  # block, the same shape of address as a VPS. This is what ir1 uses.
  www.torob.com
  # AS31549 Aria Shatel, the ISP's own infrastructure.
  www.shatel.ir
)
# www.zoomit.ir was the third entry here, kept because it passed the
# handshake checks. It answers from AS202319 Sotoon-CDN and stamps an
# x-edge- header on its responses, so the ownership check added below
# now rejects it -- which is the same conclusion the paragraph about
# AbrArvan and Sotoon above had already reached in prose, finally being
# enforced by something.
# The rot this second list used to carry, and why the fix was not a new
# list.
#
# www.speedtest.net was dropped from here once for resolving into
# Cloudflare. On 2026-08-22 both remaining entries had gone the same way:
# www.asus.com and www.leboncoin.fr answer from AWS CloudFront edge
# ranges. They passed every check probe_reality_dest made -- TLS 1.3, h2,
# X25519, certificate verified -- because that function tested the
# handshake and nothing tested *who owns the address*. The default handed
# to an operator holding Enter was therefore a CDN's name on a non-CDN
# address: exactly the one-lookup mismatch this list exists to avoid.
#
# Swapping in fresh names would rot the same way, on nobody's schedule
# but the decoy operator's. So the ownership test moved into the probe
# below, where it runs on every install against whatever the name
# resolves to that day, and a rotted entry is rejected loudly instead of
# being offered as the default. This list is a seed, not an answer.
#
# Spread across regions on purpose: a node wants a name from the country
# it is hosted in (criterion 1 below), and the probe prints each
# candidate's country and network so the operator can see which of these
# fits this box.
REALITY_DEST_CANDIDATES_ABROAD=(
  # Each of these was run through the probe below on 2026-08-23 and
  # passed every check, with the announcing AS named next to it. That
  # measurement was taken from one vantage point; the probe re-takes it
  # from the node being installed, which is the only one that counts.
  #
  # AS6205 HizliNet Teknoloji, TR. turkey-1 already uses this one.
  www.donanimhaber.com
  # AS12306 Plus.line AG, DE.
  www.heise.de
  # AS8560 IONOS SE, DE -- a hosting company's own range, not a CDN.
  www.web.de
  # AS12322 Proxad/Free SAS, FR: a French ISP answering from its own
  # French addresses.
  www.free.fr
  # AS1741 FUNET, FI.
  www.helsinki.fi
  # AS138341 Shopee Singapore. Every consumer-facing .sg name probed for
  # singapore-1 sat behind Cloudflare, Imperva, Akamai or CloudFront;
  # this was the one that did not.
  www.shopee.sg
)

# Networks whose address ranges are published, which is what makes a name
# resolving into them a weak decoy.
#
# REALITY's disguise is a claim: "this connection is ordinary HTTPS to
# <name>". The cheapest way to catch a lie is to check that claim against
# the address the packet was actually sent to -- and Cloudflare, Amazon,
# Akamai, Fastly, Google and Microsoft all publish their ranges as
# machine-readable lists. "The ClientHello says www.asus.com, which lives
# in CloudFront, but this packet went to a Linode box in Singapore" is
# one table lookup at line rate with no inspection whatsoever. That is
# criterion 1, and until now nothing checked it.
#
# Matched three independent ways below, because each is evadable alone:
# the AS that originates the route, the CNAME chain the name resolves
# through, and the headers the edge adds to its own responses. By AS
# *name* as well as number, because numbers churn and a CDN nobody
# listed yet would slip past a fixed list in silence.
REALITY_CDN_AS_NAME_RE='CLOUDFLARE|AMAZON|AWS|CLOUDFRONT|AKAMAI|FASTLY|GOOGLE|MICROSOFT|AZURE|EDGECAST|EDGIO|INCAPSULA|IMPERVA|LIMELIGHT|LLNW|STACKPATH|HIGHWINDS|CDN77|BUNNY|SUCURI|GCORE|G-CORE|CACHEFLY|KEYCDN|QUANTIL|WANGSU|CHINANETCENTER|ARVANCLOUD|ABR-ARVAN|DERAK|SOTOON|ALIBABA|ALICLOUD|TENCENT'
REALITY_CDN_ASNS=' 13335 16509 14618 16625 20940 12222 35994 21342 21357 54113 15133 199524 19551 22822 33438 60068 200325 30148 30081 15169 396982 8075 8068 8069 202468 44869 34011 '
REALITY_CDN_ZONE_RE='(cloudfront\.net|awsglobalaccelerator\.com|elb\.amazonaws\.com|akamaiedge\.net|akamai\.net|akamaized\.net|edgekey\.net|edgesuite\.net|akadns\.net|fastly\.net|fastlylb\.net|cloudflare\.net|azureedge\.net|azurefd\.net|trafficmanager\.net|incapdns\.net|impervadns\.net|b-cdn\.net|cdn77\.org|llnwd\.net|edgecastcdn\.net|stackpathdns\.com|sucuri\.net|gcdn\.co|cachefly\.net|kxcdn\.com|arvancdn\.ir|arvancloud\.ir|derak\.cloud|sotoon\.ir)\.?$'
REALITY_CDN_HEADER_RE='^(cf-ray|cf-cache-status|cf-apo-via|x-amz-cf-id|x-amz-cf-pop|x-akamai-|akamai-|x-iinfo|x-cdn|x-azure-ref|x-msedge-ref|x-fastly|x-served-by|x-sucuri-id|x-bunnycdn|x-edg[eio]-|x-gcore|server: *(cloudflare|akamaighost|ecacc|ecs|bunnycdn|sucuri|imperva|awselb))'

# One TXT lookup, by whatever this box can make one with.
#
# `dig` is not on a stock Ubuntu -- it lives in bind9-dnsutils, which
# install_base_deps now pulls in for exactly this. Kept degradable
# anyway, so a node built before that change still runs the rest of the
# probe instead of failing every candidate over a missing package.
reality_txt_lookup() {
  local name="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short +time=3 +tries=2 -t TXT "$name" 2>/dev/null | tr -d '"' | head -1
  elif command -v host >/dev/null 2>&1; then
    host -W 3 -t TXT "$name" 2>/dev/null | sed -n 's/.*descriptive text "\(.*\)"/\1/p' | head -1
  else
    return 1
  fi
}

# Who announces this address, printed as "ASN|AS name|country".
#
# Team Cymru's DNS interface rather than whois: it answers over ordinary
# UDP/53 using resolver tools that are already there, and it returns the
# *origin* AS -- the network that actually announces the route -- which
# is the field a censor's own table would be keyed on. Nothing else gives
# that without a whois client and one parse per registry.
# https://team-cymru.com/community-services/ip-asn-mapping/
reality_ip_owner() {
  local ip="$1" rev origin asn cc as_line as_name
  rev="$(awk -F. 'NF==4 {print $4"."$3"."$2"."$1}' <<<"$ip")"
  [[ -n "$rev" ]] || return 1
  origin="$(reality_txt_lookup "${rev}.origin.asn.cymru.com")" || return 1
  [[ -n "$origin" ]] || return 1
  # "16509 14618 | 13.32.0.0/15 | US | arin | 2011-01-06". More than one
  # AS can originate the same prefix; the first is enough to name it.
  asn="$(awk -F'|' '{print $1}' <<<"$origin" | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1)"
  cc="$(awk -F'|' '{gsub(/ /,"",$3); print $3}' <<<"$origin")"
  as_name="unknown"
  if [[ -n "$asn" ]]; then
    as_line="$(reality_txt_lookup "AS${asn}.asn.cymru.com" || true)"
    # "16509 | US | arin | 2000-05-04 | AMAZON-02, US"
    if [[ -n "$as_line" ]]; then
      as_name="$(awk -F'|' '{sub(/^ +/,"",$5); sub(/ +$/,"",$5); print $5}' <<<"$as_line")"
    fi
  fi
  printf '%s|%s|%s\n' "${asn:-0}" "${as_name:-unknown}" "${cc:-??}"
}

# The CNAME chain a name is resolved through, one per line.
#
# A CDN is usually joined by pointing a CNAME at its zone, and that
# stays visible even when the edge address itself is announced by the
# customer's own AS. Empty when dig is unavailable, which is why this is
# one signal of three rather than the check.
reality_cname_chain() {
  local host="$1"
  command -v dig >/dev/null 2>&1 || return 0
  dig +short +time=3 +tries=2 "$host" CNAME 2>/dev/null
  # The A lookup prints the CNAMEs it walked through as well as the
  # addresses; keeping only the non-numeric lines leaves the chain.
  dig +short +time=3 +tries=2 "$host" A 2>/dev/null | grep -vE '^[0-9.]+$' || true
}

# The names a leaf certificate actually carries, for the message printed
# when it is not the name that was asked for. A mismatch is most legible
# next to what the host does claim to be.
reality_leaf_names() {
  local s_client_output="$1" leaf names=""
  leaf="$(awk '/BEGIN CERTIFICATE/{p=1} p{print} /END CERTIFICATE/{if (p) exit}' <<<"$s_client_output")"
  [[ -n "$leaf" ]] || return 0
  names="$(openssl x509 -noout -ext subjectAltName 2>/dev/null <<<"$leaf" | tail -n +2 | tr -d ' ' | sed 's/DNS://g')"
  [[ -z "$names" ]] && names="$(openssl x509 -noout -subject 2>/dev/null <<<"$leaf" || true)"
  printf '%s\n' "${names:0:200}"
}

# Roughly how large the TLS Certificate handshake message is, in bytes.
#
# The DER chain plus TLS 1.3's framing: 4 bytes of handshake header, 1
# for the (empty) certificate_request_context, 3 for the list length,
# and 3 + 2 per entry for its length and its extensions. Good to a
# handful of bytes, which is all that is needed against a ceiling of
# 8192.
reality_chain_bytes() {
  local s_client_output="$1" total=8 der=0 tmp count=0 f
  tmp="$(mktemp -d)" || return 0
  awk -v d="$tmp" '/BEGIN CERTIFICATE/{n++; p=1} p {print > (d "/cert" n ".pem")} /END CERTIFICATE/{p=0}' <<<"$s_client_output"
  for f in "$tmp"/cert*.pem; do
    [[ -e "$f" ]] || continue
    der="$(openssl x509 -in "$f" -outform DER 2>/dev/null | wc -c)"
    [[ "$der" -gt 0 ]] || continue
    total=$(( total + der + 5 ))
    count=$(( count + 1 ))
  done
  rm -rf "$tmp"
  [[ "$count" -gt 0 ]] || return 0
  printf '%s\n' "$total"
}

# Checks a candidate the way REALITY will actually use it.
#
# REALITY hands any connection that fails authentication straight to this
# host, so the disguise is only as good as this handshake -- and only as
# good as the *claim*, which is the part that used to go unchecked.
#
# What upstream requires of a dest: "websites out of China's GFW, support
# TLSv1.3 and H2, the domain name is not used for redirection".
# https://github.com/XTLS/REALITY/blob/main/README.en.md
# Its bonus list adds "target website IP reside closer to proxy IP (looks
# more reasonable, and lower latency)". Against a censor rather than a
# curious observer that is not a bonus at all -- it is the first thing a
# filter can check -- so criterion 1 here treats it as a requirement.
#
# The checks, and what each catches that the others do not:
#   * TLS 1.3, ALPN h2, X25519 -- the handshake REALITY forwards has to
#     look like the one the inbound advertises. This is what the probe
#     already did, and all it did.
#   * The certificate must be valid AND carry the name we intend to
#     claim. "Verify return code: 0" says the chain is trusted and
#     nothing about whose name is on it, so a host answering with
#     somebody else's perfectly valid certificate used to pass.
#   * Not CDN-fronted -- see the tables above. This is the ownership test
#     that was missing, and the reason www.asus.com kept passing for
#     months after it stopped being a usable decoy.
#   * Not a redirector, because upstream says so: a dest that answers /
#     with a 301 somewhere else produces traffic that does not look like
#     anyone browsing that site.
#   * A certificate chain small enough for REALITY to relay. The server
#     side breaks off the handshake when the Certificate message exceeds
#     8192 bytes and the customer sees only a connection reset:
#     https://github.com/XTLS/Xray-core/issues/6356
#
# Three outcomes rather than two, because "this will not work" and "this
# will work but it is a poor disguise" want different handling and the
# caller cannot tell them apart from a message:
#   0  usable; any advisory notes are printed
#   1  will not work at all -- unreachable, no TLS 1.3, no h2, wrong or
#      broken certificate, chain too large for REALITY to relay
#   2  works, but the disguise is weak: fronted by a CDN, announced from
#      a published range, or a redirector
# In every non-zero case it prints every reason it found, joined with
# "; ", so an operator can go and pick a better name instead of guessing
# which check bit.
probe_reality_dest() {
  local host="$1" port="${2:-443}"
  local out="" ip="" owner="" asn="" as_name="" cc="" chain="" headers=""
  local -a bad=() weak=() note=()

  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is not installed, so this could not be checked"
    return 1
  fi

  ip="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}')"
  if [[ -z "$ip" ]]; then
    echo "$host does not resolve from this server, so REALITY could never forward to it"
    return 1
  fi

  # Connected to the address just resolved, not to the name again.
  # Otherwise the ownership check and the handshake can land on two
  # different edges of the same CDN and disagree about what was tested.
  #
  # tr -d '\0' because s_client relays whatever the server sends and
  # command substitution warns on every NUL byte in it -- noise the
  # operator would read as an error. pipefail (set at the top of this
  # file) keeps openssl's own exit status as the pipeline's, so a failed
  # handshake is still a failed probe.
  #
  # -verify_hostname is the whole point of this line: without it openssl
  # checks that the chain is trusted and never that the name on it is
  # the name this node is about to claim.
  #
  # No -tls1_3: forcing it turns "only speaks TLS 1.2" into a bare
  # handshake failure, and the operator then cannot tell that from an
  # unreachable host. Let it negotiate and report what it chose.
  out="$(timeout 12 openssl s_client -connect "${ip}:${port}" -servername "$host" \
    -verify_hostname "$host" -alpn h2 -showcerts -status </dev/null 2>/dev/null | tr -d '\0')" || {
    echo "no TLS handshake from $ip -- this server cannot reach it, or nothing there speaks TLS"
    return 1
  }

  # openssl names the negotiated version in two places and does not
  # always print both. The "SSL-Session:" summary block -- the one
  # carrying "Protocol  : TLSv1.3" -- is absent on Ubuntu's OpenSSL
  # 3.0.13 when the peer closes the connection first, which is every
  # probe made here because stdin is /dev/null. The "New, TLSv1.3,
  # Cipher is ..." line is the one that is always there.
  #
  # Reading only the summary block made this check fail for *every*
  # dest on a node, with an empty version in the message. Measured on
  # france-1 (OpenSSL 3.0.13): www.free.fr, www.torob.com and even
  # cloudflare.com all came back "negotiated , and REALITY requires TLS
  # 1.3", and --self-test failed its own control case. A probe that
  # rejects everything is worse than no probe: it pushes the operator
  # into typing a weak dest past the warning, or into dropping REALITY
  # on that node entirely.
  local tls_ver=""
  if [[ "$out" =~ Protocol[[:space:]]*:[[:space:]]*(TLSv[0-9.]+) ]]; then
    tls_ver="${BASH_REMATCH[1]}"
  elif [[ "$out" =~ New,[[:space:]]*(TLSv[0-9.]+) ]]; then
    tls_ver="${BASH_REMATCH[1]}"
  fi
  [[ "$tls_ver" == "TLSv1.3" ]] ||
    bad+=("negotiated ${tls_ver:-nothing openssl would name a version}, and REALITY requires TLS 1.3")
  grep -q "ALPN protocol: h2" <<<"$out" ||
    bad+=("does not offer HTTP/2 over ALPN, so the inbound's h2 advertisement would not match what this dest answers")

  if grep -q "Verify return code: 0 (ok)" <<<"$out"; then
    :
  elif grep -qi "Hostname mismatch" <<<"$out"; then
    bad+=("serves a certificate that is not for $host (it names $(reality_leaf_names "$out")) -- REALITY would be claiming a name this host does not hold")
  else
    bad+=("certificate did not verify -- $(grep -m1 'Verify return code:' <<<"$out" | sed 's/^ *//'); intercepted, expired, or a broken chain")
  fi

  # Fronting, signal by signal. Any one is enough on its own: they are
  # three observations of the same fact, not a score to be totalled.
  chain="$(reality_cname_chain "$host" || true)"
  if [[ -n "$chain" ]] && grep -qEi "$REALITY_CDN_ZONE_RE" <<<"$chain"; then
    weak+=("resolves through $(grep -Eim1 "$REALITY_CDN_ZONE_RE" <<<"$chain" | sed 's/\.$//'), a CDN zone -- the name is fronted and $ip is not the site's own address")
  fi

  if owner="$(reality_ip_owner "$ip")"; then
    asn="${owner%%|*}"
    as_name="$(cut -d'|' -f2 <<<"$owner")"
    cc="${owner##*|}"
    if [[ "$REALITY_CDN_ASNS" == *" $asn "* ]] || grep -qEi "$REALITY_CDN_AS_NAME_RE" <<<"$as_name"; then
      weak+=("$ip is announced by AS$asn ($as_name), whose ranges are published -- 'SNI says $host, packet went to this node' is then one table lookup for a filter")
    else
      note+=("$ip is AS$asn ${as_name%, ??} in $cc")
    fi
  else
    note+=("could not look up who owns $ip, so criterion 1 is UNVERIFIED here -- install bind9-dnsutils and re-run")
  fi

  # What the site itself says on the way back. An edge that stamps its
  # own tracing header has identified itself more reliably than any
  # address list could.
  if command -v curl >/dev/null 2>&1; then
    headers="$(timeout 12 curl -4 -s -o /dev/null -D - --max-time 10 \
      --resolve "${host}:${port}:${ip}" "https://${host}:${port}/" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z' || true)"
    if [[ -n "$headers" ]] && grep -qE "$REALITY_CDN_HEADER_RE" <<<"$headers"; then
      weak+=("its responses carry '$(grep -oEm1 "$REALITY_CDN_HEADER_RE" <<<"$headers" | sed 's/ *$//')', a CDN edge header -- this name is served by a CDN, not by its own host")
    fi
    # Upstream's third requirement. www -> apex and apex -> www are the
    # documented exception, so only a hop to a different site counts.
    local status redir redir_host
    status="$(awk '/^http\/[0-9.]+ /{print $2}' <<<"$headers" | tail -1)"
    redir="$(awk '/^location:/{print $2}' <<<"$headers" | tail -1)"
    if [[ "$status" =~ ^30[12378]$ && -n "$redir" ]]; then
      redir_host="${redir#*://}"
      redir_host="${redir_host%%/*}"
      if [[ "${redir_host#www.}" != "${host#www.}" ]]; then
        weak+=("answers / with $status to $redir_host, and upstream requires a dest whose name is not used for redirection")
      fi
    fi
  fi

  # The 8192-byte ceiling. Estimated from the DER chain rather than read
  # off the wire, so the number is printed next to the verdict: a dest
  # sitting within a few bytes of the limit deserves a human's eye
  # rather than a silent pass or a silent rejection.
  local chain_bytes
  chain_bytes="$(reality_chain_bytes "$out")"
  if [[ -n "$chain_bytes" ]] && [[ "$chain_bytes" -gt 8192 ]]; then
    bad+=("its certificate chain is about $chain_bytes bytes, over the 8192 REALITY's server side will relay -- customers would see a bare connection reset (XTLS/Xray-core#6356)")
  elif [[ -n "$chain_bytes" ]] && [[ "$chain_bytes" -gt 7500 ]]; then
    note+=("certificate chain is ~$chain_bytes bytes, close to REALITY's 8192-byte ceiling")
  fi

  # Advisory, not fatal: a dest that negotiates something else still
  # works, it just gives REALITY less to hide behind. Reported only when
  # s_client actually printed the line -- not every build does, and
  # treating a missing line as a missing X25519 would flag every
  # candidate on those boxes.
  if grep -q "Server Temp Key" <<<"$out" && ! grep -qi "Server Temp Key: *X25519" <<<"$out"; then
    note+=("does not negotiate X25519")
  fi
  # A bonus point upstream names explicitly, and free to observe here.
  if grep -q "OCSP response: *no response sent" <<<"$out"; then
    note+=("no OCSP stapling")
  fi

  # A dest that cannot work is reported with the weak-disguise findings
  # alongside it -- an operator debugging one name wants everything that
  # is wrong with it in one pass, not one reason per attempt.
  local joined=""
  if [[ ${#bad[@]} -gt 0 ]]; then
    joined="$(printf '%s; ' "${bad[@]}" "${weak[@]}")"
    echo "${joined%; }"
    return 1
  fi
  if [[ ${#weak[@]} -gt 0 ]]; then
    joined="$(printf '%s; ' "${weak[@]}")"
    echo "${joined%; }"
    return 2
  fi
  if [[ ${#note[@]} -gt 0 ]]; then
    joined="$(printf '%s; ' "${note[@]}")"
    echo "${joined%; }"
  fi
  return 0
}

# Installs xray-core, generates a REALITY keypair, and writes a config
# with an empty client list -- users are hot-added/removed entirely
# through the agent's HandlerService calls (see
# agent/internal/protocols/xray), never by editing this file again.
install_xray() {
  echo "Installing Xray-core..."
  bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install

  # Menu option 5 runs this against nodes that are already serving
  # customers, which makes rotating the REALITY identity actively
  # destructive: the key and shortId are what every provisioned client
  # authenticates with, and the panel would still be handing out the old
  # ones. Nobody would connect, and nothing would say why. So an existing
  # identity is kept, and only a node with no Xray config generates one.
  local config_path="/usr/local/etc/xray/config.json"
  local reality_is_new="y"
  local private_key public_key="" short_id listen_port dest server_name
  local existing_key=""
  if [[ -f "$config_path" ]]; then
    existing_key="$(jq -r '.inbounds[]? | select(.tag=="vless-in") | .streamSettings.realitySettings.privateKey // empty' "$config_path" 2>/dev/null)"
  fi

  if [[ -n "$existing_key" ]]; then
    reality_is_new="n"
    private_key="$existing_key"
    local vless
    vless="$(jq -c '.inbounds[] | select(.tag=="vless-in")' "$config_path")"
    short_id="$(echo "$vless" | jq -r '.streamSettings.realitySettings.shortIds[0]')"
    listen_port="$(echo "$vless" | jq -r '.port')"
    dest="$(echo "$vless" | jq -r '.streamSettings.realitySettings.dest')"
    server_name="$(echo "$vless" | jq -r '.streamSettings.realitySettings.serverNames[0]')"
    echo
    echo "This node already runs VLESS+REALITY on port $listen_port, disguised as $server_name."
    echo "Keeping its existing keys -- rotating them would disconnect every customer"
    echo "provisioned here, since the panel would still be advertising the old ones."
  else
    local keys
    keys="$(/usr/local/bin/xray x25519)"
    private_key="$(echo "$keys" | grep '^PrivateKey:' | awk '{print $2}')"
    public_key="$(echo "$keys" | grep '(PublicKey):' | awk '{print $3}')"
    short_id="$(openssl rand -hex 8)"

    read -r -p "Listen port for VLESS+REALITY [443]: " listen_port
    listen_port="${listen_port:-443}"
    # REALITY presents this site's TLS identity to anyone inspecting the
    # connection, so it has to be a real HTTPS host that is (a) reachable
    # from this node -- the handshake is forwarded there, and a dest that
    # refuses this server's address disguises nothing -- (b) reachable
    # from where customers are, and (c) not something local security
    # software intercepts. Traffic to an intercepted domain fails with
    # "received real certificate", because the interceptor's certificate
    # arrives instead of the one REALITY expects. Found live:
    # www.microsoft.com is intercepted by security software on a real
    # user's machine and broke every connection until the domain was
    # changed.
    #
    # The fourth criterion is the one that used to be missing, and it is
    # the one an automated filter can act on cheapest: the name has to be
    # plausible *for this node's IP address*. cloudflare.com was the
    # default here, and Cloudflare publishes its address ranges -- so a
    # ClientHello claiming that name, sent to an address in nobody's CDN,
    # is a mismatch that costs a censor one table lookup and no
    # inspection whatsoever. A long-tail site hosted on ordinary
    # infrastructure in the same country as the node is a far harder
    # thing to check at scale than a household name.
    #
    # Whatever is chosen here must also be set as dest/serverName on the
    # Protocol Config -- the client takes its SNI from the panel, and a
    # mismatch fails exactly the same way as interception does. The
    # registration below does that automatically.
    echo
    echo "REALITY disguises this node's traffic as HTTPS to another site."
    echo "Three things make a good choice, in order of how cheaply a filter"
    echo "can catch a bad one:"
    echo "  1. Plausible for THIS node's IP. Prefer a site hosted in the same"
    echo "     country as this server, on its own or its host's addresses."
    echo "     A CDN-fronted name is a mismatch a filter checks at line rate,"
    echo "     so the check below rejects one and names the network it found."
    echo "  2. Not blocked where your customers are, and not blocking this"
    echo "     server -- the handshake is forwarded there on every probe."
    echo "  3. TLS 1.3, HTTP/2, and a certificate actually issued for the"
    echo "     name -- all verified below rather than assumed."
    echo
    echo "Checking a few candidates from this server (a few seconds each)..."
    local candidate reason first_ok="" first_weak=""
    local group_label
    for group_label in "hosted in Iran" "hosted abroad"; do
      echo "  -- $group_label --"
      local -a group
      if [[ "$group_label" == "hosted in Iran" ]]; then
        group=("${REALITY_DEST_CANDIDATES_IR[@]}")
      else
        group=("${REALITY_DEST_CANDIDATES_ABROAD[@]}")
      fi
      local probe_rc
      for candidate in "${group[@]}"; do
        reason="$(probe_reality_dest "$candidate" 443)" && probe_rc=0 || probe_rc=$?
        case "$probe_rc" in
          0)
            if [[ -n "$reason" ]]; then
              echo "     $candidate -- OK: $reason"
            else
              echo "     $candidate -- OK: TLS 1.3, h2, X25519, certificate for that name, not fronted"
            fi
            [[ -z "$first_ok" ]] && first_ok="$candidate"
            ;;
          2)
            # Offered, but never as the default: it would still carry
            # traffic, and it would still be the mismatch that gets a
            # node found.
            echo "     $candidate -- WEAK DISGUISE: $reason"
            [[ -z "$first_weak" ]] && first_weak="$candidate"
            ;;
          *)
            echo "     $candidate -- REJECTED: $reason"
            ;;
        esac
      done
    done
    echo
    echo "Pick the group that matches where THIS server is, not where your"
    echo "customers are. Anything you know to be a better fit beats this list."
    # No hardcoded fallback any more. It used to be www.speedtest.net,
    # which has resolved into Cloudflare for well over a year -- so the
    # one path that fired when nothing else worked was guaranteed to
    # produce the exact mismatch the rest of this function exists to
    # avoid, silently, on the node least able to afford it. If every
    # candidate was rejected the operator is told to bring their own
    # name instead of being handed a bad one.
    local dest_default=""
    if [[ -n "$first_ok" ]]; then
      dest_default="${first_ok}:443"
    else
      echo
      echo "None of the candidates above is usable from this server." >&2
      echo "Enter a name you know to be hosted near this node and not behind" >&2
      echo "a CDN -- it will be checked the same way before it is accepted." >&2
    fi
    # Bounded rather than `while true`: an install driven from a pipe
    # runs out of stdin, every `read` then returns immediately with an
    # empty answer, and an unbounded loop would spin forever printing
    # the same rejection. Three passes is enough for a human and
    # terminates for everything else.
    # The counter is deliberately never read: the loop bounds the number
    # of attempts, and nothing inside needs to know which attempt it is.
    # Named rather than `_` so the intent is legible at the loop head.
    local dest_attempt
    # The directive must sit immediately above the `for`, not above the
    # `local`: shellcheck reports the assignment at the loop head, and a
    # directive only applies to the command that follows it. Placed on
    # the `local` line it silences nothing and CI stays red.
    # shellcheck disable=SC2034
    for dest_attempt in 1 2 3; do
      read -r -p "Camouflage destination [$dest_default]: " dest || dest=""
      dest="${dest:-$dest_default}"
      server_name="${dest%%:*}"
      local dest_port="${dest##*:}"
      [[ "$dest_port" == "$dest" ]] && { dest_port="443"; dest="${server_name}:443"; }
      # Placeholder and reserved names are refused outright: they are not
      # a weaker disguise, they are an advertisement. example.com has no
      # traffic to blend into, and a bare IP or localhost is not a TLS
      # identity at all.
      case "${server_name,,}" in
        example.com|www.example.com|example.org|example.net|localhost|127.0.0.1|"")
          echo "  $server_name is a placeholder, not a disguise -- pick a real site." >&2
          dest=""
          continue
          ;;
        www.microsoft.com|microsoft.com)
          echo "  Endpoint security software intercepts this one, which breaks REALITY" >&2
          echo "  with 'received real certificate' on the customer's machine. See" >&2
          echo "  docs/detection-resistance.md. Pick something else." >&2
          dest=""
          continue
          ;;
      esac
      local chosen_rc
      reason="$(probe_reality_dest "$server_name" "$dest_port")" && chosen_rc=0 || chosen_rc=$?
      if [[ "$chosen_rc" == 0 ]]; then
        [[ -n "$reason" ]] && echo "  Note: $reason."
        break
      fi
      if [[ "$chosen_rc" == 2 ]]; then
        echo "  $server_name works, but it is a weak disguise: $reason." >&2
        echo "  It will carry traffic. It will also be what gets this node found." >&2
      else
        echo "  $server_name is not usable as a dest from this server: $reason." >&2
      fi
      read -r -p "  Use it anyway? [y/N]: " force_dest || force_dest=""
      [[ "${force_dest,,}" == "y" ]] && break
      # Cleared so the loop cannot fall out of its last iteration still
      # holding a name the operator just declined.
      dest=""
    done
    if [[ -z "$dest" ]]; then
      # Ranked, and never silently: a clean candidate first, then one
      # that only fails the ownership test, and only then a refusal.
      # Dropping REALITY here would take a transport away from the
      # customers who most need alternatives, so a weak disguise beats
      # no disguise -- but it is said out loud, and it is written where
      # a later re-run of this menu entry will show it again.
      if [[ -n "$dest_default" ]]; then
        echo "No camouflage destination was chosen; using $dest_default." >&2
        dest="$dest_default"
      elif [[ -n "$first_weak" ]]; then
        echo "No camouflage destination was chosen, and nothing passed cleanly." >&2
        echo "Falling back to $first_weak, which works but is CDN-fronted or" >&2
        echo "otherwise checkable at line rate. Re-run menu entry 5 with a" >&2
        echo "better name for this node's country when you have one." >&2
        dest="${first_weak}:443"
      else
        echo "No camouflage destination is usable from this server -- not one" >&2
        echo "candidate could even be reached over TLS. That is a network" >&2
        echo "problem before it is a disguise problem, so this step stops here" >&2
        echo "rather than writing a config around a name that does not answer." >&2
        echo "Nothing has been written yet; every protocol Xray would serve is" >&2
        echo "still unconfigured. Fix outbound HTTPS from this node, or supply" >&2
        echo "a reachable name, then re-run menu entry 5." >&2
        return 1
      fi
      server_name="${dest%%:*}"
    fi
  fi

  # The certificate-presenting stealth protocols: Trojan, and VLESS over
  # ordinary TLS. Both give REALITY's "looks like an HTTPS site" property
  # by presenting a real certificate for a real domain rather than
  # borrowing someone else's, so they share one certificate and one
  # fallback site and are set up together.
  #
  # Neither can share REALITY's port: REALITY intercepts the TLS
  # handshake and proxies anything failing its authentication to the site
  # it imitates, leaving no room behind it for another TLS service. With
  # one IPv4 that means further ports; with two, one of them can have 443.
  #
  # They also cannot share a port with each other -- each terminates its
  # own TLS -- so they get one each.
  local trojan_port="" vless_tls_port="" tls_cert="" tls_key="" trojan_fallback="" tls_domain=""
  local trojan_is_new="y" vless_tls_is_new="y"
  # The WebSocket carrier rides on the VLESS+TLS listener rather than
  # taking a port of its own -- see the fallback note in the template.
  # Loopback only, so the port never appears from outside.
  local vless_ws_path="" vless_ws_port="10086" vless_ws_is_new="y"
  # Shadowsocks 2022 stands alone: its own encryption, no certificate, no
  # dependency on the TLS block below. Offered separately for that reason
  # -- a node with no domain can still serve it.
  local ss_port="" ss_server_key="" ss_seed_key="" ss_is_new="y"

  # Same reasoning as the REALITY identity above: re-running this on a
  # node that already serves these must not ask for ports and a domain
  # again, and must not register a second Protocol Config for an inbound
  # the panel already knows about.
  if [[ -f "$config_path" ]]; then
    local existing
    existing="$(jq -c '.inbounds[]? | select(.tag=="trojan-in")' "$config_path" 2>/dev/null)"
    if [[ -n "$existing" ]]; then
      trojan_is_new="n"
      trojan_port="$(echo "$existing" | jq -r '.port')"
      tls_cert="$(echo "$existing" | jq -r '.streamSettings.tlsSettings.certificates[0].certificateFile')"
      tls_key="$(echo "$existing" | jq -r '.streamSettings.tlsSettings.certificates[0].keyFile')"
      trojan_fallback="$(echo "$existing" | jq -r '.settings.fallbacks[0].dest')"
      echo
      echo "Trojan over TLS is already configured on port $trojan_port -- keeping it."
    fi
    existing="$(jq -c '.inbounds[]? | select(.tag=="vless-tls-in")' "$config_path" 2>/dev/null)"
    if [[ -n "$existing" ]]; then
      vless_tls_is_new="n"
      vless_tls_port="$(echo "$existing" | jq -r '.port')"
      tls_cert="$(echo "$existing" | jq -r '.streamSettings.tlsSettings.certificates[0].certificateFile')"
      tls_key="$(echo "$existing" | jq -r '.streamSettings.tlsSettings.certificates[0].keyFile')"
      trojan_fallback="$(echo "$existing" | jq -r '.settings.fallbacks[0].dest')"
      echo
      echo "VLESS over TLS is already configured on port $vless_tls_port -- keeping it."
    fi
    existing="$(jq -c '.inbounds[]? | select(.tag=="shadowsocks-in")' "$config_path" 2>/dev/null)"
    if [[ -n "$existing" ]]; then
      ss_is_new="n"
      ss_port="$(echo "$existing" | jq -r '.port')"
      # Reused, never regenerated: the server key is half of every
      # credential already issued on this node, so minting a new one
      # would lock out every existing customer at once.
      ss_server_key="$(echo "$existing" | jq -r '.settings.password')"
      # Carried over too. Regenerating it would be harmless to customers
      # -- nobody holds it -- but a re-run should not churn the config.
      ss_seed_key="$(echo "$existing" | jq -r '.settings.clients[0].password // empty')"
      echo
      echo "Shadowsocks 2022 is already configured on port $ss_port -- keeping it."
    fi
    existing="$(jq -c '.inbounds[]? | select(.tag=="vless-ws-in")' "$config_path" 2>/dev/null)"
    if [[ -n "$existing" ]]; then
      vless_ws_is_new="n"
      vless_ws_port="$(echo "$existing" | jq -r '.port')"
      vless_ws_path="$(echo "$existing" | jq -r '.streamSettings.wsSettings.path')"
      echo
      echo "VLESS over WebSocket is already configured on path $vless_ws_path -- keeping it."
    fi
  fi

  local enable_tls_protocols="n"
  if [[ "$trojan_is_new" == "y" || "$vless_tls_is_new" == "y" ]]; then
    echo
    echo "Certificate-based stealth protocols (optional) add listeners that look"
    echo "like ordinary HTTPS sites. They need a domain already pointing here."
    # Defaults to yes, for the same reason the Trojan and Shadowsocks
    # port prompts below do. This gate is worse than either of those was:
    # it is the single question that decides VLESS+TLS, VLESS over
    # WebSocket *and* Trojan, so an operator holding Enter lost three
    # transports at once and nothing said so. That was fixed for the two
    # port prompts and missed here, which is why singapore-1 could be
    # brought up with a full-looking install and only two engines.
    read -r -p "Set them up? [Y/n]: " enable_tls_protocols
    enable_tls_protocols="${enable_tls_protocols:-y}"
  fi

  if [[ "${enable_tls_protocols,,}" == "y" ]]; then
    read -r -p "Domain for the certificate (e.g. fi1.example.com): " tls_domain
    if [[ -z "$tls_domain" ]]; then
      # Skipped rather than fatal. Returning 1 here aborted install_xray
      # outright, which on a fresh node left xray-core installed and
      # never configured -- REALITY included, so the answer to "no domain
      # yet" was a node serving nothing at all. Declining these three is
      # a smaller loss than that, and it is now said out loud.
      echo "  No domain given, so VLESS+TLS, VLESS over WebSocket and Trojan are being skipped." >&2
      echo "  Point a name at this node and re-run this menu entry to add them." >&2
      enable_tls_protocols="n"
    fi
  fi

  if [[ "${enable_tls_protocols,,}" == "y" ]]; then
    issue_tls_certificate "$tls_domain" || return 1
    # Not certbot's own paths: Xray runs as `nobody` and
    # /etc/letsencrypt/live is 0700 root, so pointing at it directly
    # makes Xray fail to start -- and because a bad certificate fails the
    # whole config, that takes the working VLESS inbound down with it.
    # Found exactly that way on a live node. install_cert_for_xray copies
    # to somewhere Xray can read; widening /etc/letsencrypt instead would
    # expose every key on the box to every process running as nobody.
    tls_cert="/usr/local/etc/xray/certs/fullchain.pem"
    tls_key="/usr/local/etc/xray/certs/privkey.pem"
    # Where a failed authentication goes. This is the disguise: a prober
    # who guesses wrong gets a real web server rather than a protocol
    # error, which is the whole difference between "an HTTPS site" and
    # "something hiding on a high port".
    trojan_fallback="127.0.0.1:8080"
    # The same site on a second socket, for connections that negotiated
    # HTTP/2. See ensure_fallback_site for why it cannot be one listener.
    trojan_fallback_h2="127.0.0.1:8081"
    ensure_fallback_site || return 1

    # VLESS+TLS is offered first because xray-core marks Trojan
    # deprecated on every config load and tells operators to move to
    # VLESS. Both are kept -- an existing Trojan deployment should not be
    # broken by that -- but a new node has no reason to prefer the one
    # upstream is walking away from.
    # 8443, 2053, 2083, 2087 and 2096 are the ports ordinary HTTPS
    # services already use, and for a listener whose disguise is "a web
    # server" the port is part of the disguise -- see
    # suggest_plausible_tls_port. None is as unblockable as 443, which
    # REALITY is holding. The suggestion is drawn at random from that set
    # rather than fixed at 2053, so nodes do not all answer TLS on the
    # same alternative port: that pattern is one scan away from being a
    # list of every node we run.
    if [[ "$vless_tls_is_new" == "y" ]]; then
      local vless_tls_suggested
      vless_tls_suggested="$(suggest_plausible_tls_port "")"
      vless_tls_suggested="${vless_tls_suggested:-2053}"
      read -r -p "Port for VLESS over TLS, or 'skip' [$vless_tls_suggested]: " vless_tls_port
      vless_tls_port="${vless_tls_port:-$vless_tls_suggested}"
      [[ "${vless_tls_port,,}" == "skip" ]] && vless_tls_port=""
    fi
    if [[ "$trojan_is_new" == "y" ]]; then
      local trojan_suggested
      trojan_suggested="$(suggest_plausible_tls_port "${vless_tls_port:-}")"
      [[ -n "$trojan_suggested" ]] && echo "  $trojan_suggested is free here and is an ordinary HTTPS port."
      # Defaults to installing it, like every other engine in this
      # sequence. It used to default to 'skip', so an operator who
      # pressed Enter through the install got a node with two fewer
      # transports and nothing anywhere said so -- and a transport that
      # was never installed is one a filtered customer cannot fall back
      # to. Skipping is still one word away; it just has to be chosen
      # now rather than obtained by not reading.
      if [[ -n "$trojan_suggested" ]]; then
        read -r -p "Port for Trojan over TLS, or 'skip' [$trojan_suggested]: " trojan_port
        trojan_port="${trojan_port:-$trojan_suggested}"
      else
        echo "  No free plausible HTTPS port was found here, so this one has to be named by hand."
        read -r -p "Port for Trojan over TLS, or 'skip' [skip]: " trojan_port
        trojan_port="${trojan_port:-skip}"
      fi
      [[ "${trojan_port,,}" == "skip" ]] && trojan_port=""
    fi

    if [[ -n "$vless_tls_port" && "$vless_tls_port" == "$trojan_port" ]]; then
      echo "VLESS and Trojan cannot share a port -- each terminates its own TLS." >&2
      return 1
    fi

    # Offered only alongside a VLESS+TLS listener, because it is carried
    # by one: the upgrade arrives on that port, under that certificate,
    # and is routed here by path. Without it there is nothing to attach
    # to.
    if [[ -n "$vless_tls_port" && "$vless_ws_is_new" == "y" ]]; then
      echo
      echo "VLESS over WebSocket (optional) shares the port and certificate above."
      echo "On the wire it is an HTTP upgrade to a long-lived connection -- what"
      echo "ordinary web apps do -- which survives some filtering that plain TLS"
      echo "does not. No extra port is opened."
      # Generated rather than defaulted to /ws. The path is the only
      # thing separating the tunnel from the static page on the same
      # port, and /ws is the default in every tutorial ever written --
      # so it is the first string an active prober sends, and a node
      # that upgrades it has answered the question. The clients read
      # this from the panel and never assume it, so a random path costs
      # nothing (verified in apps/desktop-windows src-tauri/src/vpn.rs
      # and apps/mobile/src/lib/xray-config.ts: both take
      # publicParams.path).
      local ws_suggested
      ws_suggested="$(suggest_ws_path)"
      echo "A random path is suggested: /ws is what a prober tries first."
      read -r -p "Path for the WebSocket, or 'skip' [$ws_suggested]: " vless_ws_path
      vless_ws_path="${vless_ws_path:-$ws_suggested}"
      if [[ "${vless_ws_path,,}" == "skip" ]]; then
        vless_ws_path=""
      elif [[ "$vless_ws_path" != /* ]]; then
        # Xray matches the request path literally, so a path without a
        # leading slash silently matches nothing and the fallback quietly
        # never fires.
        vless_ws_path="/$vless_ws_path"
      fi
    fi
  fi

  # Asked outside the certificate block above on purpose: Shadowsocks
  # brings its own encryption, so it needs no domain and no certificate,
  # and a node that declined those can still offer it.
  if [[ "$ss_is_new" == "y" ]]; then
    echo
    echo "Shadowsocks 2022 (optional) looks like random bytes on the wire -- no"
    echo "TLS handshake to fingerprint, and no certificate needed. Useful where"
    echo "the certificate-based ports above are blocked. Pick an unremarkable"
    echo "high port; the well-known 8388 is the first thing a scanner tries."
    local ss_suggested
    ss_suggested="$(suggest_free_port)"
    echo "  $ss_suggested is free on this box if you want one picked for you."
    # Installed by default, for the same reason as Trojan above -- and
    # more so: this is the transport that survives where the
    # certificate-based ports do not, so it is the last one that should
    # be dropped by an operator who simply held Enter.
    if [[ -n "$ss_suggested" ]]; then
      read -r -p "Port for Shadowsocks 2022, or 'skip' [$ss_suggested]: " ss_port
      ss_port="${ss_port:-$ss_suggested}"
    else
      read -r -p "Port for Shadowsocks 2022, or 'skip' [skip]: " ss_port
      ss_port="${ss_port:-skip}"
    fi
    if [[ "${ss_port,,}" == "skip" ]]; then
      ss_port=""
    else
      # 32 bytes, standard base64. Both are fixed by the cipher:
      # blake3-aes-256-gcm derives from exactly 32 bytes, and xray decodes
      # it with StdEncoding, so a base64url key fails to parse at startup.
      ss_server_key="$(openssl rand -base64 32)"
      # A second, throwaway key for the seed client the template carries.
      # It is never issued to anyone and authenticates nobody -- its only
      # job is to make the inbound non-empty, because xray-core picks the
      # single-user Shadowsocks server for an empty client list and that
      # one is not a UserManager. With it empty, every add-user RPC is
      # refused and no customer can be provisioned at all.
      ss_seed_key="$(openssl rand -base64 32)"
    fi
  fi

  local template="$SCRIPT_DIR/assets/xray-config.json.template"
  # Worded for the role, not for two of the protocols it affects. The old
  # wording named WireGuard/OpenVPN only, which reads as "no" to anyone
  # building an Xray-entry relay -- and that is the common case, since
  # REALITY is the transport an Iran relay is actually reached on. ir1
  # was installed that way on 2026-08-13 and could not carry a route.
  # The base template now carries RoutingService so that answer is no
  # longer fatal, but the question should still be answerable correctly.
  echo "A RELAY node is one customers connect to so it can forward them on to an exit node elsewhere (typically an Iran-reachable box fronting servers abroad). This is about the node's role -- answer yes for any relay, whichever protocol customers arrive on."
  read -r -p "Is this a RELAY node? [y/N]: " is_relay
  if [[ "${is_relay,,}" == "y" ]]; then
    template="$SCRIPT_DIR/assets/xray-relay-config.json.template"
    echo "Using the relay config variant (adds a dormant tun bridge -- see docs/architecture.md, \"Multi-Hop Relay Chaining\"). Routes are wired up from the panel/API, not here."
  fi

  sed \
    -e "s/__LISTEN_PORT__/$listen_port/g" \
    -e "s/__DEST__/$dest/g" \
    -e "s/__SERVER_NAME__/$server_name/g" \
    -e "s/__REALITY_PRIVATE_KEY__/$private_key/g" \
    -e "s/__SHORT_ID__/$short_id/g" \
    -e "s/__TROJAN_PORT__/${trojan_port:-0}/g" \
    -e "s/__VLESS_TLS_PORT__/${vless_tls_port:-0}/g" \
    -e "s#__TLS_CERT_PATH__#${tls_cert:-/dev/null}#g" \
    -e "s#__TLS_KEY_PATH__#${tls_key:-/dev/null}#g" \
    -e "s/__TROJAN_FALLBACK__/${trojan_fallback:-127.0.0.1:8080}/g" \
    -e "s/__TROJAN_FALLBACK_H2__/${trojan_fallback_h2:-127.0.0.1:8081}/g" \
    -e "s/__VLESS_WS_PORT__/${vless_ws_port:-10086}/g" \
    -e "s#__VLESS_WS_DEST__#127.0.0.1:${vless_ws_port:-10086}#g" \
    -e "s#__VLESS_WS_PATH__#${vless_ws_path:-/ws}#g" \
    -e "s/__SHADOWSOCKS_PORT__/${ss_port:-0}/g" \
    -e "s#__SHADOWSOCKS_SERVER_KEY__#${ss_server_key:-placeholder}#g" \
    -e "s#__SHADOWSOCKS_SEED_KEY__#${ss_seed_key:-placeholder}#g" \
    "$template" > /usr/local/etc/xray/config.json

  # A declined Trojan inbound is removed rather than left listening on
  # port 0 with a /dev/null certificate. Xray refuses to start when a
  # configured certificate is unreadable, and that would take the whole
  # node down -- including the VLESS inbound that was working perfectly.
  local unused_tags=""
  [[ -z "$trojan_port" ]] && unused_tags="trojan-in"
  [[ -z "$vless_tls_port" ]] && unused_tags="$unused_tags vless-tls-in"
  # A declined WebSocket has to take its fallback with it. An inbound
  # removed on its own would leave the TLS listeners routing that path to
  # a port nothing is listening on -- so the disguise site would answer
  # every request except that one, which is a stranger fingerprint than
  # simply not offering it.
  [[ -z "$vless_ws_path" ]] && unused_tags="$unused_tags vless-ws-in"
  # A declined Shadowsocks inbound is removed rather than left listening
  # on port 0 with a placeholder key -- xray refuses to start on a key it
  # cannot decode to the cipher's length, and that would take the whole
  # node down over an inbound the operator said no to.
  [[ -z "$ss_port" ]] && unused_tags="$unused_tags shadowsocks-in"
  if [[ -n "${unused_tags// /}" ]]; then
    UNUSED_INBOUND_TAGS="$unused_tags" python3 - <<'PY' || echo "warning: could not remove the unused TLS inbounds -- edit /usr/local/etc/xray/config.json by hand" >&2
import json
import os

drop = set(os.environ["UNUSED_INBOUND_TAGS"].split())
path = "/usr/local/etc/xray/config.json"
with open(path) as handle:
    config = json.load(handle)
config["inbounds"] = [i for i in config["inbounds"] if i.get("tag") not in drop]

# The WebSocket fallback goes with its inbound. It is the only
# path-keyed fallback in either template, so matching on the presence of
# a path is exact and stays correct if the port ever changes.
if "vless-ws-in" in drop:
    for inbound in config["inbounds"]:
        fallbacks = inbound.get("settings", {}).get("fallbacks")
        if fallbacks:
            inbound["settings"]["fallbacks"] = [f for f in fallbacks if not f.get("path")]

with open(path, "w") as handle:
    json.dump(config, handle, indent=2)
PY
  fi

  # Both templates set "access": "none", so in normal operation nothing
  # is written here at all and this rule matches nothing -- `missingok`
  # covers that. It stays for the case it is now sized for: an operator
  # turning the access log on to debug something and forgetting it.
  #
  # `rotate 1` rather than the 7 this used to keep. The old setting held
  # eight days of customer IP + destination + user tag on every node,
  # which is the thing the templates now refuse to create; leaving a
  # week's retention configured would quietly restore it the moment
  # anyone flipped the log back on. One day is enough to read a log you
  # are actively watching, and is a poor archive by design.
  # Owned by the user Xray runs as, not root. 750 alone looks like a
  # sensible tightening and is a node that will not boot: with access
  # logging on, Xray opens this file at startup and a root-owned 750
  # directory refuses it, so the daemon exits with "failed to initialize
  # access logger ... permission denied" and every protocol on the node
  # is down. Cost the live fleet a minute of downtime on 2026-08-17,
  # because the mode was tightened while logging happened to be off and
  # the breakage stayed invisible until it was turned back on.
  install -d -m 750 -o "${XRAY_RUN_USER:-nobody}" -g "${XRAY_RUN_GROUP:-nogroup}" /var/log/xray
  cat > /etc/logrotate.d/xray <<'EOF'
/var/log/xray/*.log {
  daily
  rotate 1
  compress
  missingok
  notifempty
  copytruncate
}
EOF

  systemctl restart xray

  local config_id params
  if [[ "$reality_is_new" == "y" ]]; then
    echo "Registering Xray in the panel..."
    params="$(jq -n --arg pk "$public_key" --arg sid "$short_id" --arg dest "$dest" --arg sn "$server_name" \
      '{realityPublicKey: $pk, shortIds: [$sid], dest: $dest, serverName: $sn}')"
    config_id="$(register_protocol_config "XRAY_VLESS_REALITY" "$listen_port" "$params" \
      '{"transport": "TCP", "security": "REALITY"}')" || return 1
    echo "  Registered (config $config_id)."
    create_route_for_config "Xray VLESS+REALITY" "$config_id"
  else
    echo "VLESS+REALITY is already registered in the panel -- left untouched."
  fi

  # An inbound the panel does not know about is an inbound no customer can
  # ever be provisioned on: the whole node-side setup succeeds, Trojan
  # listens, and nothing can use it. This step was missing, which is why
  # the first Trojan node had to have its Protocol Config created by hand.
  if [[ -n "$trojan_port" && "$trojan_is_new" == "y" ]]; then
    echo "Registering Trojan in the panel..."
    # serverName is the whole reason this needs registering rather than
    # being inferred: the client verifies the certificate against it and
    # sends it as SNI. Given the node's IP instead, the name never matches
    # the certificate and the handshake fails.
    params="$(jq -n --arg sn "$tls_domain" '{serverName: $sn}')"
    config_id="$(register_protocol_config "XRAY_TROJAN" "$trojan_port" "$params" \
      '{"transport": "TCP", "security": "TLS"}')" || return 1
    echo "  Registered (config $config_id)."
    create_route_for_config "Xray Trojan (TLS)" "$config_id"
  fi

  if [[ -n "$vless_tls_port" && "$vless_tls_is_new" == "y" ]]; then
    echo "Registering VLESS+TLS in the panel..."
    params="$(jq -n --arg sn "$tls_domain" '{serverName: $sn}')"
    config_id="$(register_protocol_config "XRAY_VLESS_TLS" "$vless_tls_port" "$params" \
      '{"transport": "TCP", "security": "TLS"}')" || return 1
    echo "  Registered (config $config_id)."
    create_route_for_config "Xray VLESS+TLS" "$config_id"
  fi

  # Registered as the same protocol on the same public port as the TCP
  # config above, distinguished only by transport and path. That is not a
  # duplicate: the client builds a different stream from it, the agent
  # provisions it on a different inbound, and a customer can fail over
  # between the two when one shape is filtered and the other is not.
  if [[ -n "$vless_ws_path" && "$vless_ws_is_new" == "y" ]]; then
    echo "Registering VLESS over WebSocket in the panel..."
    # path travels with serverName because the client needs both: the
    # name for SNI and certificate verification, the path for the upgrade
    # request. A WebSocket to the right host on the wrong path is refused
    # by the fallback and looks exactly like a broken credential.
    params="$(jq -n --arg sn "$tls_domain" --arg p "$vless_ws_path" '{serverName: $sn, path: $p}')"
    config_id="$(register_protocol_config "XRAY_VLESS_TLS" "$vless_tls_port" "$params" \
      '{"transport": "WS", "security": "TLS"}')" || return 1
    echo "  Registered (config $config_id)."
    create_route_for_config "Xray VLESS+TLS (WebSocket)" "$config_id"
  fi

  if [[ -n "$ss_port" && "$ss_is_new" == "y" ]]; then
    echo "Registering Shadowsocks 2022 in the panel..."
    # The server key travels to clients because Shadowsocks 2022
    # authenticates with it and the customer's own key together -- half
    # each. It identifies the listener; the per-user key is what
    # identifies the customer and what gets revoked.
    params="$(jq -n --arg k "$ss_server_key" '{method: "2022-blake3-aes-256-gcm", serverKey: $k}')"
    config_id="$(register_protocol_config "SHADOWSOCKS" "$ss_port" "$params" \
      '{"transport": "TCP", "security": "NONE"}')" || return 1
    echo "  Registered (config $config_id)."
    create_route_for_config "Shadowsocks 2022" "$config_id"
  fi

  echo "Xray is running on port $listen_port and is ready to use."
  # Same warning the panel installer ends with, for the same reason: a
  # cloud firewall permitting only 22/80/443 leaves these listeners
  # perfectly healthy and completely unreachable, and the customer-facing
  # symptom is "the server does not work" with nothing in any log here.
  echo "  If your provider has a cloud firewall, open inbound TCP $listen_port${vless_tls_port:+, $vless_tls_port}${trojan_port:+, $trojan_port}${ss_port:+, $ss_port} on it -- this script cannot."
  [[ -n "$vless_tls_port" ]] && echo "VLESS over TLS is running on port $vless_tls_port."
  [[ -n "$vless_ws_path" ]] && echo "VLESS over WebSocket shares port $vless_tls_port on path $vless_ws_path."
  [[ -n "$trojan_port" ]] && echo "Trojan over TLS is running on port $trojan_port."
  return 0
}

# VPS providers use varying primary interface names (eth0/ens3/enX0/...)
# so the NAT rule below can't hardcode one -- ask the routing table what
# it would actually use to reach the internet.
detect_default_iface() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") print $(i+1)}' | head -n1
}

# Without this, a WireGuard/OpenVPN client tunnel completes its
# handshake but every packet past it is silently dropped -- the node
# never forwards or NATs it out to the real internet. Idempotent, safe
# to call on every install/re-run.
enable_ip_forwarding() {
  echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-neoxify-forwarding.conf
  sysctl --system >/dev/null
}

# Installs wireguard-tools, generates a server keypair, and brings up
# wg0 with an empty peer list -- same "never re-templated for users"
# pattern as install_xray: peers are hot-added/removed entirely through
# the agent's `wg set` calls (see agent/internal/protocols/wireguard).
# A free, unremarkable high port to suggest as a default.
#
# 51820 and 1194 announce what they are. A scanner, or an ISP looking for
# VPN traffic, finds them by port alone before inspecting a single byte,
# and some networks drop them on that basis. Drawing one per node per
# protocol removes that free signal, and means a blocked port costs one
# protocol on one node rather than that protocol everywhere.
#
# This deliberately does not apply to REALITY, VLESS+TLS or Trojan: for
# those the port *is* the disguise. TLS on 443 is indistinguishable from
# browsing, while a TLS handshake on a random high port is itself the
# anomaly. Nor to IKEv2, which has no say in the matter -- the protocol
# fixes 500 and 4500 and neither platform client can be told otherwise.
#
# Still only a suggestion: the operator can type anything, including the
# old default, because a node rebuilt to match an existing panel entry
# has to be able to.
suggest_free_port() {
  local port
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port=$(( 20000 + RANDOM % 40000 ))
    # Skip anything already listening, TCP or UDP -- offering a port the
    # box is already using turns into an engine that starts, binds
    # nothing, and reports no error anyone reads.
    if ! ss -lntu 2>/dev/null | awk '{print $5}' | grep -q ":${port}\$"; then
      echo "$port"
      return 0
    fi
  done
  # Ten collisions in a 40000-wide range means ss is not telling us
  # anything useful. Better to return the last draw than to loop.
  echo "$port"
}

# A free port from the set ordinary HTTPS services already answer on.
#
# The opposite consideration to suggest_free_port, and the reason both
# exist. For a listener whose entire disguise is "this is a web server",
# the port is part of the disguise: TLS on 2087 is unremarkable --
# Cloudflare publishes 2053/2083/2087/2096 as alternative HTTPS ports and
# plenty of ordinary sites answer on them -- while the identical
# handshake on 46731 is an anomaly before a single byte is inspected. For
# Shadowsocks and the UDP engines the reasoning inverts, because they
# have no "normal service" story to tell on any port; there the only win
# is not sitting on the protocol's well-known one.
#
# Shuffled rather than ordered, because every Neoxify node answering TLS
# on 2053 is a set a censor enumerates with one scan. Diversity across
# nodes is worth as much here as the choice of port itself.
#
# Prints nothing if all of them are taken -- the caller decides whether
# that is fatal or just means falling back to its own default.
suggest_plausible_tls_port() {
  local taken="${1:-}"
  local ports=(8443 2053 2083 2087 2096)
  local i j tmp
  for (( i = ${#ports[@]} - 1; i > 0; i-- )); do
    j=$(( RANDOM % (i + 1) ))
    tmp="${ports[i]}"
    ports[i]="${ports[j]}"
    ports[j]="$tmp"
  done
  local port
  for port in "${ports[@]}"; do
    [[ "$port" == "$taken" ]] && continue
    if ! ss -lntu 2>/dev/null | awk '{print $5}' | grep -q ":${port}\$"; then
      echo "$port"
      return 0
    fi
  done
  echo ""
}

# A WebSocket path no scanner already has on a list.
#
# /ws is the default in every v2ray/xray tutorial ever written, which
# makes it the first thing an active prober sends -- and a node that
# upgrades /ws to a WebSocket while answering every other path with a
# static page has identified itself. A per-node random path costs
# nothing (the client reads it from the panel, never assumes it) and
# turns "probe one path" into "probe the whole URL space".
#
# The prefix is cosmetic: it makes the path look like a real
# application's endpoint rather than a random blob, for the case where
# someone is reading a log rather than matching a string.
suggest_ws_path() {
  local prefixes=(assets static media live cdn api/v2)
  local prefix="${prefixes[RANDOM % ${#prefixes[@]}]}"
  printf '/%s/%s\n' "$prefix" "$(openssl rand -hex 6)"
}

# NATs a VPN client subnet out this node's own uplink -- and deliberately
# does nothing on a relay.
#
# On an ordinary node this rule is the whole point: without it the tunnel
# comes up and carries nothing, which shipped once already for both
# WireGuard and OpenVPN.
#
# On a relay it is a trapdoor. The client's traffic is meant to leave at
# the EXIT node, reached through relay-tun, and is NATed there; this rule
# is never the intended path. It is reachable only when the policy route
# into relay-tun is missing -- the window after a reboot before the agent
# re-asserts routes, or indefinitely if the panel is unreachable and it
# never does. In that window the rule silently turns the relay into a
# direct exit: an Iranian customer's traffic egresses in Iran, from the
# censored network they bought this to leave, while the app still shows
# the exit's location. Nothing reports it, because from every counter's
# point of view the tunnel is working.
#
# Without the rule the same failure is a tunnel that carries nothing --
# visible, honest, and recoverable. That is the trade this makes.
#
# Measured on ir1, 2026-08-16: the policy rules live only in the running
# kernel and are re-added by the agent on CONFIGURE_ROUTE, so the gap is
# real rather than theoretical.
masquerade_client_subnet() {
  local subnet="$1" iface="$2"

  if [[ "${node_is_relay:-n}" == "y" ]]; then
    echo "  Relay node: not NATing $subnet out $iface -- this traffic must exit at the exit node."
    return 0
  fi

  iptables -t nat -C POSTROUTING -s "$subnet" -o "$iface" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s "$subnet" -o "$iface" -j MASQUERADE
}

install_wireguard() {
  echo "Installing WireGuard..."
  apt-get install -y -qq wireguard wireguard-tools

  install -d -m 700 /etc/wireguard
  ( umask 077 && wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key )
  local private_key public_key
  private_key="$(cat /etc/wireguard/server_private.key)"
  public_key="$(cat /etc/wireguard/server_public.key)"

  local suggested_port
  suggested_port="$(suggest_free_port)"
  echo "  A random high port is suggested rather than 51820, which identifies"
  echo "  WireGuard to anyone scanning. Any port works; the clients read it"
  echo "  from the panel rather than assuming."
  read -r -p "Listen port for WireGuard [$suggested_port]: " listen_port
  listen_port="${listen_port:-$suggested_port}"
  read -r -p "Client subnet, /24 only (e.g. 10.66.0.0/24) [10.66.0.0/24]: " subnet
  subnet="${subnet:-10.66.0.0/24}"
  local subnet_base="${subnet%.0/24}"
  local server_ip="${subnet_base}.1"
  read -r -p "DNS to hand out to clients [1.1.1.1]: " dns
  dns="${dns:-1.1.1.1}"
  read -r -p "Public endpoint host (this node's IP or DNS name) [$(curl -fsSL https://api.ipify.org || true)]: " endpoint_host
  endpoint_host="${endpoint_host:-$(curl -fsSL https://api.ipify.org || true)}"

  apt-get install -y -qq iptables
  local default_iface
  default_iface="$(detect_default_iface)"
  if [[ -z "$default_iface" ]]; then
    echo "ERROR: could not detect the default outbound network interface -- required so client traffic can actually reach the internet." >&2
    exit 1
  fi
  enable_ip_forwarding

  # PostUp/PostDown re-run on every wg-quick@wg0 start/stop (including
  # every boot, since the unit is enabled below) -- the -C/-D idempotent
  # check-then-add avoids duplicate rules piling up across restarts.
  # The NAT hooks are omitted entirely on a relay -- see
  # masquerade_client_subnet for why a relay must not be able to fall
  # back to egressing in its own country. wg-quick's PostUp is the one
  # place this cannot go through that helper, since the rule has to be
  # re-applied by the unit on every boot rather than added once here.
  local wg_nat_hooks=""
  if [[ "${node_is_relay:-n}" == "y" ]]; then
    echo "  Relay node: wg0 will not NAT ${subnet} -- this traffic must exit at the exit node."
  else
    wg_nat_hooks="PostUp = iptables -t nat -C POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE 2>/dev/null || true"
  fi

  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = ${server_ip}/24
ListenPort = ${listen_port}
PrivateKey = ${private_key}
${wg_nat_hooks}
EOF
  chmod 600 /etc/wireguard/wg0.conf

  systemctl enable --now wg-quick@wg0
  systemctl restart wg-quick@wg0

  echo "Registering WireGuard in the panel..."
  local config_id params
  params="$(jq -n --arg pk "$public_key" --arg ep "${endpoint_host}:${listen_port}" --arg subnet "$subnet" --arg dns "$dns" \
    '{serverPublicKey: $pk, endpoint: $ep, subnetCidr: $subnet, dns: $dns}')"
  # On a relay, the client cannot reach this UDP port at all (see
  # setup_phantun), so it is fronted with TCP and the registered params
  # have to say so -- otherwise the app builds a config pointing at a
  # port that will never answer.
  local phantun_tcp_port=""
  if [[ "${node_is_relay:-n}" == "y" ]]; then
    phantun_tcp_port="$(suggest_free_port)"
    setup_phantun "wireguard" "$listen_port" "$phantun_tcp_port" "192.168.201.0/24" "192.168.201.2"
    if systemctl is-active --quiet neoxify-phantun@wireguard; then
      params="$(echo "$params" | jq --argjson port "$phantun_tcp_port" --arg host "$endpoint_host"         '. + {phantunTcpEndpoint: ($host + ":" + ($port|tostring))}')"
    fi
  fi

  config_id="$(register_protocol_config "WIREGUARD" "$listen_port" "$params")" || return 1
  echo "  Registered (config $config_id)."
  create_route_for_config "WireGuard" "$config_id"

  echo "WireGuard is running on port $listen_port and is ready to use."
}

# Fronts a UDP engine with phantun so it survives a network that drops
# the protocol outright.
#
# Measured on the Iran relay, 2026-08-14: a real WireGuard handshake sent
# from Germany left the client and never arrived, while TCP from the same
# host to the same node arrived fine. Raw WireGuard and OpenVPN simply
# cannot reach an Iran node -- and no amount of node-side configuration
# changes that, because the packets die in transit. phantun wraps the UDP
# in synthesised TCP, which does get through: verified end to end, real
# handshake, and an exit IP matching the relay's exit node.
#
# Relay nodes only. Elsewhere the UDP arrives unmolested and this would
# be a second daemon and a second port for no benefit.
setup_phantun() {
    local instance="$1" udp_port="$2" tcp_port="$3" tun_subnet="$4" tun_peer="$5"

    if [[ ! -x /usr/local/bin/phantun_server ]]; then
        echo "Installing phantun..."
        local url
        url="$(curl -fsSL https://api.github.com/repos/dndx/phantun/releases/latest \
            | grep -oE 'https://[^"]*x86_64-unknown-linux-musl[^"]*\.zip' | head -1)"
        if [[ -z "$url" ]]; then
            echo "WARNING: could not find a phantun release to download -- skipping." >&2
            echo "  WireGuard/OpenVPN will not be reachable from a network that filters them." >&2
            return 0
        fi
        command -v unzip >/dev/null 2>&1 || apt-get install -y -qq unzip
        local tmp
        tmp="$(mktemp -d)"
        curl -fsSL -o "$tmp/ph.zip" "$url" || { echo "WARNING: phantun download failed." >&2; rm -rf "$tmp"; return 0; }
        unzip -o -q "$tmp/ph.zip" -d "$tmp"
        install -m 755 "$tmp/phantun_server" /usr/local/bin/phantun_server
        rm -rf "$tmp"
    fi

    install -d -m 755 /etc/neoxify
    cat > "/etc/neoxify/phantun-$instance.env" <<ENV
TCP_PORT=$tcp_port
UDP_PORT=$udp_port
TUN_SUBNET=$tun_subnet
TUN_PEER=$tun_peer
ENV
    install -m 755 "$SCRIPT_DIR/assets/neoxify-phantun-nat" /usr/local/bin/neoxify-phantun-nat
    install -m 644 "$SCRIPT_DIR/assets/neoxify-phantun@.service" /etc/systemd/system/neoxify-phantun@.service
    systemctl daemon-reload
    systemctl enable --now "neoxify-phantun@$instance" >/dev/null 2>&1

    if systemctl is-active --quiet "neoxify-phantun@$instance"; then
        echo "  phantun is fronting $instance on TCP $tcp_port (clients dial TCP, not UDP $udp_port)."
        echo "  If your provider has a cloud firewall, open inbound TCP $tcp_port on it -- this script cannot."
    else
        echo "WARNING: phantun failed to start for $instance -- check journalctl -u neoxify-phantun@$instance" >&2
    fi
}

# Prompts for panel admin credentials and exchanges them for a fresh
# access token, including the MFA-enabled case -- needed because
# OpenVPN's Protocol Config creation (unlike Xray/WireGuard, which set
# themselves up node-locally) requires calling the backend's admin API
# to generate the CA (see openvpn-pki.ts). Bash has no string return,
# so callers do: token="$(get_admin_bearer_token)" -- which is exactly
# why the cache below is a file rather than a variable.
get_admin_bearer_token() {
  # Cached in a file, not a variable.
  #
  # A shell variable cannot work here and quietly did not: every caller
  # uses `token="$(get_admin_bearer_token)"`, and command substitution
  # runs the function in a subshell, so the assignment meant to cache
  # the token was discarded the moment it returned. The result was a
  # fresh login per protocol -- which registering a full node exceeds,
  # since admin login is throttled to five attempts a minute. A real
  # install died with HTTP 429 partway through, having already asked for
  # the same password four times.
  #
  # 0600 and removed on exit. It holds a 15-minute access token, which
  # deserves no less care than the password that produced it.
  # An already-minted token, for a run that cannot answer prompts.
  #
  # The credential prompts sit in the *middle* of the engine flow, not at
  # the start, so a scripted install that feeds answers on stdin has to
  # predict exactly where they land. Two real installs died that way: one
  # had the admin email swallowed by a port prompt, and the node ended up
  # registered with a garbage listen port. Supplying the token instead
  # removes the two prompts whose position is hardest to predict, and it
  # keeps the password out of any answer file.
  if [[ -n "${NEOXIFY_ADMIN_TOKEN:-}" ]]; then
    echo "$NEOXIFY_ADMIN_TOKEN"
    return 0
  fi

  if [[ -s "$ADMIN_TOKEN_CACHE" ]]; then
    cat "$ADMIN_TOKEN_CACHE"
    return 0
  fi

  local email password login_response access_token
  read -r -p "Panel admin email: " email
  read -r -s -p "Panel admin password: " password
  echo >&2

  login_response="$(curl -fsSL -X POST "$panel_url/auth/login" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg email "$email" --arg password "$password" '{email: $email, password: $password}')")"

  if [[ "$(echo "$login_response" | jq -r '.mfaRequired // false')" == "true" ]]; then
    local mfa_token code mfa_response
    mfa_token="$(echo "$login_response" | jq -r '.mfaToken')"
    read -r -p "This admin account has MFA enabled -- enter a current 6-digit code: " code
    mfa_response="$(curl -fsSL -X POST "$panel_url/auth/mfa/verify" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg mfaToken "$mfa_token" --arg code "$code" '{mfaToken: $mfaToken, code: $code}')")"
    access_token="$(echo "$mfa_response" | jq -r '.accessToken // empty')"
  else
    access_token="$(echo "$login_response" | jq -r '.accessToken // empty')"
  fi

  if [[ -z "$access_token" ]]; then
    echo "ERROR: admin login failed -- check the email/password (and code, if MFA is enabled)." >&2
    return 1
  fi
  # Created empty, locked down, and only then written to. Writing first
  # and chmod-ing after would leave the token world-readable for the
  # instant in between, and relying on umask alone assumes an inherited
  # value this script does not set.
  : > "$ADMIN_TOKEN_CACHE"
  chmod 600 "$ADMIN_TOKEN_CACHE"
  printf '%s' "$access_token" > "$ADMIN_TOKEN_CACHE"
  echo "$access_token"
}

# Registers a Protocol Config in the panel and echoes its id.
#
# This replaces printing the values and asking an admin to retype them
# into a JSON textarea. That transcription step was the single biggest
# source of broken setups: the installer already knows every value, and a
# node whose params were mistyped or skipped looked completely fine until
# a customer failed to connect. Everything below is the same data the
# installer used to print -- it just delivers it itself now.
register_protocol_config() {
  local protocol="$1" listen_port="$2" params_json="$3"
  # Extra top-level fields (transport/security), as a JSON object. These
  # are real columns rather than publicParamsJson entries, so they cannot
  # be smuggled in through the params argument.
  local extra_json="${4:-{\}}"
  local token response config_id

  token="$(get_admin_bearer_token)" || return 1

  response="$(curl -sSL -X POST "$panel_url/protocol-configs" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$(jq -n --arg nodeId "$node_id" --arg protocol "$protocol" \
      --argjson listenPort "$listen_port" --argjson params "$params_json" \
      --argjson extra "$extra_json" \
      '{nodeId: $nodeId, protocol: $protocol, listenPort: $listenPort, publicParamsJson: $params} + $extra')")"

  config_id="$(echo "$response" | jq -r '.id // empty')"
  if [[ -z "$config_id" ]]; then
    echo "ERROR: could not register the $protocol Protocol Config in the panel." >&2
    echo "  Response: $(echo "$response" | jq -r '.message // .' 2>/dev/null || echo "$response")" >&2
    return 1
  fi

  echo "$config_id"
}

# Creates a Route so the newly-registered engine is actually reachable by
# customers. Without one, a Protocol Config exists but nothing can be
# provisioned on it -- the panel has no "default route" concept, so this
# was previously a third manual step after the node and the config.
#
# Direct routes are the common case. Relayed routes (client -> Iran relay
# -> abroad exit) are offered here too, because the exit side is just one
# more Xray user and the installer is the point where someone actually
# knows which node this one is meant to relay through.
# This node's name, however this function was reached.
#
# `node_name` is only ever set by the full-install flow, which prompts
# for it. Entering through "Add/Remove Protocol Engine" on an
# already-enrolled node never sets it, and `set -u` then killed the
# install immediately after the protocol had been registered -- so the
# engine existed, the config existed, and the route silently did not.
#
# agent.json records the node id but not the name, so the name is
# fetched from the panel: it is the authoritative copy, and it is
# already correct for a node that enrolled.
resolve_node_name() {
  if [[ -n "${node_name:-}" ]]; then
    echo "$node_name"
    return 0
  fi

  local id token name
  id="$(jq -r '.nodeId // empty' /etc/neoxify/agent.json 2>/dev/null || true)"
  if [[ -z "$id" ]]; then
    echo "node"
    return 0
  fi

  token="$(get_admin_bearer_token)" || return 1
  name="$(curl -fsSL "$panel_url/nodes/$id" -H "Authorization: Bearer $token" 2>/dev/null     | jq -r '.name // empty' || true)"
  echo "${name:-node}"
}

create_route_for_config() {
  local protocol="$1" config_id="$2"
  local token response route_id node_label

  token="$(get_admin_bearer_token)" || return 1
  node_label="$(resolve_node_name)" || return 1

  local exit_config_id=""
  if [[ "${node_is_relay:-n}" == "y" ]]; then
    exit_config_id="$(choose_exit_protocol_config)" || return 1
  fi

  local route_name="$node_label / $protocol"
  local payload
  if [[ -n "$exit_config_id" ]]; then
    payload="$(jq -n --arg name "$route_name" --arg entry "$config_id" --arg exit "$exit_config_id" \
      '{name: $name, entryProtocolConfigId: $entry, exitProtocolConfigId: $exit}')"
  else
    payload="$(jq -n --arg name "$route_name" --arg entry "$config_id" \
      '{name: $name, entryProtocolConfigId: $entry}')"
  fi

  response="$(curl -sSL -X POST "$panel_url/routes" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$payload")"

  route_id="$(echo "$response" | jq -r '.id // empty')"
  if [[ -z "$route_id" ]]; then
    echo "WARNING: registered the $protocol engine, but could not create its Route." >&2
    echo "  Response: $(echo "$response" | jq -r '.message // .' 2>/dev/null || echo "$response")" >&2
    echo "  The engine is installed and registered -- add a Route in the panel to make it selectable." >&2
    return 0
  fi

  if [[ -n "$exit_config_id" ]]; then
    echo "  Route created (relayed via the exit node you chose)."
  else
    echo "  Route created (direct)."
  fi
}

# Lists Xray configs on nodes that can act as an exit -- EXIT or
# STANDALONE, matching what RoutesService actually accepts since
# 2026-08-13 -- and asks which one this relay should
# forward to. Cached after the first answer so a node installing three
# engines is asked once, not once per engine.
choose_exit_protocol_config() {
  if [[ -n "${chosen_exit_config_id:-}" ]]; then
    echo "$chosen_exit_config_id"
    return 0
  fi

  local token nodes configs candidates count choice
  token="$(get_admin_bearer_token)" || return 1

  nodes="$(curl -sSL "$panel_url/nodes" -H "Authorization: Bearer $token")"
  configs="$(curl -sSL "$panel_url/protocol-configs" -H "Authorization: Bearer $token")"

  # The relay->exit hop is always Xray-based by design (see the
  # Multi-Hop Relay Chaining section in docs/architecture.md), so only
  # XRAY_VLESS_REALITY configs on EXIT-role nodes are valid targets.
  candidates="$(jq -n --argjson nodes "$nodes" --argjson configs "$configs" '
    [ $configs[]
      | select(.protocol == "XRAY_VLESS_REALITY")
      | . as $c
      | ($nodes[] | select(.id == $c.nodeId and (.role == "EXIT" or .role == "STANDALONE"))) as $n
      | {id: $c.id, label: ($n.name + " (" + $n.region + ") port " + ($c.listenPort|tostring))}
    ]')"

  count="$(echo "$candidates" | jq 'length')"
  if [[ "$count" == "0" ]]; then
    echo "ERROR: no Xray engine was found on a node this relay could forward to." >&2
    echo "  An exit must be an EXIT or STANDALONE node running Xray VLESS+REALITY." >&2
    echo "  (STANDALONE counts: it already terminates traffic and egresses to the" >&2
    echo "   internet, which is exactly what an exit does. Only another RELAY is" >&2
    echo "   refused -- chaining relays either loops or adds a hop with no exit.)" >&2
    return 1
  fi

  echo >&2
  echo "Which exit node should this relay forward to?" >&2
  echo "$candidates" | jq -r 'to_entries[] | "  \(.key + 1)) \(.value.label)"' >&2
  read -r -p "Choice [1]: " choice
  choice="${choice:-1}"

  chosen_exit_config_id="$(echo "$candidates" | jq -r --argjson i "$((choice - 1))" '.[$i].id // empty')"
  if [[ -z "$chosen_exit_config_id" ]]; then
    echo "ERROR: '$choice' isn't one of the listed options." >&2
    return 1
  fi
  echo "$chosen_exit_config_id"
}

# Installs openvpn, then CREATES its Protocol Config via the panel's
# admin API (which is what generates the CA/server cert -- the reverse
# direction from install_xray/install_wireguard, which generate their
# own server secrets node-locally and only register the public half).
# OpenVPN's per-client cert issuance needs a CA that can sign new certs
# on every purchase, and that CA has to live wherever client certs get
# signed, i.e. the backend (see
# apps/backend/src/modules/protocol-configs/openvpn-pki.ts). Fully
# self-service: prompts for engine params + an admin login (needed
# only for this one API call), same shape as install_xray/
# install_wireguard's own prompts -- no separate manual panel/curl step
# required first.
# IKEv2/IPsec via strongSwan.
#
# The only protocol here with no client-side component: Windows and
# Android both dial IKEv2 with the operating system's own VPN client, so
# nothing ships in the app and -- after two Go runtimes in one Android
# process turned out to segfault it -- no third native engine either.
#
# The cost is that the client is not ours, which fixes two things:
#
#   * UDP 500 and 4500, always. Neither built-in client offers a way to
#     say otherwise, so IKEv2 sits out the randomised-port work.
#   * Customers must connect by hostname. The server presents a real
#     certificate and Windows refuses one whose name does not match what
#     was typed, so a node offering IKEv2 needs a DNS name, not just an
#     address.
#
# Both are reasons to keep IKEv2 away from the stealth protocols: fixed
# ports and a handshake in the clear make it the easiest thing here to
# fingerprint, and a censor that blocks the address rather than the port
# takes everything sharing it down too.
install_ikev2() {
  echo "Installing IKEv2 (strongSwan)..."

  local hostname_default hostname_input listen_pool
  hostname_default="$(hostname -f 2>/dev/null || true)"
  read -r -p "DNS name clients will connect to (must resolve to this node) [$hostname_default]: " hostname_input
  hostname_input="${hostname_input:-$hostname_default}"
  if [[ -z "$hostname_input" ]]; then
    echo "  IKEv2 needs a DNS name: the certificate is issued for it and Windows checks it." >&2
    return 1
  fi
  if ! getent hosts "$hostname_input" >/dev/null 2>&1; then
    echo "  $hostname_input does not resolve. Point it at this node first --" >&2
    echo "  certbot cannot issue a certificate for a name that does not answer." >&2
    return 1
  fi

  # libcharon-extra-plugins is not optional despite the name: it is what
  # provides eap-mschapv2. Without it the connection loads cleanly and
  # every authentication fails, which is a confusing way to discover a
  # missing package.
  apt-get install -y -qq strongswan strongswan-swanctl libcharon-extra-plugins certbot

  echo "  Obtaining a certificate for $hostname_input..."
  # Standalone binds port 80 for the challenge. A node has no web server
  # of its own, so nothing is displaced; the panel installer uses the
  # nginx plugin instead because there something would be.
  # RSA, explicitly, and not as a preference. certbot has issued ECDSA
  # by default since 2.0, and Android's IKE library refuses an
  # ECDSA-signed AUTH payload outright:
  #
  #   AuthenticationFailedException: Unrecognized ASN.1 objects for
  #   Signature algorithm and Hash
  #
  # It gets there having accepted the whole certificate chain and
  # negotiated everything else, then drops the session and retries
  # forever -- so the customer sees a connection that never completes
  # and nothing anywhere names a certificate. Windows is unaffected; it
  # accepts ECDSA P-256. That asymmetry is what makes this easy to ship
  # broken, because the desktop client works and only Android fails.
  #
  # Observed against sg1 from the emulator on 2026-08-11. Reissuing as
  # RSA fixed it on the very next attempt with nothing else changed.
  # Standalone binds port 80 itself, which is fine on a bare node and
  # not fine here. A node that serves Trojan or VLESS over TLS has nginx
  # on port 80 by the time this runs -- once because installing nginx
  # enabled Ubuntu's default vhost by accident, now because
  # ensure_port80_site puts a deliberate one there -- so standalone fails
  # with an address-in-use that reads like a firewall problem.
  #
  # Webroot serves the challenge through whatever already holds the port
  # instead, with no restart and no window where the fallback site is
  # down. Standalone stays as the fallback for a node that genuinely has
  # nothing on 80.
  # --cert-name, and not for tidiness: Xray's TLS step has usually
  # already issued a certificate for this same name, and certbot's
  # default is ECDSA. Asking for RSA here -- which this must, since
  # Android refuses an ECDSA server certificate for IKEv2 -- is a key
  # type change, and certbot refuses that non-interactively unless the
  # certificate is named explicitly:
  #
  #   "Are you trying to change the key type of the certificate named
  #    <node hostname> from ECDSA to RSA? Please provide both
  #    --cert-name and --key-type on the command line"
  #
  # (Node hostname redacted from the quoted message -- see
  # docs/node-address-hygiene.md.)
  #
  # Without it, IKEv2 fails on every node that also serves Xray over TLS
  # for the same hostname -- which is every node installed with the full
  # protocol set. Reproduced on germany-1 on 2026-08-19: it enrolled with
  # seven working protocols and no IKEv2, and the message printed was
  # about inbound port 80, which was fine throughout.
  #
  # The certificate becomes RSA for both users. Xray takes either;
  # IKEv2 does not.
  local acme_ok="n"
  if [[ -d /var/www/html ]] && ss -tlnp 2>/dev/null | grep -qE "[^0-9]:80\b"; then
    echo "  Something already serves port 80; using the webroot challenge."
    if certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos \
        --cert-name "$hostname_input" --key-type rsa --rsa-key-size 2048 \
        --register-unsafely-without-email -d "$hostname_input" >/dev/null 2>&1; then
      acme_ok="y"
    fi
  fi
  if [[ "$acme_ok" != "y" ]]; then
    if certbot certonly --standalone --non-interactive --agree-tos \
        --cert-name "$hostname_input" --key-type rsa --rsa-key-size 2048 \
        --register-unsafely-without-email -d "$hostname_input" >/dev/null 2>&1; then
      acme_ok="y"
    fi
  fi
  if [[ "$acme_ok" != "y" ]]; then
    echo "  certbot could not issue a certificate for $hostname_input." >&2
    echo "  Check inbound TCP 80 reaches this node, including any cloud firewall," >&2
    echo "  and that whatever holds port 80 serves /var/www/html." >&2
    return 1
  fi

  # strongSwan reads its own tree, not Let's Encrypt's.
  install -d -m 755 /etc/swanctl/x509 /etc/swanctl/x509ca /etc/swanctl/conf.d
  install -d -m 700 /etc/swanctl/private
  cp "/etc/letsencrypt/live/$hostname_input/cert.pem" /etc/swanctl/x509/node.pem
  cp "/etc/letsencrypt/live/$hostname_input/privkey.pem" /etc/swanctl/private/node.key
  chmod 600 /etc/swanctl/private/node.key

  # One certificate per file, and this is what makes Windows work at all.
  # strongSwan reads only the first certificate out of a concatenated
  # file, so copying chain.pem whole gave it the leaf and one
  # intermediate -- two short of the path Windows needs to reach a root
  # it trusts, since Let's Encrypt now chains through Root YE and ISRG
  # Root X2 before X1. Windows then silently discarded the IKE_AUTH
  # response and retransmitted its own request until the SA timed out,
  # reporting "the connection was terminated by the remote computer",
  # which points at the server rather than at the chain. Found by
  # reading charon's log next to a real dial; nothing on the client said
  # anything about certificates.
  rm -f /etc/swanctl/x509ca/neoxify-ca*.pem
  awk 'BEGIN{n=0} /BEGIN CERT/{n++} {print > ("/etc/swanctl/x509ca/neoxify-ca" n ".pem")}'       "/etc/letsencrypt/live/$hostname_input/chain.pem"
  chmod 644 /etc/swanctl/x509ca/neoxify-ca*.pem

  # Windows fragments its own IKE messages at roughly 576 bytes and
  # ignores larger ones coming back. With charon's 1280-byte default the
  # certificate chain arrived in pieces Windows would not reassemble.
  cat > /etc/strongswan.d/neoxify-fragment.conf <<'FRAG'
# Managed by the Neoxify agent installer.
#
# Note the directory: files under strongswan.d/charon/ are already
# inside the charon section, so a charon { } wrapper there becomes
# charon.charon and is silently ignored. This belongs one level up.
charon {
    fragment_size = 540
}
FRAG

  # Renewal must refresh swanctl's copies too, or ninety days from now
  # the node serves an expired certificate and every client refuses it.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  {
    echo "#!/bin/sh"
    echo "# Installed by the Neoxify agent installer."
    echo "set -e"
    echo "cp /etc/letsencrypt/live/$hostname_input/cert.pem /etc/swanctl/x509/node.pem"
    echo "cp /etc/letsencrypt/live/$hostname_input/privkey.pem /etc/swanctl/private/node.key"
    echo "chmod 600 /etc/swanctl/private/node.key"
    # Split on renewal too. Restoring a single chain.pem here would undo
    # the fix above sixty days later, which is the worst possible time
    # to discover it.
    echo "rm -f /etc/swanctl/x509ca/neoxify-ca*.pem"
    echo "awk 'BEGIN{n=0} /BEGIN CERT/{n++} {print > (\"/etc/swanctl/x509ca/neoxify-ca\" n \".pem\")}' /etc/letsencrypt/live/$hostname_input/chain.pem"
    echo "chmod 644 /etc/swanctl/x509ca/neoxify-ca*.pem"
    echo "swanctl --load-creds --clear >/dev/null 2>&1 || true"
  } > /etc/letsencrypt/renewal-hooks/deploy/neoxify-ikev2.sh
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/neoxify-ikev2.sh

  # Run it once here rather than trusting it. A hook is only exercised
  # sixty days after install, so a wrong path in it is invisible until
  # the certificate expires and every client fails at the same moment --
  # by which time nobody is looking at the installer. Running it now
  # makes a bad path fail here, where the cause is obvious. It is a copy
  # of files that were just copied, so there is nothing to undo.
  if ! /etc/letsencrypt/renewal-hooks/deploy/neoxify-ikev2.sh; then
    echo "  The certificate renewal hook does not work; IKEv2 would break in ninety days." >&2
    return 1
  fi

  listen_pool="10.68.0.0/24"
  cat > /etc/swanctl/conf.d/neoxify.conf <<CONF
# Managed by the Neoxify agent installer.
connections {
    neoxify-ikev2 {
        version = 2
        proposals = aes256gcm16-prfsha384-ecp384, aes256-sha256-modp2048, default
        rekey_time = 0s
        pools = neoxify-pool
        local_addrs = %any
        remote_addrs = %any
        send_cert = always
        local {
            auth = pubkey
            certs = node.pem
            id = $hostname_input
        }
        remote {
            auth = eap-mschapv2
            eap_id = %any
        }
        children {
            neoxify-ikev2 {
                local_ts = 0.0.0.0/0, ::/0
                rekey_time = 0s
                dpd_action = clear
                esp_proposals = aes256gcm16-ecp384, aes256-sha256, default
            }
        }
    }
}
pools {
    neoxify-pool {
        addrs = $listen_pool
        dns = 1.1.1.1, 8.8.8.8
    }
}
CONF

  # The agent owns this file from here on and rewrites it wholesale as
  # customers come and go. Created empty rather than left absent so
  # swanctl has something to load before the first customer exists.
  if [[ ! -f /etc/swanctl/conf.d/neoxify-users.conf ]]; then
    printf 'secrets {\n}\n' > /etc/swanctl/conf.d/neoxify-users.conf
  fi
  chmod 600 /etc/swanctl/conf.d/neoxify-users.conf

  # Forwarding and NAT, or the tunnel comes up and carries nothing. That
  # fault shipped once already for WireGuard and OpenVPN: handshake fine,
  # no internet, and nothing in any log to say why. Uplink detected
  # rather than assumed to be eth0, since providers differ.
  local uplink
  uplink="$(ip route show default | awk '{print $5; exit}')"
  if [[ -z "$uplink" ]]; then
    echo "  Could not determine this node's default interface; skipping NAT." >&2
  else
    printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-neoxify-ikev2.conf
    sysctl -q -p /etc/sysctl.d/99-neoxify-ikev2.conf
    masquerade_client_subnet "$listen_pool" "$uplink"
    iptables -C FORWARD -s "$listen_pool" -j ACCEPT 2>/dev/null || iptables -I FORWARD -s "$listen_pool" -j ACCEPT
    iptables -C FORWARD -d "$listen_pool" -j ACCEPT 2>/dev/null || iptables -I FORWARD -d "$listen_pool" -j ACCEPT
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    netfilter-persistent save >/dev/null 2>&1 || true
  fi

  systemctl enable --now strongswan >/dev/null 2>&1 || \
    systemctl enable --now strongswan-starter >/dev/null 2>&1 || true

  # Load the swanctl config at every boot, not only this one.
  #
  # Ubuntu 24.04 ships strongswan-starter, which reads the legacy
  # ipsec.conf and knows nothing about the swanctl configuration this
  # node actually uses. Without this the daemon comes back after a
  # reboot listening on 500 and 4500 and accepting nobody. Found when
  # the Singapore node was rebooted by its provider and came back with
  # zero connections loaded -- which presents as "IKEv2 randomly stopped
  # working", with the daemon running and the ports open.
  cat > /etc/systemd/system/neoxify-swanctl-load.service <<UNIT
[Unit]
Description=Load Neoxify swanctl connections and credentials
After=strongswan-starter.service
Requires=strongswan-starter.service
# PartOf, so restarting the daemon by hand reloads this too. Without it
# the unit only runs at boot, and "systemctl restart strongswan-starter"
# during maintenance leaves the daemon up with no connections, no pool
# and no EAP secrets -- every client then authenticates against nothing.
# Cost an hour on france-1 before it was noticed.
PartOf=strongswan-starter.service

[Service]
Type=oneshot
RemainAfterExit=yes
# The unit reports started before its VICI socket is necessarily ready.
ExecStartPre=/bin/sh -c "for i in 1 2 3 4 5 6 7 8 9 10; do swanctl --stats >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0"
ExecStart=/usr/sbin/swanctl --load-all

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable neoxify-swanctl-load >/dev/null 2>&1 || true

  if ! swanctl --load-all >/dev/null 2>&1; then
    echo "  strongSwan refused the configuration; swanctl --load-all shows why." >&2
    return 1
  fi

  local config_id params
  params="$(jq -n --arg host "$hostname_input" --arg pool "$listen_pool" \
    '{endpointHost: $host, pool: $pool, auth: "eap-mschapv2"}')"
  # 500 is what the panel records. 4500 is used as well, the moment NAT
  # is detected, but one column holds one number and every connection
  # starts on 500.
  config_id="$(register_protocol_config "IKEV2" 500 "$params")" || return 1
  create_route_for_config "IKEv2" "$config_id"

  echo
  echo "  IKEv2 is listening on UDP 500 and 4500."
  echo "  Clients must connect to $hostname_input rather than this node's IP:"
  echo "  the certificate names the host and Windows checks it."
  echo "  If your provider has a cloud firewall, open inbound UDP 500 and 4500"
  echo "  on it -- this script cannot."
}

install_openvpn() {
  echo "Installing OpenVPN..."
  apt-get install -y -qq openvpn

  local suggested_port
  suggested_port="$(suggest_free_port)"
  echo "  A random high port is suggested rather than 1194, which identifies"
  echo "  OpenVPN to anyone scanning. Any port works; the clients read it"
  echo "  from the panel rather than assuming."
  read -r -p "Listen port for OpenVPN [$suggested_port]: " listen_port
  listen_port="${listen_port:-$suggested_port}"
  read -r -p "Protocol, udp or tcp [udp]: " proto
  proto="${proto:-udp}"
  read -r -p "Public endpoint host (this node's IP or DNS name) [$(curl -fsSL https://api.ipify.org || true)]: " endpoint_host
  endpoint_host="${endpoint_host:-$(curl -fsSL https://api.ipify.org || true)}"

  echo
  echo "Registering OpenVPN in the panel (this is also what generates its CA)..."
  local token config_json
  token="$(get_admin_bearer_token)" || return 1

  # The tunnel subnet, matching the `server 10.77.0.0 255.255.255.0` line
  # in the server config written above. It has to reach the panel: a
  # relayed OpenVPN route is wired by scoping the Xray routing rule to the
  # client subnet, because unlike the Xray protocols there is no inbound
  # tag to match on. Without it, route creation fails with "missing
  # subnetCidr" and the engine ends up installed, registered, and
  # unroutable -- which is exactly what happened on ir1, 2026-08-14.
  local ovpn_subnet="10.77.0.0/24"

  config_json="$(curl -sSL -X POST "$panel_url/protocol-configs" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$(jq -n --arg nodeId "$node_id" --argjson listenPort "$listen_port" --arg proto "$proto" --arg endpoint "$endpoint_host:$listen_port" --arg subnet "$ovpn_subnet" \
      '{nodeId: $nodeId, protocol: "OPENVPN", listenPort: $listenPort, publicParamsJson: {proto: $proto, endpoint: $endpoint, subnetCidr: $subnet}}')")"

  local ca_cert server_cert server_key config_id
  config_id="$(echo "$config_json" | jq -r '.id // empty')"
  ca_cert="$(echo "$config_json" | jq -r '.publicParamsJson.caCertPem // empty')"
  server_cert="$(echo "$config_json" | jq -r '.publicParamsJson.serverCertPem // empty')"
  server_key="$(echo "$config_json" | jq -r '.publicParamsJson.serverKeyPem // empty')"

  if [[ -z "$ca_cert" ]]; then
    echo "ERROR: could not register the OpenVPN Protocol Config." >&2
    echo "  Response: $(echo "$config_json" | jq -r '.message // .' 2>/dev/null || echo "$config_json")" >&2
    exit 1
  fi
  echo "  Registered (config $config_id)."
  create_route_for_config "OpenVPN" "$config_id"

  install -d -m 755 /etc/openvpn/server /etc/openvpn/ccd
  printf '%s' "$ca_cert" > /etc/openvpn/server/ca.crt
  printf '%s' "$server_cert" > /etc/openvpn/server/server.crt
  printf '%s' "$server_key" > /etc/openvpn/server/server.key
  chmod 600 /etc/openvpn/server/server.key

  openvpn --genkey secret /etc/openvpn/server/tls-crypt.key

  # tls-crypt encrypts and authenticates the whole TLS control channel,
  # so a client without this exact key is not rejected -- it is silently
  # ignored, and the connection simply never completes. It therefore has
  # to reach clients, which means registering it alongside the rest of
  # this engine's parameters rather than leaving it node-local like the
  # WireGuard/Xray server secrets.
  local tls_crypt_key
  tls_crypt_key="$(cat /etc/openvpn/server/tls-crypt.key)"
  local update_payload
  update_payload="$(jq -n --arg k "$tls_crypt_key" --arg proto "$proto" --arg endpoint "$endpoint_host:$listen_port" \
    '{publicParamsJson: {proto: $proto, endpoint: $endpoint, tlsCryptKey: $k}}')"
  if ! curl -sSL -X PATCH "$panel_url/protocol-configs/$config_id" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$update_payload" | jq -e '.id' >/dev/null; then
    echo "WARNING: could not attach the tls-crypt key to this OpenVPN config -- clients will connect to a server that ignores them." >&2
  fi

  # -dsaparam trades a little cryptographic conservatism for a
  # dramatically faster generation (under a second vs. minutes) --
  # acceptable here since these DH params only protect a supplementary
  # key-exchange step behind the cert-based TLS handshake, not identity.
  openssl dhparam -dsaparam -out /etc/openvpn/server/dh.pem 2048

  local mgmt_port=7505
  cat > /etc/openvpn/server/server.conf <<EOF
port ${listen_port}
proto ${proto}
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
tls-crypt tls-crypt.key
topology subnet
server 10.77.0.0 255.255.255.0
client-config-dir /etc/openvpn/ccd
# Without these the client builds a working tunnel and then sends
# everything except 10.77.0.0/24 out its normal interface -- it reports
# connected, and the user's public IP never changes. Found in live
# testing: WireGuard changed the IP, OpenVPN didn't, and this was why.
# redirect-gateway is a server-pushed directive, so it belongs here
# rather than in the client config the app generates.
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
keepalive 10 60
cipher AES-256-GCM
persist-key
persist-tun
management 127.0.0.1 ${mgmt_port}
status /var/log/openvpn-status.log
verb 3
EOF

  systemctl enable --now openvpn-server@server
  systemctl restart openvpn-server@server

  apt-get install -y -qq iptables
  local default_iface  # ovpn_subnet is set above, at registration
  default_iface="$(detect_default_iface)"
  if [[ -z "$default_iface" ]]; then
    echo "ERROR: could not detect the default outbound network interface -- required so client traffic can actually reach the internet." >&2
    exit 1
  fi
  enable_ip_forwarding
  masquerade_client_subnet "$ovpn_subnet" "$default_iface"
  # OpenVPN's systemd unit has no PostUp/PostDown-style hook the way
  # wg-quick does, so the rule above needs to be persisted separately to
  # survive a reboot -- iptables-persistent's own systemd unit restores
  # /etc/iptables/rules.v4 on every boot.
  apt-get install -y -qq iptables-persistent
  netfilter-persistent save

  cat <<EOF

OpenVPN is running on port $listen_port/$proto. The agent's management
interface / ccd settings default to 127.0.0.1:${mgmt_port} and
/etc/openvpn/ccd, matching this config -- no extra agentd flags needed
unless you changed those defaults above.

EOF
}

action_update_agent() {
  require_root
  detect_os
  echo "Updating agent binary only (protocol engines are left running so"
  echo "active sessions on this node are not disrupted)..."
  # fetch_agent_binary keeps the outgoing binary and refuses to hand back
  # a build that does not report the release it was asked for, so by the
  # time this returns the restart is on something checked. Anything it
  # rejects exits before here rather than restarting the service.
  fetch_agent_binary
  systemctl restart neoxify-agentd
  echo "Agent updated and restarted."
  echo
  echo "If this build misbehaves, roll back to one of these:"
  local kept
  mapfile -t kept < <(find "$AGENT_ROLLBACK_DIR" -maxdepth 1 -type f -name 'agentd-*' ! -name '*.sha256' -printf '  %f\n' 2>/dev/null | sort)
  if [[ ${#kept[@]} -gt 0 ]]; then
    printf '%s\n' "${kept[@]}"
  else
    echo "  (none -- this node had no previous binary to keep)"
  fi
  echo "  install -m 755 $AGENT_ROLLBACK_DIR/<one of the above> /usr/local/bin/agentd"
  echo "  systemctl restart neoxify-agentd"
}

action_status_agent() {
  systemctl status neoxify-agentd --no-pager || true
  echo
  echo "Recent logs (Ctrl+C to exit follow mode):"
  journalctl -u neoxify-agentd -n 50 --no-pager
}

action_reenroll_agent() {
  require_root
  read -r -p "New panel URL: " panel_url
  read -r -p "New enrollment token (from that panel's Nodes -> Add Node): " enroll_token
  /usr/local/bin/agentd --enroll-init --panel-url "$panel_url" --token "$enroll_token"
  systemctl restart neoxify-agentd
}

action_engines_agent() {
  require_root
  # install_openvpn needs panel_url/node_id (see action_install_agent,
  # where they're normally set) -- this menu entry runs standalone,
  # after enrollment already happened in an earlier run, so read them
  # back from the agent's own persisted config instead. Xray/WireGuard
  # don't need either (fully node-local), so this was never hit until
  # OpenVPN's install became self-service.
  local panel_url node_id
  panel_url="$(jq -r '.panelUrl' /etc/neoxify/agent.json)"
  node_id="$(jq -r '.nodeId' /etc/neoxify/agent.json)"

  cat <<'EOF'

  1) Install/reconfigure Xray (VLESS+REALITY)
  2) Install/reconfigure WireGuard
  3) Install/reconfigure OpenVPN
  4) Install/reconfigure IKEv2 (strongSwan)
  5) Back

EOF
  read -r -p "Choose [1-5]: " choice
  case "$choice" in
    1) install_xray ;;
    2) install_wireguard ;;
    3) install_openvpn ;;
    4) install_ikev2 ;;
    *) return ;;
  esac
}

action_uninstall_agent() {
  require_root
  read -r -p "Remove config/certs too, not just the agent binary? [y/N]: " purge
  systemctl stop neoxify-agentd || true
  systemctl disable neoxify-agentd || true
  rm -f /etc/systemd/system/neoxify-agentd.service
  rm -f /usr/local/bin/agentd
  systemctl daemon-reload
  if [[ "${purge,,}" == "y" ]]; then
    rm -rf /etc/neoxify
  fi
  echo "Uninstalled."
}
