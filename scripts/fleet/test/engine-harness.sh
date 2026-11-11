#!/usr/bin/env bash
# A four-step checklist with no host behind it, for engine.test.mjs: the
# engine's own behaviour (stop on a failed verify, resume, --only,
# --done, the undo log, masking) run for real, not under --dry-run.
set -uo pipefail
# shellcheck disable=SC2034
FLEET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/engine.sh
source "$FLEET_DIR/lib/engine.sh"

OPT_DRY=0 OPT_YES=0 OPT_NEW_RUN=0 OPT_RUN="" OPT_FLAGS=""
OPT_FROM="${T_FROM:-}" OPT_ONLY="${T_ONLY:-}" OPT_DONE="${T_DONE:-}"
# shellcheck disable=SC2034
PANEL_HOST=203.0.113.5 NEW_IP=203.0.113.10 NODE_DNS_ZONE=example.org

do_t_one() {
  say "one ran against $PANEL_HOST for abc123.example.org and 198.51.100.77"
  state_set one "$(($(state_get one 0) + 1))"
  undo "take one back"
}
ok_t_one() { return 0; }

do_t_two() { say "two ran"; }
ok_t_two() { [[ -f "$FLEET_HOME/allow-two" ]]; }

do_t_owner() { say "OWNER: do the thing"; }
ok_t_owner() { [[ -f "$FLEET_HOME/owner-did-it" ]]; }

do_t_three() { say "three ran with one=$(state_get one)"; }
ok_t_three() { return 0; }

step t.one auto "First"
step t.two auto "Second"
step t.owner owner "The owner's"
step t.three auto "Third"

open_run toy subject
build_mask
if run_checklist; then
  [[ -n "$OPT_ONLY" ]] || finish_run
  echo "CHECKLIST-COMPLETE"
  exit 0
fi
exit 1
