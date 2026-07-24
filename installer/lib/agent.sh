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
  read -r -p "Panel URL (e.g. https://connect.example.com): " panel_url
  read -r -p "Enrollment token: " enroll_token

  echo "Claiming enrollment token..."
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

  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = ${server_ip}/24
ListenPort = ${listen_port}
PrivateKey = ${private_key}
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

# Installs openvpn, then FETCHES its CA/server cert/key from the panel
# API rather than generating them locally -- the reverse direction from
# install_xray/install_wireguard. OpenVPN's per-client cert issuance
# needs a CA that can sign new certs on every purchase, and that CA is
# generated and held by the backend (see
# apps/backend/src/modules/protocol-configs/openvpn-pki.ts for why: it's
# the one protocol where "generate node-local, register the public half"
# doesn't work, since backend needs actual signing capability, not just
# a public key, to issue client certs). So the ProtocolConfig must exist
# in the panel FIRST (which is what auto-generates the CA), and this
# step pulls the result down.
install_openvpn() {
  echo "Installing OpenVPN..."
  apt-get install -y -qq openvpn

  cat <<'EOF'

Before continuing: create this node's OpenVPN Protocol Config via the
panel API first (POST /protocol-configs) -- that's what generates the
CA and server cert this step fetches. Example body:

  {
    "nodeId": "<this node's id>",
    "protocol": "OPENVPN",
    "listenPort": 1194,
    "publicParamsJson": { "proto": "udp", "endpoint": "<this node's public IP>:1194" }
  }

You'll need the resulting Protocol Config's id below, plus an admin
bearer token (panel login) to fetch it.

EOF
  read -r -p "Panel URL (e.g. https://connect.example.com): " panel_url
  read -r -p "Admin bearer token: " admin_token
  read -r -p "Protocol Config id: " config_id

  local config_json
  config_json="$(curl -fsSL "$panel_url/protocol-configs/$config_id" -H "Authorization: Bearer $admin_token")"

  local listen_port proto ca_cert server_cert server_key
  listen_port="$(echo "$config_json" | jq -r '.listenPort')"
  proto="$(echo "$config_json" | jq -r '.publicParamsJson.proto // "udp"')"
  ca_cert="$(echo "$config_json" | jq -r '.publicParamsJson.caCertPem')"
  server_cert="$(echo "$config_json" | jq -r '.publicParamsJson.serverCertPem')"
  server_key="$(echo "$config_json" | jq -r '.publicParamsJson.serverKeyPem')"

  if [[ -z "$listen_port" || "$listen_port" == "null" || -z "$ca_cert" || "$ca_cert" == "null" ]]; then
    echo "ERROR: could not fetch a valid OpenVPN Protocol Config -- check the id/token and that its protocol is OPENVPN." >&2
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
