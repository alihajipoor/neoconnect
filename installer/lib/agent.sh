#!/usr/bin/env bash
# Installs and manages a VPN agent node: downloads the compiled agentd
# binary (no source tree needed, unlike the panel role), sets up protocol
# engines as systemd units, and enrolls with the control-plane panel.
set -euo pipefail

AGENT_RELEASE_URL_BASE="${AGENT_RELEASE_URL_BASE:-}"

fetch_agent_binary() {
  if [[ -z "$AGENT_RELEASE_URL_BASE" ]]; then
    cat >&2 <<'EOF'
ERROR: no agent release available yet.

The agent binary release pipeline (signed builds + checksums for
linux/amd64 and linux/arm64) is built in Milestone M10. Until then, set
AGENT_RELEASE_URL_BASE to a build you've published yourself, e.g.:

  AGENT_RELEASE_URL_BASE=https://example.com/releases/v0.1.0 sudo -E ./install.sh
EOF
    exit 1
  fi

  local url="$AGENT_RELEASE_URL_BASE/agentd-linux-$AGENT_ARCH"
  local sums_url="$AGENT_RELEASE_URL_BASE/sha256sums.txt"

  echo "Downloading agent binary for linux/$AGENT_ARCH..."
  curl -fsSL "$url" -o /tmp/agentd
  curl -fsSL "$sums_url" -o /tmp/sha256sums.txt

  if ! (cd /tmp && grep "agentd-linux-$AGENT_ARCH" sha256sums.txt | sha256sum -c -); then
    echo "ERROR: checksum verification failed, aborting install." >&2
    exit 1
  fi

  install -m 755 /tmp/agentd /usr/local/bin/agentd
  rm -f /tmp/agentd /tmp/sha256sums.txt
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

  sed \
    -e "s/__LISTEN_PORT__/$listen_port/g" \
    -e "s/__DEST__/$dest/g" \
    -e "s/__SERVER_NAME__/$server_name/g" \
    -e "s/__REALITY_PRIVATE_KEY__/$private_key/g" \
    -e "s/__SHORT_ID__/$short_id/g" \
    "$SCRIPT_DIR/assets/xray-config.json.template" > /usr/local/etc/xray/config.json

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
  2) Back

EOF
  read -r -p "Choose [1-2]: " choice
  case "$choice" in
    1) install_xray ;;
    *) return ;;
  esac
  echo "WireGuard and OpenVPN engine management land in M4/M8."
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
