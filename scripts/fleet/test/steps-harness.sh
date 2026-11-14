#!/usr/bin/env bash
# steps-harness.sh <function> [args...]
#
# Runs ONE function of the real checklists for real (not under
# --dry-run) with every host replaced by a stand-in, for steps.test.mjs.
# A dry run shows which commands a step would send; it cannot show what
# a step DECIDES once the hosts have answered. Those decisions are where
# the dangerous mistakes were: "nothing to move" when half the hop had
# moved, "the box is gone" after one failed connection, "complete" with
# a protocol never dialled.
#
# The stand-ins:
#   rget      hands back fixture files (the relay's live hop rules, the
#             relay's nftables file, a hop server's table)
#   rput      keeps what would have been sent, under put-<name>
#   rsh, rscript, pscript, rpipe   succeed and are written to `calls`; a
#             plain `true` sent to an exit answers as T_SSH says (ok or
#             fail); the new box's dest audit, trial inbound and image
#             check answer as T_AUDIT, T_TRIAL_START, T_TRIAL,
#             T_TRIAL_STATUS, T_ENROLLED and T_IMAGE say
#   q         answers from T_* variables
# lib/tool.mjs is the real one.
#
# What is set here is read by the files under lib/, hence:
# shellcheck disable=SC2034,SC1090,SC1091,SC2317
set -uo pipefail
FLEET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$FLEET_DIR/../.." && pwd)"
source "$FLEET_DIR/lib/engine.sh"
source "$FLEET_DIR/lib/remote.sh"
source "$FLEET_DIR/lib/checklist-precheck.sh"
source "$FLEET_DIR/lib/checklist-add.sh"
source "$FLEET_DIR/lib/checklist-retire.sh"
source "$FLEET_DIR/lib/checklist-replace.sh"

RUN_DIR="${T_RUN:?T_RUN, the run directory of this test}"
FIX="${T_FIX:?T_FIX, the directory of fixture files}"
CALLS="$RUN_DIR/calls"

OPT_DRY=0 OPT_YES=1 OPT_FROM="" OPT_ONLY="" OPT_DONE="" OPT_WAIVE="" OPT_PLANS="" OPT_DEFAULT_TO=""
OPT_HOP="${T_HOP:-auto}" OPT_NO_RELAY="${T_NO_RELAY:-0}" OPT_NO_PLANS="${T_NO_PLANS:-0}"
OPT_ACCEPT_HELD=0 OPT_ACCEPT_ZONE=0 OPT_ACCEPT_DEST="${T_ACCEPT_DEST:-0}" OPT_RELAY_SET=""
OPT_PROVEN="${T_PROVEN:-}" OPT_FRESH_DUMP="${T_FRESH:-0}" OPT_CANARY_PLAN="Internal test" OPT_PROVIDER_FW=0
EXTRA_AUTHORIZED_KEY_FILE="${T_EXTRA_KEY-}"
# --dest, as given on this pass (empty: not given).
DEST="${T_DEST:-}"
# T_OLD may be set and empty: a plain `add` has no old server.
NAME="${T_NAME:-germany-4}" OLD="${T_OLD-germany-3}" NEW_IP="${T_NEW_IP:-198.51.100.60}"
RELAY_HOST=198.51.100.20 RELAY_NODE_NAME=relay-1 SIGNIN_HOST=198.51.100.30 PANEL_HOST=203.0.113.5
PANEL_ORIGIN_NAME=origin.example.net NODE_DNS_ZONE=example.org CF_ZONES="example.org"
XRAY_VERSION=v0.0.0 HOP_PORT_BASE=47131 TEST_RELAY_EMAIL=relay-test@example.com TEST_DIRECT_EMAIL=owner@example.com

# As in `fleet` itself.
nn() { if [[ -n "$NAME" ]]; then echo "$NAME"; else state_get name; fi; }
st() { state_get "$@"; }

rpushdir() { :; }
rclean() { :; }
sleep() { :; }
rsh() {
  echo "rsh $1 $2" >>"$CALLS"
  if [[ "$1" == ip:* && "$2" == true ]]; then
    [[ "${T_SSH:-ok}" == ok ]]
    return
  fi
  # What the new box answers, for add.dest and add.image.
  case "$2" in
    *reality-dest-audit.sh*) echo "${T_AUDIT:-OK    www.example.org             AS64500 EXAMPLE in ZZ}" ;;
    *"agent.json && echo enrolled"*) echo "${T_ENROLLED:-}" ;;
    *"provider-image.sh"*) printf '%s\n' "${T_IMAGE:-ok      ufw: not active, none of its chains loaded}" ;;
    # The WireGuard/OpenVPN/IKEv2 dial on the panel host: T_DIAL is
    # "wireguard=pass,openvpn=fail,..." (default pass).
    *nx-dial.sh*)
      local k r
      for k in wireguard openvpn ikev2; do [[ "$2" == *" $k issued"* ]] && break; done
      r="$(tr ',' '\n' <<<"${T_DIAL:-}" | sed -n "s/^$k=//p")"
      echo "DIAL nxf-dial-test0"
      if [[ "${r:-pass}" == pass ]]; then
        printf '%s\n' "x $k issued | EXIT-MATCH | down 200 262144B 0.5s | up 200 262144B 0.5s" "E2E-PASS x $k issued" "HOLDING 25s"
      else
        printf '%s\n' "x $k issued | no WireGuard handshake in 20 s" "E2E-FAIL x $k issued"
      fi
      ;;
    # A recorded dump, looked at before reuse: T_DUMP=gone fails, else
    # T_DUMP_AGE seconds old (default 60), 62 MB.
    *"gzip -t '"*"stat -c '%s %Y'"*)
      [[ "${T_DUMP:-}" == gone ]] && return 1
      echo "62000000 $(($(date +%s) - ${T_DUMP_AGE:-60}))"
      ;;
    # The server's own view: T_SESSION_<KIND> is the line session.sh prints.
    *session.sh*)
      local v
      for k in wireguard openvpn ikev2; do [[ "$2" == *"session.sh $k "* ]] && break; done
      v="T_SESSION_${k^^}"
      # WireGuard's first read is the baseline, before the dial.
      if [[ "$k" == wireguard && ! -e "$RUN_DIR/wg-baseline" ]]; then
        : >"$RUN_DIR/wg-baseline"
        echo "${T_SESSION_WIREGUARD_BEFORE:-SESSION wireguard absent (no such peer)}"
      else
        echo "${!v:-SESSION $k found rx=300000 tx=300000 age=0}"
      fi
      ;;
  esac
  return 0
}
rscript() {
  echo "rscript $*" >>"$CALLS"
  case "$*" in
    *"reality-trial.sh start"*) echo "${T_TRIAL_START:-TRIAL-UP}" ;;
    *"reality-trial.sh status"*) printf '%s\n' "${T_TRIAL_STATUS:-down}" ;;
  esac
  return 0
}
# What is piped in is swallowed, as the far side would; the trial dial
# answers as T_TRIAL says.
rpipe() {
  cat >/dev/null
  echo "rpipe $1 $2" >>"$CALLS"
  case "$2" in
    *nx-e2e-pipe.sh*)
      if [[ "${T_TRIAL:-pass}" == pass ]]; then
        printf '%s\n' "trial | EXIT-MATCH | down 200 262144B 0.5s | up 200 262144B 0.5s" "E2E-PASS trial"
      else
        printf '%s\n' "trial | EXIT-NONE | down 000 0B 10.0s | up 000 0B 10.0s" "E2E-FAIL trial"
      fi
      ;;
  esac
  return 0
}
pscript() {
  echo "pscript $*" >>"$CALLS"
  return 0
}
rput() {
  echo "rput $1 $3" >>"$CALLS"
  cp "$2" "$RUN_DIR/put-$(basename "$3")"
}
rget() {
  case "$2" in
    */hop-live.txt) cp "$FIX/hop-live.txt" "$3" ;;
    /etc/nftables.conf) cp "$FIX/nftables.conf" "$3" ;;
    /etc/neoxify/chain-fw.nft) cp "$FIX/chain-fw.nft" "$3" ;;
    *) return 1 ;;
  esac
}
node_field() {
  case "$2" in
    publicIp) sed -n "s/^$1=//p" "$FIX/addresses" ;;
    realityDest) echo "www.example.org:443" ;;
  esac
}
q() {
  case "$1" in
    node-row) echo "${T_NODE_ROW:-}" ;;
    plan-holds) echo "${T_PLAN_HOLDS:-Pro|0|f|8}" ;;
    provision) printf 'have|%s\nwant|0\nnot-acked|0\n' "${T_HAVE:-0}" ;;
    route-ids) echo "${T_ROUTE_IDS:-}" ;;
    node-ports) echo "${T_NODE_PORTS:-}" | tr ';' '\n' ;;
    canary-plan) echo "${T_CANARY_ROW:-}" ;;
    dial-creds) echo "${T_DIAL_CREDS:-}" | tr ';' '\n' ;;
    *) return 0 ;;
  esac
}
relay_pid_same() { return 0; }
hop_exits_dial() {
  echo "dial $*" >>"$CALLS"
  return "${T_DIAL_RC:-0}"
}

"$@"
