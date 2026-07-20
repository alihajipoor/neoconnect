#!/usr/bin/env bash
# NeoConnect installer. One script, two possible roles for the Linux box
# it's run on:
#   - Main Panel Server: backend + admin panel + Postgres + Redis (Docker
#     Compose) fronted by nginx + Let's Encrypt. Must be run from inside
#     a checked-out copy of this repo (it builds the Docker images from
#     source) -- e.g. `git clone <repo-url> && cd neoconnect/installer &&
#     sudo ./install.sh`.
#   - VPN Agent Node: downloads the compiled agentd binary (no source
#     tree needed) and enrolls with the panel.
#
# Usage:
#   sudo ./install.sh          # fresh box: asks which role, then installs
#   sudo ./install.sh          # already installed: shows that role's menu
set -euo pipefail
trap 'echo "ERROR: installer failed at line $LINENO. Re-run ./install.sh — steps already completed (Docker install, image builds, etc.) are safe to repeat." >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_FILE="/etc/neoxify/role"

# shellcheck source=lib/os-detect.sh
. "$SCRIPT_DIR/lib/os-detect.sh"
# shellcheck source=lib/deps.sh
. "$SCRIPT_DIR/lib/deps.sh"
# shellcheck source=lib/systemd.sh
. "$SCRIPT_DIR/lib/systemd.sh"
# shellcheck source=lib/menu.sh
. "$SCRIPT_DIR/lib/menu.sh"
# shellcheck source=lib/agent.sh
. "$SCRIPT_DIR/lib/agent.sh"
# shellcheck source=lib/panel.sh
. "$SCRIPT_DIR/lib/panel.sh"

prompt_role() {
  cat <<'EOF'

  What does this server do?
    1) Main Panel Server (backend + admin panel + database)
    2) VPN Agent Node (runs VPN protocols, connects to the panel)

EOF
  read -r -p "Choose [1-2]: " role_choice
  case "$role_choice" in
    1) action_install_panel ;;
    2) action_install_agent ;;
    *)
      echo "Invalid choice: $role_choice" >&2
      exit 1
      ;;
  esac
}

main() {
  detect_os

  if [[ -f "$ROLE_FILE" ]]; then
    case "$(cat "$ROLE_FILE")" in
      panel) run_panel_menu ;;
      agent) run_agent_menu ;;
      *)
        echo "ERROR: $ROLE_FILE contains an unrecognized role." >&2
        exit 1
        ;;
    esac
  else
    prompt_role
  fi
}

main "$@"
