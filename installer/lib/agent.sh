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

  local tag
  # Newest non-draft, non-prerelease tag that looks like v1.2.3 -- the
  # agent's own scheme. `desktop-v*` does not match, which is the point.
  tag="$(curl -fsSL "https://api.github.com/repos/$AGENT_REPO/releases?per_page=50" 2>/dev/null     | jq -r '[.[] | select(.draft==false and .prerelease==false)
              | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$"))]
             | first | .tag_name // empty')"

  if [[ -z "$tag" ]]; then
    echo "ERROR: could not find an agent release (tag vX.Y.Z) in $AGENT_REPO." >&2
    echo "Pin one by hand, e.g.:" >&2
    echo "  AGENT_RELEASE_URL_BASE=https://github.com/$AGENT_REPO/releases/download/v0.2.1 sudo -E ./install.sh" >&2
    return 1
  fi

  echo "https://github.com/$AGENT_REPO/releases/download/$tag"
}

fetch_agent_binary() {
  local asset_name="agentd-linux-$AGENT_ARCH"
  local base
  base="$(resolve_agent_release_base)" || exit 1

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

  install -m 755 "/tmp/$asset_name" /usr/local/bin/agentd
  rm -f "/tmp/$asset_name" /tmp/sha256sums.txt
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
  # where ipify reported 31.171.101.2 while inbound only worked on
  # 185.222.28.186 -- the interface address is correct and ipify is
  # actively wrong.
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

  echo "Enrolling agent..."
  /usr/local/bin/agentd --enroll-init --panel-url "$panel_url" --token "$enroll_token"

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

Nothing further to configure by hand -- customers can select it as soon
as it reports in. To change ports or parameters later, edit the Protocol
Config in the panel.

Check the agent with: systemctl status neoxify-agentd
EOF
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

  install -d -m 755 /var/www/neoxify-fallback
  # Deliberately dull and impersonal. A page claiming to be some real
  # organisation would be a lie told to whoever looks, and a page saying
  # "VPN" would undo the entire point.
  cat > /var/www/neoxify-fallback/index.html <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>It works</title></head>
<body><h1>It works</h1><p>This server is up.</p></body>
</html>
HTML

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
    echo "Port 80 must be free and $domain must already resolve to this server."
    read -r -p "Email for expiry notices: " le_email
    if ! certbot certonly --standalone -d "$domain" -m "$le_email" --agree-tos --non-interactive; then
      echo "Could not obtain a certificate for $domain." >&2
      echo "Check that its DNS record points here and that nothing else holds port 80." >&2
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

  # Xray reads its certificate once at startup, so a renewal it is never
  # told about means serving an expired certificate roughly three months
  # from now -- long after anyone would connect the two events. The copy
  # has to be refreshed first, or the reload just re-reads the old one.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-xray.sh <<'HOOK'
#!/bin/sh
/usr/local/bin/neoxify-sync-certs
# Reload rather than restart: a certificate renewal is no reason to drop
# every connected customer.
systemctl reload xray 2>/dev/null || systemctl restart xray
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-xray.sh
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
    # from where customers are -- google.com is filtered in Iran, which is
    # the main market -- and (b) not something local security software
    # intercepts. Traffic to an intercepted domain fails with "received
    # real certificate", because the interceptor's certificate arrives
    # instead of the one REALITY expects. Found live: www.microsoft.com is
    # intercepted by security software on a real user's machine and broke
    # every connection until the domain was changed.
    #
    # Whatever is chosen here must also be set as dest/serverName on the
    # Protocol Config -- the client takes its SNI from the panel, and a
    # mismatch fails exactly the same way as interception does.
    echo
    echo "REALITY disguises this node's traffic as HTTPS to another site."
    echo "Pick one that is popular, reachable from your customers' countries,"
    echo "and supports TLS 1.3 -- avoid placeholder domains like example.com."
    read -r -p "Camouflage destination [cloudflare.com:443]: " dest
    dest="${dest:-cloudflare.com:443}"
    server_name="${dest%%:*}"
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
    read -r -p "Set them up? [y/N]: " enable_tls_protocols
  fi

  if [[ "${enable_tls_protocols,,}" == "y" ]]; then
    read -r -p "Domain for the certificate (e.g. fi1.example.com): " tls_domain
    if [[ -z "$tls_domain" ]]; then
      echo "A domain is required: without a real certificate these protocols are more conspicuous than the one you already have, not less." >&2
      return 1
    fi
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
    if [[ "$vless_tls_is_new" == "y" ]]; then
      read -r -p "Port for VLESS over TLS, or 'skip' [2053]: " vless_tls_port
      vless_tls_port="${vless_tls_port:-2053}"
      [[ "${vless_tls_port,,}" == "skip" ]] && vless_tls_port=""
    fi
    if [[ "$trojan_is_new" == "y" ]]; then
      # 8443, 2053, 2083, 2087 and 2096 are the commonly-open choices.
      # None is as unblockable as 443, which REALITY is holding.
      read -r -p "Port for Trojan over TLS, or 'skip' [skip]: " trojan_port
      trojan_port="${trojan_port:-skip}"
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
      read -r -p "Path for the WebSocket, or 'skip' [/ws]: " vless_ws_path
      vless_ws_path="${vless_ws_path:-/ws}"
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
    read -r -p "Port for Shadowsocks 2022, or 'skip' [skip]: " ss_port
    ss_port="${ss_port:-skip}"
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

  # Xray exposes no way to ask how many connections a user has, so the
  # agent counts distinct client addresses from the access log instead --
  # without this, concurrent-connection limits can't be enforced at all.
  # Rotated so it can't fill the disk on a busy node.
  install -d -m 755 /var/log/xray
  cat > /etc/logrotate.d/xray <<'EOF'
/var/log/xray/*.log {
  daily
  rotate 7
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
  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = ${server_ip}/24
ListenPort = ${listen_port}
PrivateKey = ${private_key}
PostUp = iptables -t nat -C POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s ${subnet} -o ${default_iface} -j MASQUERADE 2>/dev/null || true
EOF
  chmod 600 /etc/wireguard/wg0.conf

  systemctl enable --now wg-quick@wg0
  systemctl restart wg-quick@wg0

  echo "Registering WireGuard in the panel..."
  local config_id params
  params="$(jq -n --arg pk "$public_key" --arg ep "${endpoint_host}:${listen_port}" --arg subnet "$subnet" --arg dns "$dns" \
    '{serverPublicKey: $pk, endpoint: $ep, subnetCidr: $subnet, dns: $dns}')"
  config_id="$(register_protocol_config "WIREGUARD" "$listen_port" "$params")" || return 1
  echo "  Registered (config $config_id)."
  create_route_for_config "WireGuard" "$config_id"

  echo "WireGuard is running on port $listen_port and is ready to use."
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
  if ! certbot certonly --standalone --non-interactive --agree-tos \
      --key-type rsa --rsa-key-size 2048 \
      --register-unsafely-without-email -d "$hostname_input" >/dev/null 2>&1; then
    echo "  certbot could not issue a certificate for $hostname_input." >&2
    echo "  Check inbound TCP 80 reaches this node, including any cloud firewall." >&2
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
    iptables -t nat -C POSTROUTING -s "$listen_pool" -o "$uplink" -j MASQUERADE 2>/dev/null || \
      iptables -t nat -A POSTROUTING -s "$listen_pool" -o "$uplink" -j MASQUERADE
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

  config_json="$(curl -sSL -X POST "$panel_url/protocol-configs" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$(jq -n --arg nodeId "$node_id" --argjson listenPort "$listen_port" --arg proto "$proto" --arg endpoint "$endpoint_host:$listen_port" \
      '{nodeId: $nodeId, protocol: "OPENVPN", listenPort: $listenPort, publicParamsJson: {proto: $proto, endpoint: $endpoint}}')")"

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
  local default_iface ovpn_subnet="10.77.0.0/24"
  default_iface="$(detect_default_iface)"
  if [[ -z "$default_iface" ]]; then
    echo "ERROR: could not detect the default outbound network interface -- required so client traffic can actually reach the internet." >&2
    exit 1
  fi
  enable_ip_forwarding
  if ! iptables -t nat -C POSTROUTING -s "$ovpn_subnet" -o "$default_iface" -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -s "$ovpn_subnet" -o "$default_iface" -j MASQUERADE
  fi
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
  fetch_agent_binary
  systemctl restart neoxify-agentd
  echo "Agent updated and restarted."
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
