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

  echo
  read -r -p "Node role [relay/exit/standalone] (default: standalone): " role
  role="${role:-standalone}"

  echo "Running enrollment..."
  /usr/local/bin/agentd --enroll-init --role "$role"

  start_agentd
  install -d -m 755 /etc/neoxify
  echo "agent" > /etc/neoxify/role
  echo
  echo "Paste the Node ID / Public IP / Enrollment Token above into"
  echo "Panel -> Nodes -> Add Node to finish registering this location."
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
  /usr/local/bin/agentd --enroll-init --panel-url "$panel_url"
  systemctl restart neoxify-agentd
}

action_engines_agent() {
  echo "Protocol engine management is built in Milestone M9/M10."
  echo "For now, engines selected at install time are managed automatically by the agent."
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
