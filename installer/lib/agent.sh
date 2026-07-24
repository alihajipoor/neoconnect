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

  cat <<'EOF'

Before continuing: in the panel, go to Nodes -> Add Node, fill in this
node's name/role/region, and copy the enrollment token it gives you
(shown once). That's what this step needs below.

EOF
  # Must include /api -- nginx only proxies the backend under that
  # prefix (see installer/assets/nginx-panel.conf.template); the bare
  # domain hits the Next.js panel itself and 404s.
  read -r -p "Panel URL, including /api (e.g. https://connect.example.com/api): " panel_url
  read -r -p "Enrollment token: " enroll_token

  echo "Claiming enrollment token..."
  /usr/local/bin/agentd --enroll-init --panel-url "$panel_url" --token "$enroll_token"

  install -d -m 755 /etc/neoxify
  echo "agent" > /etc/neoxify/role

  # Needed below by install_openvpn (its Protocol Config's nodeId) --
  # written to the agent's own config by the enroll-init call just
  # above. Visible to install_xray/install_wireguard/install_openvpn
  # too since bash functions see their caller's locals.
  local node_id
  node_id="$(jq -r '.nodeId' /etc/neoxify/agent.json)"

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
  echo
  echo "Enrolled. This node should show as ONLINE in the panel within a"
  echo "few seconds -- check: systemctl status neoxify-agentd"
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
  read -r -p "Camouflage destination (a real HTTPS site) [www.microsoft.com:443]: " dest
  dest="${dest:-www.microsoft.com:443}"
  local server_name="${dest%%:*}"

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
    "$template" > /usr/local/etc/xray/config.json

  systemctl restart xray

  cat <<EOF

Xray is running on port $listen_port. Register this as a Protocol Config
in the panel (Nodes -> this node -> Add Protocol Config once that UI
exists; for now, POST /protocol-configs) with:

  protocol:    XRAY_VLESS_REALITY
  listenPort:  $listen_port
  publicParamsJson:
    realityPublicKey: $public_key
    shortIds:          ["$short_id"]
    dest:              "$dest"
    serverName:        "$server_name"

EOF
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

  cat <<EOF

WireGuard is running on port $listen_port. Register this as a Protocol
Config in the panel (Nodes -> this node -> Add Protocol Config once
that UI exists; for now, POST /protocol-configs) with:

  protocol:    WIREGUARD
  listenPort:  $listen_port
  publicParamsJson:
    serverPublicKey: $public_key
    endpoint:         "${endpoint_host}:${listen_port}"
    subnetCidr:       "$subnet"
    dns:              "$dns"

EOF
}

# Prompts for panel admin credentials and exchanges them for a fresh
# access token, including the MFA-enabled case -- needed because
# OpenVPN's Protocol Config creation (unlike Xray/WireGuard, which set
# themselves up node-locally) requires calling the backend's admin API
# to generate the CA (see openvpn-pki.ts). Bash has no string return,
# so callers do: token="$(get_admin_bearer_token)".
get_admin_bearer_token() {
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
  echo "$access_token"
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
  echo "Creating this node's OpenVPN Protocol Config in the panel (needs an admin login -- only used for this one API call, not stored)..."
  local admin_token
  admin_token="$(get_admin_bearer_token)"

  local config_json
  config_json="$(curl -fsSL -X POST "$panel_url/protocol-configs" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $admin_token" \
    -d "$(jq -n --arg nodeId "$node_id" --argjson listenPort "$listen_port" --arg proto "$proto" --arg endpoint "$endpoint_host:$listen_port" \
      '{nodeId: $nodeId, protocol: "OPENVPN", listenPort: $listenPort, publicParamsJson: {proto: $proto, endpoint: $endpoint}}')")"

  local ca_cert server_cert server_key
  ca_cert="$(echo "$config_json" | jq -r '.publicParamsJson.caCertPem // empty')"
  server_cert="$(echo "$config_json" | jq -r '.publicParamsJson.serverCertPem // empty')"
  server_key="$(echo "$config_json" | jq -r '.publicParamsJson.serverKeyPem // empty')"

  if [[ -z "$ca_cert" ]]; then
    echo "ERROR: could not create the OpenVPN Protocol Config -- response was: $config_json" >&2
    exit 1
  fi

  install -d -m 755 /etc/openvpn/server /etc/openvpn/ccd
  printf '%s' "$ca_cert" > /etc/openvpn/server/ca.crt
  printf '%s' "$server_cert" > /etc/openvpn/server/server.crt
  printf '%s' "$server_key" > /etc/openvpn/server/server.key
  chmod 600 /etc/openvpn/server/server.key

  openvpn --genkey secret /etc/openvpn/server/tls-crypt.key
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
