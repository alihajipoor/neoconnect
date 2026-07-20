#!/usr/bin/env bash
# Interactive numbered menu for the agent-node role, plain `read`-based so
# it works even on minimal images without whiptail/dialog installed.
set -euo pipefail

print_agent_menu() {
  cat <<'EOF'

  NeoConnect Agent Node
  -----------------------
  1) Install NeoConnect Agent
  2) Update Agent / Protocol Engines
  3) View Status / Logs
  4) Change Panel URL / Re-enroll
  5) Add/Remove Protocol Engine
  6) Uninstall
  7) Exit

EOF
}

run_agent_menu() {
  while true; do
    print_agent_menu
    read -r -p "Choose an option [1-7]: " choice
    case "$choice" in
      1) action_install_agent ;;
      2) action_update_agent ;;
      3) action_status_agent ;;
      4) action_reenroll_agent ;;
      5) action_engines_agent ;;
      6) action_uninstall_agent ;;
      7) exit 0 ;;
      *) echo "Invalid option: $choice" ;;
    esac
  done
}
