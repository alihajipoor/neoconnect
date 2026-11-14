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
declare -A STEP_TITLE=() STEP_KIND=() STEP_PRIOR=() STEP_GATE_FLAG=()

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

# needs_prior <id>: that step is where customers get the server, so it
# refuses to run -- alone under --only as well -- unless every step
# before it passed in this run, or was waived on the record.
needs_prior() {
  [[ -n "${STEP_TITLE[$1]:-}" ]] || die "needs_prior: no step $1"
  STEP_PRIOR[$1]=1
}

# gate_flag <id> <flag>: the flag that records the owner's decision to go
# on past that gate. A stop there prints the whole command to continue
# with it, so nobody has to work out what to type.
gate_flag() {
  [[ -n "${STEP_TITLE[$1]:-}" ]] || die "gate_flag: no step $1"
  STEP_GATE_FLAG[$1]="$2"
}

# continue_cmd [flags...]: the exact command that picks this run up
# again. It names the run directory, never an address: `fleet continue`
# reads the rest of the command line from there.
continue_cmd() {
  local c="scripts/fleet/fleet continue ${RUN_DIR:-<run directory>}"
  [[ $# -gt 0 ]] && c+=" $*"
  echo "$c"
}

# --done a,b: is this step one of them?
done_named() {
  [[ -n "${OPT_DONE:-}" ]] || return 1
  case ",$OPT_DONE," in *",$1,"*) return 0 ;; esac
  return 1
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
step_waived() { [[ -f "$RUN_DIR/waived" ]] && grep -qx "$1" "$RUN_DIR/waived"; }

# --waive a,b: the owner's decision to go on although those steps did not
# pass. It is kept in the run directory, so it holds on the next pass,
# and written to the run log, so the run never reads as fully proven.
record_waivers() {
  local id
  for id in ${OPT_WAIVE:+${OPT_WAIVE//,/ }}; do
    [[ -n "${STEP_TITLE[$id]:-}" ]] || die "--waive: no step '$id' in this checklist"
    if step_done "$id" || step_waived "$id"; then continue; fi
    echo "$id" >>"$RUN_DIR/waived"
    log_line "WAIVED $id ${STEP_TITLE[$id]} (--waive: the owner's decision to go on without it)"
    echo "Waived on the owner's say-so, and written to the run log: $id"
  done
}

# unproven [<step>]: the steps (before <step>, or all of them) that
# neither passed in this run nor were waived.
unproven() {
  local id
  for id in "${STEP_IDS[@]}"; do
    [[ "$id" == "${1:-}" ]] && return 0
    step_done "$id" || step_waived "$id" || echo "$id"
  done
  return 0
}

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
    echo "  This step asks before it runs, and there is no terminal to ask at. Once the owner has agreed:"
    echo "    $(continue_cmd --yes)"
    return 1
  fi
  read -r -p "  $q [yes/no]: " a </dev/tty || return 1
  [[ "$a" == "yes" ]]
}

wait_owner() { # <step id>
  local a
  if ! have_tty; then
    echo "  Waiting for the owner, and there is no terminal to wait at. When it is done:"
    echo "    $(continue_cmd --done "$1")"
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
  echo "Fix the cause, then continue (it resumes at this step):"
  echo "    $(continue_cmd)"
  if [[ -n "${STEP_GATE_FLAG[$1]:-}" ]]; then
    echo "If the owner decides to go on past this gate as it is:"
    echo "    $(continue_cmd "${STEP_GATE_FLAG[$1]}")"
  fi
  echo "Run log, with the undo line of every change so far: $RUN_DIR/run.log"
}

refuse_unproven() { # <what is refused> <the unproven step ids, one per line>
  echo "REFUSED: $1. These earlier steps never passed in this run:"
  echo "$2" | sed 's/^/    /'
  echo "Continue with no --from and no --only, and it resumes at the first of them:"
  echo "    $(continue_cmd)"
  echo "If the owner has decided to go on without one, record that with --waive <step>[,<step>]:"
  echo "it is written to the run log, and the run then ends as complete EXCEPT those steps."
}

# ---------------------------------------------------------------- timing

# step_end <id> <result> <start, in $SECONDS>: how long the step took,
# printed and kept in the run directory (one line per try, every pass).
step_end() {
  local s=$((SECONDS - $3))
  echo "  took ${s}s"
  dry || printf '%s|%s|%s|%s\n' "$1" "$2" "$s" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$RUN_DIR/timings"
}

# report_timings <first line of this pass in the timings file>: a table
# of the steps this pass ran, with a total, and the whole run's table
# (every pass, every try) written to timings.txt in the run directory.
report_timings() {
  local from="${1:-1}" f="$RUN_DIR/timings"
  dry && return 0
  [[ -s "$f" ]] || return 0
  echo
  echo "Time per step, this pass:"
  tail -n +"$from" "$f" | awk -F'|' '{printf "  %-24s %-10s %6ss\n", $1, $2, $3; t += $3} END {printf "  %-24s %-10s %6ss  (%dm %02ds)\n", "TOTAL", "", t, t / 60, t % 60}'
  {
    echo "Time per step, the whole run (every pass; a step tried twice counts both tries):"
    awk -F'|' '{if (!($1 in s)) o[++n] = $1; s[$1] += $3; c[$1]++; r[$1] = $2; t += $3}
      END {for (i = 1; i <= n; i++) printf "%-24s %4d try %-10s %6ss\n", o[i], c[o[i]], r[o[i]], s[o[i]];
           printf "%-24s %4s     %-10s %6ss  (%dm %02ds)\n", "TOTAL", "", "", t, t / 60, t % 60}' "$f"
  } >"$RUN_DIR/timings.txt"
  echo "Whole run: $RUN_DIR/timings.txt"
}

run_checklist() {
  local total=${#STEP_IDS[@]} n=0 id fn kind rc started=1 miss t0
  [[ -n "${OPT_FROM:-}" ]] && started=0
  if [[ -n "${OPT_FROM:-}" && -z "${STEP_TITLE[$OPT_FROM]:-}" ]]; then die "no step '$OPT_FROM' in this checklist"; fi
  if [[ -n "${OPT_ONLY:-}" && -z "${STEP_TITLE[$OPT_ONLY]:-}" ]]; then die "no step '$OPT_ONLY' in this checklist"; fi
  for id in ${OPT_DONE:+${OPT_DONE//,/ }}; do
    [[ -n "${STEP_TITLE[$id]:-}" ]] || die "--done: no step '$id' in this checklist"
  done

  if ! dry; then
    record_waivers
    # --from starts later in the list; it is not a way past a step that
    # never passed. Without this a server could reach the plans with its
    # reboot test and its tunnels unproven, and the log would say complete.
    if [[ -n "${OPT_FROM:-}" ]]; then
      miss="$(unproven "$OPT_FROM")"
      if [[ -n "$miss" ]]; then
        refuse_unproven "--from $OPT_FROM would skip steps that have not passed" "$miss"
        log_line "REFUSED --from $OPT_FROM (unproven before it: $(tr '\n' ' ' <<<"$miss"))"
        return 1
      fi
    fi
  fi

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

    # A waived step is passed over, never run and never marked done.
    # Naming it with --only or --from runs it all the same.
    if [[ "$id" != "${OPT_ONLY:-}" && "$id" != "${OPT_FROM:-}" ]] && ! step_done "$id" && step_waived "$id"; then
      echo "  WAIVED (--waive, in the run log): not run, not proven"
      continue
    fi

    t0=$SECONDS
    if [[ -n "${STEP_PRIOR[$id]:-}" ]]; then
      miss="$(unproven "$id")"
      if [[ -n "$miss" ]]; then
        refuse_unproven "$id is where customers get the server, and it does not run on unproven work" "$miss" | sed 's/^/  /'
        log_line "REFUSED $id (unproven before it: $(tr '\n' ' ' <<<"$miss"))"
        step_end "$id" refused "$t0"
        return 1
      fi
    fi

    log_line "START $id ${STEP_TITLE[$id]}"
    if done_named "$id"; then
      # --done <step>: the step's action is NEVER run again here. For an
      # owner's step the owner did it between two runs; for any other
      # step it was done another way (by hand, or in an earlier pass).
      # Either way only the verify runs, and it alone decides.
      if [[ "$kind" == "owner" ]]; then
        echo "  the owner reports this done (--done $id): only the verify runs"
        log_line "OWNER-DONE $id (--done)"
      else
        echo "  --done $id: its action is not run again; only its verify runs, and decides"
        log_line "VERIFY-ONLY $id (--done)"
      fi
    else
      if [[ "$kind" == "ask" ]]; then
        if ! confirm "This step changes a live host other than the new box. Run it now?"; then
          log_line "WAITING $id (asks first; no --yes)"
          step_end "$id" asked "$t0"
          resume_hint "$id"
          return 1
        fi
      fi

      { "do_$fn"; } 2>&1 | mask | tee -a "$RUN_DIR/run.log"
      rc=${PIPESTATUS[0]}
      if [[ $rc -ne 0 ]]; then
        log_line "FAILED $id (do, exit $rc)"
        echo "  STEP FAILED (exit $rc)"
        step_end "$id" failed "$t0"
        resume_hint "$id"
        return 1
      fi

      # A step can find there is nothing for the owner to do, and say so
      # by setting nowait_<step>.
      if [[ "$kind" == "owner" ]] && ! state_has "nowait_$fn"; then
        if ! wait_owner "$id"; then
          log_line "WAITING $id (owner)"
          step_end "$id" owner "$t0"
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
      step_end "$id" failed "$t0"
      resume_hint "$id"
      return 1
    fi
    mark_done "$id"
    log_line "DONE $id"
    step_end "$id" "done" "$t0"
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
  local cmd="$1" subject="$2" base d n
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
      # Never a directory that is already there. The name is good to
      # the second, and a run started in the same second as one that
      # just finished was handed that run's directory: every step
      # already "done", and the new run complete without doing anything.
      d="$base/$cmd-$subject-$(date -u +%Y%m%dT%H%M%SZ)"
      RUN_DIR="$d"
      n=2
      while [[ -e "$RUN_DIR" ]]; do
        RUN_DIR="$d-$n"
        n=$((n + 1))
      done
      mkdir -p "$RUN_DIR"
      echo "New run: $RUN_DIR"
    else
      echo "Resuming run: $RUN_DIR"
    fi
  fi
  log_line "RUN $cmd $subject (flags: ${OPT_FLAGS:-none})"
}

finish_run() { dry || touch "$RUN_DIR/finished"; }

# conclude_run: a run is complete only when every step passed in it, or
# was waived on the record. Says which of the two, and only then marks
# the run finished.
conclude_run() {
  local miss id waived=""
  dry && return 0
  miss="$(unproven)"
  if [[ -n "$miss" ]]; then
    echo
    echo "NOT COMPLETE. These steps never passed in this run:"
    echo "$miss" | sed 's/^/    /'
    echo "Run the same command again with no --from: it resumes at the first of them."
    log_line "INCOMPLETE (never passed: $(tr '\n' ' ' <<<"$miss"))"
    return 1
  fi
  for id in "${STEP_IDS[@]}"; do
    step_done "$id" || waived+="$id "
  done
  finish_run
  echo
  if [[ -n "$waived" ]]; then
    echo "Checklist complete, EXCEPT these steps, which were waived and never passed: $waived"
    echo "What they prove is UNVERIFIED for this run."
    log_line "COMPLETE EXCEPT waived: $waived"
  else
    echo "Checklist complete."
    log_line "COMPLETE"
  fi
}
