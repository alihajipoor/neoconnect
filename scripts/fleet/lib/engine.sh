# shellcheck shell=bash
# The checklist engine of `fleet`.
#
# A server change here is a list of steps, not a script that runs to the
# end. Every step has an id, a title, a `do_` function and an `ok_`
# function, and the next step does not start until `ok_` passes. What is
# done is written to a run directory outside the repository, so a run can
# stop anywhere and the same command picks it up again.
#
# Kinds of step:
#   auto   runs by itself (the new box, or read-only work)
#   ask    changes a live host other than the new box: asks first
#   owner  only a person can do it: says exactly what, then waits
#   gate   a decision: passes, or stops and says which flag records the
#          owner's decision to go on anyway
#
# Under --dry-run nothing is touched: the wrappers in remote.sh print the
# command they would have run, and every step and verify is shown.

STEP_IDS=()
declare -A STEP_TITLE=() STEP_KIND=()

die() { echo "fleet: $*" >&2; exit 1; }
dry() { [[ "${OPT_DRY:-0}" == 1 ]]; }
say() { echo "  $*"; }

fn_of() { local f="${1//./_}"; echo "${f//-/_}"; }

# step <id> <kind> <title>
step() {
  local id="$1" kind="$2" title="$3" fn
  fn="$(fn_of "$id")"
  declare -F "do_$fn" >/dev/null || die "step $id has no do_$fn"
  declare -F "ok_$fn" >/dev/null || die "step $id has no ok_$fn: every step needs a verify"
  [[ -z "${STEP_TITLE[$id]:-}" ]] || die "step id $id is registered twice"
  case "$kind" in auto | ask | owner | gate) ;; *) die "step $id: unknown kind $kind" ;; esac
  STEP_IDS+=("$id")
  STEP_TITLE[$id]="$title"
  STEP_KIND[$id]="$kind"
}

# ---------------------------------------------------------------- state

# Written straight to a file, because steps run on the left of a pipe
# (their output is masked) and a variable set there is gone afterwards.
state_set() {
  local k="$1" v="${2-}" f="$RUN_DIR/state"
  [[ "$k" =~ ^[A-Za-z0-9_]+$ ]] || die "bad state key $k"
  touch "$f"
  grep -v "^$k=" "$f" >"$f.tmp" || true
  printf '%s=%s\n' "$k" "$v" >>"$f.tmp"
  mv -f "$f.tmp" "$f"
}

state_has() { [[ -f "$RUN_DIR/state" ]] && grep -q "^$1=" "$RUN_DIR/state"; }

# state_get <key> [default]. Under --dry-run an unset key reads as
# {key}, so the printed commands show where a value will go.
state_get() {
  local k="$1" line
  if [[ -f "$RUN_DIR/state" ]] && line="$(grep -m1 "^$k=" "$RUN_DIR/state")"; then
    printf '%s' "${line#*=}"
  elif [[ $# -ge 2 ]]; then
    printf '%s' "$2"
  elif dry; then
    printf '{%s}' "$k"
  else
    return 1
  fi
}

# need <key>: the value, or stop with which step should have set it.
need() {
  state_get "$1" || die "no '$1' in this run yet: an earlier step has to record it (run without --only, or --from that step)"
}

step_done() { [[ -f "$RUN_DIR/done" ]] && grep -qx "$1" "$RUN_DIR/done"; }
mark_done() { echo "$1" >>"$RUN_DIR/done"; }

# undo "<how to take this step back>": goes into the run log beside the
# step that made the change.
undo() {
  echo "  UNDO ${CURRENT_STEP:-?}: $*"
}

log_line() { dry || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$RUN_DIR/run.log"; }

# ---------------------------------------------------------------- masking

# Everything a step prints goes through this. Named hosts become their
# role, our own names become a placeholder, and any other IPv4 becomes
# <ip>. Loopback, the tunnel pools and the two public resolvers stay
# readable: they are the same on every server.
build_mask() {
  local e="" pair v a z
  rx() { printf '%s' "$1" | sed -e 's/[.[\*^$/]/\\&/g'; }
  for pair in "PANEL_HOST:panel" "RELAY_HOST:relay" "SIGNIN_HOST:signin" "NEW_IP:new"; do
    v="${pair%%:*}"
    a="${!v:-}"
    [[ -n "$a" ]] && e+="s/(^|[^0-9.])$(rx "$a")([^0-9.]|\$)/\\1<${pair##*:}>\\2/g;"
  done
  for v in PANEL_ORIGIN_NAME PANEL_GRPC_NAME; do
    a="${!v:-}"
    [[ -n "$a" ]] && e+="s/$(rx "$a")/{panel-name}/g;"
  done
  for v in TEST_DIRECT_EMAIL TEST_RELAY_EMAIL; do
    a="${!v:-}"
    [[ -n "$a" ]] && e+="s/$(rx "$a")/{test-account}/g;"
  done
  for z in ${NODE_DNS_ZONE:-} ${CF_ZONES:-} ${OTHER_REGISTRAR_ZONES:-}; do
    e+="s/([a-z0-9-]+\\.)+$(rx "$z")/{name-in-zone}/g;s/$(rx "$z")/{zone}/g;"
  done
  e+='s/(^|[^0-9.])127\.0\.0\.1([^0-9.]|$)/\1@@LO@@\2/g;'
  e+='s/(^|[^0-9.])1\.1\.1\.1([^0-9.]|$)/\1@@R1@@\2/g;'
  e+='s/(^|[^0-9.])8\.8\.8\.8([^0-9.]|$)/\1@@R8@@\2/g;'
  e+='s/(^|[^0-9.])10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})([^0-9.]|$)/\1@@T\2_\3_\4@@\5/g;'
  e+='s/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g;'
  e+='s/@@LO@@/127.0.0.1/g;s/@@R1@@/1.1.1.1/g;s/@@R8@@/8.8.8.8/g;'
  e+='s/@@T([0-9]+)_([0-9]+)_([0-9]+)@@/10.\1.\2.\3/g'
  MASK_SED="$e"
}

mask() { sed -u -E "$MASK_SED"; }

# ---------------------------------------------------------------- people

# Is there a person at a terminal? An AI session driving this has none,
# and then questions are answered with flags instead: --yes for the
# steps that ask, --done <step> for the steps that wait for the owner.
have_tty() { [[ "${FLEET_NO_TTY:-0}" != 1 ]] && { : </dev/tty; } 2>/dev/null; }

confirm() {
  local q="$1" a
  [[ "${OPT_YES:-0}" == 1 ]] && return 0
  if ! have_tty; then
    echo "  This step asks before it runs, and there is no terminal to ask at. Run again with --yes"
    echo "  once the owner has agreed to it."
    return 1
  fi
  read -r -p "  $q [yes/no]: " a </dev/tty || return 1
  [[ "$a" == "yes" ]]
}

wait_owner() { # <step id>
  local a
  if ! have_tty; then
    echo "  Waiting for the owner, and there is no terminal to wait at. When it is done, run the same"
    echo "  command again with: --done $1"
    return 1
  fi
  while true; do
    read -r -p "  Type 'done' when that is done, or 'stop' to leave the run here: " a </dev/tty || return 1
    case "$a" in
      done) return 0 ;;
      stop) return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- runner

resume_hint() {
  echo
  echo "Stopped at $1. Nothing after it ran."
  echo "Fix the cause, then run the same command again: it resumes at this step."
  echo "Run log, with the undo line of every change so far: $RUN_DIR/run.log"
}

run_checklist() {
  local total=${#STEP_IDS[@]} n=0 id fn kind rc started=1
  [[ -n "${OPT_FROM:-}" ]] && started=0
  if [[ -n "${OPT_FROM:-}" && -z "${STEP_TITLE[$OPT_FROM]:-}" ]]; then die "no step '$OPT_FROM' in this checklist"; fi
  if [[ -n "${OPT_ONLY:-}" && -z "${STEP_TITLE[$OPT_ONLY]:-}" ]]; then die "no step '$OPT_ONLY' in this checklist"; fi

  for id in "${STEP_IDS[@]}"; do
    n=$((n + 1))
    fn="$(fn_of "$id")"
    kind="${STEP_KIND[$id]}"
    if [[ -n "${OPT_ONLY:-}" && "$id" != "$OPT_ONLY" ]]; then continue; fi
    if [[ $started -eq 0 ]]; then
      [[ "$id" == "$OPT_FROM" ]] || continue
      started=1
    fi

    printf '\n[%d/%d] %s  %s  (%s)\n' "$n" "$total" "$id" "${STEP_TITLE[$id]}" "$kind"
    export CURRENT_STEP="$id"

    if dry; then
      { "do_$fn"; echo "  VERIFY:"; "ok_$fn"; } 2>&1 | mask | sed -u 's/^/  /'
      continue
    fi

    # --from and --only run a step again even when it is marked done.
    if [[ -z "${OPT_ONLY:-}" && -z "${OPT_FROM:-}" ]] && step_done "$id"; then
      echo "  done in an earlier pass"
      continue
    fi

    if [[ "$kind" == "ask" ]]; then
      if ! confirm "This step changes a live host other than the new box. Run it now?"; then
        resume_hint "$id"
        return 1
      fi
    fi

    log_line "START $id ${STEP_TITLE[$id]}"
    if [[ "$kind" == "owner" && "${OPT_DONE:-}" == "$id" ]]; then
      # --done <step>: the owner did it between two runs. What to do was
      # printed the first time; only the verify is left.
      echo "  the owner reports this done (--done $id)"
      log_line "OWNER-DONE $id (--done)"
    else
      { "do_$fn"; } 2>&1 | mask | tee -a "$RUN_DIR/run.log"
      rc=${PIPESTATUS[0]}
      if [[ $rc -ne 0 ]]; then
        log_line "FAILED $id (do, exit $rc)"
        echo "  STEP FAILED (exit $rc)"
        resume_hint "$id"
        return 1
      fi

      # A step can find there is nothing for the owner to do, and say so
      # by setting nowait_<step>.
      if [[ "$kind" == "owner" ]] && ! state_has "nowait_$fn"; then
        if ! wait_owner "$id"; then
          log_line "WAITING $id (owner)"
          echo
          echo "Stopped at $id, which is the owner's. Nothing after it ran."
          echo "Run log: $RUN_DIR/run.log"
          return 1
        fi
      fi
    fi

    { "ok_$fn"; } 2>&1 | mask | tee -a "$RUN_DIR/run.log"
    rc=${PIPESTATUS[0]}
    if [[ $rc -ne 0 ]]; then
      log_line "FAILED $id (verify, exit $rc)"
      echo "  VERIFY FAILED"
      resume_hint "$id"
      return 1
    fi
    mark_done "$id"
    log_line "DONE $id"
  done
  return 0
}

# list_steps: ids and titles, for `fleet steps <command>` and the docs.
list_steps() {
  local id
  for id in "${STEP_IDS[@]}"; do
    printf '%-24s %-6s %s\n' "$id" "${STEP_KIND[$id]}" "${STEP_TITLE[$id]}"
  done
}

# ---------------------------------------------------------------- run dir

# open_run <command> <subject>. Resumes the newest unfinished run of the
# same command and subject unless --new-run is given.
open_run() {
  local cmd="$1" subject="$2" base d
  if dry; then
    RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fleet-dry.XXXXXX")"
    # shellcheck disable=SC2064
    trap "rm -rf '$RUN_DIR'" EXIT
    return 0
  fi
  base="$FLEET_HOME/runs"
  mkdir -p "$base"
  chmod 700 "$FLEET_HOME" "$base" 2>/dev/null || true
  if [[ -n "${OPT_RUN:-}" ]]; then
    RUN_DIR="$OPT_RUN"
    [[ -d "$RUN_DIR" ]] || die "no such run directory: $RUN_DIR"
  else
    RUN_DIR=""
    if [[ "${OPT_NEW_RUN:-0}" != 1 ]]; then
      for d in "$base/$cmd-$subject-"*; do
        [[ -d "$d" && ! -f "$d/finished" ]] && RUN_DIR="$d"
      done
    fi
    if [[ -z "$RUN_DIR" ]]; then
      RUN_DIR="$base/$cmd-$subject-$(date -u +%Y%m%dT%H%M%SZ)"
      mkdir -p "$RUN_DIR"
      echo "New run: $RUN_DIR"
    else
      echo "Resuming run: $RUN_DIR"
    fi
  fi
  log_line "RUN $cmd $subject (flags: ${OPT_FLAGS:-none})"
}

finish_run() { dry || touch "$RUN_DIR/finished"; }
