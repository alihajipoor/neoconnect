#!/usr/bin/env bash
# Installs the neoxify-agentd systemd unit from the template in assets/.
set -euo pipefail

install_agentd_unit() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  install -d -m 755 /etc/neoxify
  install -m 644 "$script_dir/assets/neoxify-agentd.service" /etc/systemd/system/neoxify-agentd.service

  systemctl daemon-reload
  systemctl enable neoxify-agentd
}

start_agentd() {
  systemctl restart neoxify-agentd
}
