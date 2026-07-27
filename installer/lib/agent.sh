#!/usr/bin/env bash
# Installs and manages a VPN agent node: downloads the compiled agentd
# binary (no source tree needed, unlike the panel role), sets up protocol
# engines as systemd units, and enrolls with the control-plane panel.
set -euo pipefail

# The repo is public, so GitHub's friendly "latest release" asset URLs
# (see .github/workflows/release-agent.yml, which publishes
# agentd-linux-amd64/arm64 + sha256sums.txt on every v* tag) work with a
# plain unauthenticated curl -- confirmed directly against the real
# release. Override for a self-hosted/custom build, e.g.:
#   AGENT_RELEASE_URL_BASE=https://example.com/releases/v0.1.0 sudo -E ./install.sh
AGENT_RELEASE_URL_BASE="${AGENT_RELEASE_URL_BASE:-https://github.com/alihajipoor/neoconnect/releases/latest/download}"

fetch_agent_binary() {
  local asset_name="agentd-linux-$AGENT_ARCH"

  echo "Downloading agent binary for linux/$AGENT_ARCH..."
  # Saved under the same name sha256sums.txt references (not a generic
  # "agentd") -- sha256sum -c verifies by matching the exact filename in
  # each checksum line against a file of that name in the cwd. (This
  # tripped up an earlier version of this function -- see git history.)
  curl -fsSL "$AGENT_RELEASE_URL_BASE/$asset_name" -o "/tmp/$asset_name"
  curl -fsSL "$AGENT_RELEASE_URL_BASE/sha256sums.txt" -o /tmp/sha256sums.txt

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

  local detected_ip
  detected_ip="$(curl -fsSL https://api.ipify.org || true)"

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

  start_agentd
  cat <<EOF

Done. "$node_name" is registered with its engines and routes, and should
show as ONLINE in the panel within a few seconds.

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

  cat > /etc/nginx/sites-available/neoxify-fallback <<'CONF'
server {
    listen 127.0.0.1:8080;
    server_name _;
    root /var/www/neoxify-fallback;
    index index.html;
    # No server tokens: the version string is a fingerprint of its own.
    server_tokens off;
}
CONF
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
    return 0
  fi

  echo "Requesting a certificate for $domain..."
  echo "Port 80 must be free and $domain must already resolve to this server."
  read -r -p "Email for expiry notices: " le_email
  if ! certbot certonly --standalone -d "$domain" -m "$le_email" --agree-tos --non-interactive; then
    echo "Could not obtain a certificate for $domain." >&2
    echo "Check that its DNS record points here and that nothing else holds port 80." >&2
    return 1
  fi

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

  local keys private_key public_key
  keys="$(/usr/local/bin/xray x25519)"
  private_key="$(echo "$keys" | grep '^PrivateKey:' | awk '{print $2}')"
  public_key="$(echo "$keys" | grep '(PublicKey):' | awk '{print $3}')"
  local short_id
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
  local server_name="${dest%%:*}"

  # Trojan over TLS on a second port -- the same "looks like an ordinary
  # HTTPS site" property REALITY gives, but presenting a real certificate
  # for a real domain instead of borrowing someone else's.
  #
  # It cannot share REALITY's port: REALITY intercepts the TLS handshake
  # and proxies anything failing its authentication to the site it
  # imitates, leaving no room behind it for a second TLS service. With one
  # IPv4 that means a second port; with two, both can sit on 443.
  echo
  echo "Trojan over TLS (optional) adds a second stealth protocol on this node."
  echo "It needs a domain already pointing here, and a certificate for it."
  read -r -p "Enable Trojan over TLS? [y/N]: " enable_trojan
  local trojan_port="" tls_cert="" tls_key="" trojan_fallback="" trojan_domain=""
  if [[ "${enable_trojan,,}" == "y" ]]; then
    # 8443 by default. Less unblockable than 443, but so is every
    # commonly-open alternative (2053/2083/2087/2096) -- the operator can
    # name one of those here instead.
    read -r -p "Trojan port [8443]: " trojan_port
    trojan_port="${trojan_port:-8443}"
    read -r -p "Domain for the certificate (e.g. fi1.example.com): " trojan_domain
    if [[ -z "$trojan_domain" ]]; then
      echo "A domain is required: without a real certificate this protocol is more conspicuous than the one you already have, not less." >&2
      return 1
    fi
    issue_tls_certificate "$trojan_domain" || return 1
    # Not certbot's own paths: Xray runs as `nobody` and
    # /etc/letsencrypt/live is 0700 root, so pointing at it directly
    # makes Xray fail to start -- and because a bad certificate fails the
    # whole config, that takes the working VLESS inbound down with it.
    # Found exactly that way on a live node. install_cert_for_xray copies
    # to somewhere Xray can read; widening /etc/letsencrypt instead would
    # expose every key on the box to every process running as nobody.
    tls_cert="/usr/local/etc/xray/certs/fullchain.pem"
    tls_key="/usr/local/etc/xray/certs/privkey.pem"
    # Where a wrong password goes. This is the disguise: a prober who
    # guesses wrong gets a real web server rather than a protocol error,
    # which is the whole difference between "an HTTPS site" and
    # "something hiding on 8443".
    trojan_fallback="127.0.0.1:8080"
    ensure_fallback_site
  fi

  local template="$SCRIPT_DIR/assets/xray-config.json.template"
  read -r -p "Will this node relay other protocols (WireGuard/OpenVPN) to an exit node? [y/N]: " is_relay
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
    -e "s#__TLS_CERT_PATH__#${tls_cert:-/dev/null}#g" \
    -e "s#__TLS_KEY_PATH__#${tls_key:-/dev/null}#g" \
    -e "s/__TROJAN_FALLBACK__/${trojan_fallback:-127.0.0.1:8080}/g" \
    "$template" > /usr/local/etc/xray/config.json

  # A declined Trojan inbound is removed rather than left listening on
  # port 0 with a /dev/null certificate. Xray refuses to start when a
  # configured certificate is unreadable, and that would take the whole
  # node down -- including the VLESS inbound that was working perfectly.
  if [[ -z "$trojan_port" ]]; then
    python3 - <<'PY' || echo "warning: could not remove the unused Trojan inbound -- edit /usr/local/etc/xray/config.json by hand" >&2
import json

path = "/usr/local/etc/xray/config.json"
with open(path) as handle:
    config = json.load(handle)
config["inbounds"] = [i for i in config["inbounds"] if i.get("tag") != "trojan-in"]
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

  echo "Registering Xray in the panel..."
  local config_id params
  params="$(jq -n --arg pk "$public_key" --arg sid "$short_id" --arg dest "$dest" --arg sn "$server_name" \
    '{realityPublicKey: $pk, shortIds: [$sid], dest: $dest, serverName: $sn}')"
  config_id="$(register_protocol_config "XRAY_VLESS_REALITY" "$listen_port" "$params")" || return 1
  echo "  Registered (config $config_id)."
  create_route_for_config "Xray VLESS+REALITY" "$config_id"

  echo "Xray is running on port $listen_port and is ready to use."
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
install_wireguard() {
  echo "Installing WireGuard..."
  apt-get install -y -qq wireguard wireguard-tools

  install -d -m 700 /etc/wireguard
  ( umask 077 && wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key )
  local private_key public_key
  private_key="$(cat /etc/wireguard/server_private.key)"
  public_key="$(cat /etc/wireguard/server_public.key)"

  read -r -p "Listen port for WireGuard [51820]: " listen_port
  listen_port="${listen_port:-51820}"
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
# so callers do: token="$(get_admin_bearer_token)".
get_admin_bearer_token() {
  # Cached for the whole install: every protocol registration and route
  # creation needs it, and asking for the same password once per engine
  # was both tedious and an easy way to mistype halfway through.
  if [[ -n "${admin_token:-}" ]]; then
    echo "$admin_token"
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
  admin_token="$access_token"
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
  local token response config_id

  token="$(get_admin_bearer_token)" || return 1

  response="$(curl -sSL -X POST "$panel_url/protocol-configs" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$(jq -n --arg nodeId "$node_id" --arg protocol "$protocol" \
      --argjson listenPort "$listen_port" --argjson params "$params_json" \
      '{nodeId: $nodeId, protocol: $protocol, listenPort: $listenPort, publicParamsJson: $params}')")"

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
create_route_for_config() {
  local protocol="$1" config_id="$2"
  local token response route_id

  token="$(get_admin_bearer_token)" || return 1

  local exit_config_id=""
  if [[ "${node_is_relay:-n}" == "y" ]]; then
    exit_config_id="$(choose_exit_protocol_config)" || return 1
  fi

  local route_name="$node_name / $protocol"
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

# Lists Xray configs on EXIT nodes and asks which one this relay should
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
      | ($nodes[] | select(.id == $c.nodeId and .role == "EXIT")) as $n
      | {id: $c.id, label: ($n.name + " (" + $n.region + ") port " + ($c.listenPort|tostring))}
    ]')"

  count="$(echo "$candidates" | jq 'length')"
  if [[ "$count" == "0" ]]; then
    echo "ERROR: no Xray engine on an EXIT-role node was found to relay through." >&2
    echo "  Install an exit node first (role EXIT, with Xray), then re-run this on the relay." >&2
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
install_openvpn() {
  echo "Installing OpenVPN..."
  apt-get install -y -qq openvpn

  read -r -p "Listen port for OpenVPN [1194]: " listen_port
  listen_port="${listen_port:-1194}"
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
  4) Back

EOF
  read -r -p "Choose [1-4]: " choice
  case "$choice" in
    1) install_xray ;;
    2) install_wireguard ;;
    3) install_openvpn ;;
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
