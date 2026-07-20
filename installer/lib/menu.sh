#!/usr/bin/env bash
# Interactive numbered menu, plain `read`-based so it works even on minimal
# images without whiptail/dialog installed.
set -euo pipefail

print_menu() {
  cat <<'EOF'

  NeoConnect Node Agent
  ----------------------
  1) Install NeoConnect Agent
  2) Update Agent / Protocol Engines
  3) View Status / Logs
  4) Change Panel URL / Re-enroll
  5) Add/Remove Protocol Engine
  6) Uninstall
  7) Exit

EOF
}

run_menu() {
  while true; do
    print_menu
    read -r -p "Choose an option [1-7]: " choice
    case "$choice" in
      1) action_install ;;
      2) action_update ;;
      3) action_status ;;
      4) action_reenroll ;;
      5) action_engines ;;
      6) action_uninstall ;;
      7) exit 0 ;;
      *) echo "Invalid option: $choice" ;;
    esac
  done
}
