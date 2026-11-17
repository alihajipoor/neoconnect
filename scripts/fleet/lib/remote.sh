# shellcheck shell=bash
# How `fleet` reaches the hosts. Every command that leaves this PC goes
# through one of these wrappers, which is what makes --dry-run total:
# under it they print the command (to stderr, so a captured value stays
# empty) and touch nothing.
#
# Hosts are named by role, never by address:
#   panel   the panel/API host                    (PANEL_KEY)
#   relay   the relay box inside the country      (INSIDE_KEY)
#   signin  the sign-in box inside the country    (INSIDE_KEY)
#   new     the box being built                   (NODE_KEY)
#   ip:<a>  any other exit, by an address read from the database (NODE_KEY)
#
# Addresses come from fleet.env or from the database through the panel
# host. None is in this repository.

REMOTE_DIR=/dev/shm/nxf
SSH_BASE=(-o BatchMode=yes -o PasswordAuthentication=no -o ConnectTimeout=15 -o ServerAliveInterval=20)

role_addr() {
  case "$1" in
    panel) echo "$PANEL_HOST" ;;
    relay) echo "$RELAY_HOST" ;;
    signin) echo "$SIGNIN_HOST" ;;
    new) echo "$NEW_IP" ;;
    ip:*) echo "${1#ip:}" ;;
    *) die "unknown host role $1" ;;
  esac
}

role_key() {
  case "$1" in
    panel) echo "$PANEL_KEY" ;;
    relay | signin) echo "$INSIDE_KEY" ;;
    *) echo "$NODE_KEY" ;;
  esac
}

role_label() { case "$1" in ip:*) echo "node" ;; *) echo "$1" ;; esac; }

# A host this PC has never talked to (a brand-new box, or a server built
# from the other machine) has no host key here yet: take it on first
# contact. A CHANGED key is still refused, for every host.
role_ssh_opts() {
  echo "-o StrictHostKeyChecking=accept-new"
}

# ---------------------------------------------------------------- transport
#
# How a remote call travels. Two ways, chosen once per run:
#   hub  one connection per host, kept for the run (lib/ssh-hub.mjs),
#        each call its own channel on it: a round trip, not a handshake
#   ssh  a new ssh process and connection per call, as every run before
#        2026-11-17 did. FLEET_SSH=ssh chooses it, and it is what a run
#        falls back to when the helper cannot start.
# Even under hub, a call the helper cannot vouch for (a host it has no
# known key for, a changed key, anything unusual) is made by plain ssh
# with the same arguments, so host keys are only ever judged as ssh
# judges them. The run log says which transport ran, and how many remote
# calls and new connections each step made.

FLEET_TRANSPORT=ssh

# native_path <path>: the form a Windows program (node) can open.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# The inside boxes (relay, signin) stay on plain ssh unless
# FLEET_HUB_INSIDE=1. The helper's SSH client is not OpenSSH: it has no
# post-quantum key exchange and looks different on the wire, and those
# connections cross the restricted country's network, where an unusual
# client making steady root sessions makes the boxes stand out. The cost
# is about 2 s more on each of their roughly 45 calls in an add.
transport_role_on_hub() {
  case "$1" in
    relay | signin) [[ "${FLEET_HUB_INSIDE:-0}" == 1 ]] ;;
    *) return 0 ;;
  esac
}

# fssh <role> <arguments ssh would get>: one remote call.
fssh() {
  local role="$1" rc t0="${EPOCHREALTIME:-}" fb
  shift
  [[ -n "${FLEET_SSH_CALLS:-}" ]] && echo "${CURRENT_STEP:-run}" >>"$FLEET_SSH_CALLS"
  if [[ -n "${FLEET_HUB_PORT:-}" ]] && transport_role_on_hub "$role"; then
    # ssh-call.mjs exits 254 with this marker written when the call is
    # plain ssh's to make, before it has read any of its input: then ssh
    # runs here, from bash, exactly as without the helper. A remote
    # command's own 254 leaves no marker.
    fb="$RUN_DIR/ssh-fb.$BASHPID"
    rm -f "$fb"
    # No path conversion: Git Bash would otherwise rewrite a remote
    # command that starts with /dev/shm into a Windows path.
    FLEET_CALL_FB="$FLEET_FB_DIR/ssh-fb.$BASHPID" MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node "$FLEET_CALL_JS" "$@"
    rc=$?
    if [[ $rc == 254 && -e "$fb" ]]; then
      rm -f "$fb"
      [[ -n "${FLEET_SSH_CONNS:-}" ]] && echo "${CURRENT_STEP:-run}" >>"$RUN_DIR/ssh-conns"
      ssh "$@"
      rc=$?
    fi
  else
    [[ "$FLEET_TRANSPORT" == hub ]] && echo "${CURRENT_STEP:-run}" >>"$RUN_DIR/ssh-conns"
    ssh "$@"
    rc=$?
  fi
  # FLEET_SSH_STATS=<file>: how long each call took, end to end, to
  # compare the two transports on a real host.
  [[ -n "${FLEET_SSH_STATS:-}" && -n "$t0" ]] && echo "call $FLEET_TRANSPORT ${CURRENT_STEP:-run} $(((${EPOCHREALTIME/./} - ${t0/./}) / 1000)) ms rc=$rc" >>"$FLEET_SSH_STATS"
  return $rc
}

# rdrop <role>: the helper closes its connection to that host. Before a
# reboot: the next call then makes a new connection to the new boot
# instead of waiting on one that died without a word.
rdrop() {
  dry && return 0
  [[ -n "${FLEET_HUB_PORT:-}" ]] && transport_role_on_hub "$1" || return 0
  # shellcheck disable=SC2046
  FLEET_CALL_FB="$FLEET_FB_DIR/ssh-fb.$BASHPID" MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node "$FLEET_CALL_JS" --drop -i "$(role_key "$1")" "${SSH_BASE[@]}" $(role_ssh_opts "$1") "root@$(role_addr "$1")" >/dev/null 2>&1 || true
}

# transport_start: once per run, before the first remote call.
transport_start() {
  local why="" bin token portf i runpid
  dry && return 0
  FLEET_TRANSPORT=ssh
  FLEET_SSH_CALLS="$RUN_DIR/ssh-calls"
  FLEET_SSH_CONNS="$(native_path "$RUN_DIR/ssh-conns")"
  : >>"$RUN_DIR/ssh-calls"
  : >>"$RUN_DIR/ssh-conns"
  export FLEET_SSH_CALLS FLEET_SSH_CONNS
  TRANSPORT_C0=0 TRANSPORT_N0=0
  if [[ "${FLEET_SSH:-hub}" == ssh ]]; then
    why="FLEET_SSH=ssh"
  elif ! command -v node >/dev/null 2>&1; then
    why="node is not on PATH"
  elif [[ ! -f "$FLEET_DIR/node_modules/ssh2/package.json" ]]; then
    why="the SSH library is not installed (run: npm ci --prefix scripts/fleet --omit=optional --ignore-scripts)"
  elif [[ "$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$FLEET_DIR/node_modules/ssh2/package.json" | head -1)" != "$(sed -n 's/^ *"ssh2": *"\([^"]*\)".*/\1/p' "$FLEET_DIR/package.json" | head -1)" ]]; then
    # It holds the root keys: only the version package-lock.json pins.
    why="the SSH library installed is not the version package.json pins (run: npm ci --prefix scripts/fleet --omit=optional --ignore-scripts)"
  else
    # The same ssh this shell would run, for the helper's fallback and
    # its `ssh -G` and `ssh-keygen -F` lookups.
    bin="$(command -v ssh)"
    [[ -f "$bin.exe" ]] && bin="$bin.exe"
    FLEET_SSH_BIN="$(native_path "$bin")"
    FLEET_CALL_JS="$(native_path "$FLEET_DIR/lib/ssh-call.mjs")"
    FLEET_FB_DIR="$(native_path "$RUN_DIR")"
    token="$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n')"
    portf="$RUN_DIR/ssh-hub.port"
    rm -f "$portf"
    if [[ ${#token} -ne 64 ]]; then
      why="no random token (/dev/urandom)"
    else
      # Its standard input is this pipe: when this run ends, however it
      # ends, the pipe closes and the helper stops.
      # Its own check on the run: this shell's process id, as Windows
      # knows it under Git Bash.
      runpid=$$
      [[ -r /proc/$$/winpid ]] && runpid="$(cat /proc/$$/winpid)"
      exec {FLEET_HUB_FD}> >(FLEET_RUN_PID="$runpid" FLEET_HUB_TOKEN="$token" FLEET_SSH_BIN="$FLEET_SSH_BIN" exec node "$(native_path "$FLEET_DIR/lib/ssh-hub.mjs")" "$(native_path "$portf")" "$FLEET_SSH_CONNS" >/dev/null 2>>"$RUN_DIR/ssh-hub.log")
      FLEET_HUB_PID=$!
      for ((i = 0; i < 100; i++)); do
        [[ -s "$portf" ]] && break
        sleep 0.05
      done
      FLEET_HUB_PORT="$(head -1 "$portf" 2>/dev/null)"
      FLEET_HUB_WINPID="$(sed -n 2p "$portf" 2>/dev/null)"
      if [[ "$FLEET_HUB_PORT" =~ ^[0-9]+$ ]]; then
        FLEET_HUB_TOKEN="$token"
        FLEET_TRANSPORT=hub
        export FLEET_HUB_PORT FLEET_HUB_TOKEN FLEET_SSH_BIN
      else
        FLEET_HUB_PORT=""
        why="the helper did not start in 5 s (its log: $RUN_DIR/ssh-hub.log)"
        transport_stop quiet
      fi
    fi
  fi
  if [[ "$FLEET_TRANSPORT" == hub ]]; then
    log_line "TRANSPORT hub: one SSH connection per host for this pass (lib/ssh-hub.mjs); FLEET_SSH=ssh for one per call; the inside boxes $(transport_role_on_hub relay && echo "on it too (FLEET_HUB_INSIDE=1)" || echo "over plain ssh (FLEET_HUB_INSIDE=1 puts them on it)")"
  else
    log_line "TRANSPORT ssh: one SSH connection per remote call ($why)"
    [[ "$why" == FLEET_SSH=ssh ]] || echo "Remote calls go over plain ssh, one connection each: $why" >&2
  fi
}

# transport_stop: the helper's connections closed and the helper gone.
# Run at the end of every pass, after cleanup_hosts (which still uses it).
transport_stop() {
  local i n=0 c=0
  if [[ -n "${FLEET_HUB_FD:-}" ]]; then
    exec {FLEET_HUB_FD}>&-
    # It removes its port file as it stops.
    for ((i = 0; i < 60; i++)); do
      [[ -e "$RUN_DIR/ssh-hub.port" ]] || break
      sleep 0.05
    done
    if [[ -e "$RUN_DIR/ssh-hub.port" && "${FLEET_HUB_WINPID:-}" =~ ^[0-9]+$ ]]; then
      if command -v taskkill >/dev/null 2>&1; then taskkill //F //PID "$FLEET_HUB_WINPID" >/dev/null 2>&1; else kill "$FLEET_HUB_WINPID" 2>/dev/null; fi
      rm -f "$RUN_DIR/ssh-hub.port"
    fi
    kill "$FLEET_HUB_PID" 2>/dev/null || true
    unset FLEET_HUB_FD
  fi
  FLEET_HUB_PORT="" FLEET_HUB_TOKEN=""
  unset FLEET_HUB_PORT FLEET_HUB_TOKEN
  [[ "${1:-}" == quiet || -z "${RUN_DIR:-}" ]] && return 0
  transport_count "$RUN_DIR/ssh-calls" n
  transport_count "$RUN_DIR/ssh-conns" c
  [[ "$FLEET_TRANSPORT" == ssh ]] && c=$n
  ((n > 0)) && log_line "TRANSPORT-END $FLEET_TRANSPORT: $n remote calls over $c new connections"
  [[ -n "${FLEET_SSH_STATS:-}" ]] && echo "transport=$FLEET_TRANSPORT calls=$n connections=$c" >>"$FLEET_SSH_STATS"
  # A run whose directory is thrown away (status) keeps the helper's log
  # there too, when asked (it names no host and no command).
  [[ -n "${FLEET_SSH_STATS:-}" && -s "$RUN_DIR/ssh-hub.log" ]] && cat "$RUN_DIR/ssh-hub.log" >>"$FLEET_SSH_STATS"
  return 0
}

# transport_count <file> <variable>: its number of lines, without a fork.
transport_count() {
  local -a l=()
  local -n out="$2"
  [[ -f "$1" ]] && mapfile -t l <"$1"
  out=${#l[@]}
}

# Called by the engine around each step: the calls and new connections
# the step made, for the run log and the "took" line.
transport_step_begin() {
  [[ -n "${FLEET_SSH_CALLS:-}" ]] || return 0
  transport_count "$RUN_DIR/ssh-calls" TRANSPORT_C0
  transport_count "$RUN_DIR/ssh-conns" TRANSPORT_N0
}
transport_step_end() {
  local n c
  TRANSPORT_NOTE=""
  [[ -n "${FLEET_SSH_CALLS:-}" ]] || return 0
  transport_count "$RUN_DIR/ssh-calls" n
  transport_count "$RUN_DIR/ssh-conns" c
  n=$((n - ${TRANSPORT_C0:-0}))
  c=$((c - ${TRANSPORT_N0:-0}))
  [[ "$FLEET_TRANSPORT" == ssh ]] && c=$n
  ((n > 0)) || return 0
  local cs=s ns=s
  [[ $n == 1 ]] && cs=""
  [[ $c == 1 ]] && ns=""
  log_line "CALLS $1 $FLEET_TRANSPORT: $n remote call$cs, $c new connection$ns"
  TRANSPORT_NOTE=" ($n remote call$cs, $c new SSH connection$ns)"
}

# each_at_once <max> <dir> <function> <item>...: "<function> <item>" for
# every item, at most <max> at a time, each in its own subshell. Item k
# (from 0) leaves its standard output in <dir>/k.out, its standard error
# in <dir>/k.err and its status in <dir>/k.rc (none if it died: at_rc
# then says 1). Returns once all have ended. For the same work on several
# independent hosts inside one step, and for tunnels on one host.
#
# The callers read the results back in the items' order and decide from
# them in this shell, so a step prints what it printed before, in the
# same order, and only this shell writes the state file (two subshells
# rewriting it at once would lose a value). Under --dry-run they run one
# after another, unredirected, so the dry output keeps its order.
each_at_once() {
  local max="$1" dir="$2" fn="$3" it k=0
  local -a pids=()
  shift 3
  if dry; then
    for it in "$@"; do "$fn" "$it"; done
    return 0
  fi
  rm -rf "$dir"
  mkdir -p "$dir"
  for it in "$@"; do
    # shellcheck disable=SC2030
    ("$fn" "$it" >"$dir/$k.out" 2>"$dir/$k.err"; echo $? >"$dir/$k.rc") &
    pids+=($!)
    k=$((k + 1))
    if ((${#pids[@]} >= max)); then
      wait "${pids[@]}"
      pids=()
    fi
  done
  ((${#pids[@]} == 0)) || wait "${pids[@]}"
  return 0
}
at_out() { cat "$1/$2.out" 2>/dev/null; }
at_rc() { local r; r="$(cat "$1/$2.rc" 2>/dev/null)"; echo "${r:-1}"; }
# at_show <dir> <k>: item k's output as it would have appeared.
at_show() {
  cat "$1/$2.out" 2>/dev/null
  cat "$1/$2.err" >&2 2>/dev/null
  return 0
}

# used <role>: this run reached that host, so cleanup_hosts goes there.
# Kept in a file: steps run on the left of a pipe.
used() {
  [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]] || return 0
  grep -qxF -- "$1" "$RUN_DIR/hosts-used" 2>/dev/null || echo "$1" >>"$RUN_DIR/hosts-used"
}

# rsh <role> <command string>
rsh() {
  local role="$1" cmd="$2"
  if dry; then
    echo "ssh <$(role_label "$role")> \$ $cmd" >&2
    return 0
  fi
  used "$role"
  # -n: ssh must not read this script's stdin. Inside a `while read`
  # loop it would swallow the rest of the loop's input.
  # shellcheck disable=SC2046,SC2029
  fssh "$role" -n -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "$cmd"
}

# rpipe <role> <command string>: like rsh, but the command reads what is
# piped in here. This is how a credential crosses from one host to
# another: through a pipe on this PC, never onto its screen or disk.
rpipe() {
  local role="$1" cmd="$2"
  if dry; then
    echo "(piped) ssh <$(role_label "$role")> \$ $cmd" >&2
    return 0
  fi
  used "$role"
  # shellcheck disable=SC2046,SC2029
  fssh "$role" -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "$cmd"
}

# rsh_to <role> <command> <role> <command>: what the first host prints is
# what the second one reads, through a pipe on this PC and nowhere else.
# Under --dry-run the two are said one after the other. Left as a pipe
# there, each side printed its own line when it happened to start, and
# the order of a dry run's output changed from one run to the next.
rsh_to() {
  if dry; then
    rsh "$1" "$2"
    rpipe "$3" "$4"
    return 0
  fi
  rsh "$1" "$2" | rpipe "$3" "$4"
}

# lrun <command...>: something run on this PC that reaches out by itself
# (the repository's own maintenance scripts).
lrun() {
  if dry; then
    local shown="$*"
    echo "local \$ ${shown//"$REPO_ROOT"\//}" >&2
    return 0
  fi
  "$@"
}

expect() {
  if dry; then say "expect: $*"; fi
  return 0
}

# rput <role> <local file> <remote path> [mode]
rput() {
  local role="$1" src="$2" dst="$3" mode="${4:-600}"
  if dry; then
    src="${src#"$REPO_ROOT"/}"
    echo "copy ${src#"$RUN_DIR"/} -> <$(role_label "$role")>:$dst (mode $mode)" >&2
    return 0
  fi
  used "$role"
  [[ -f "$src" ]] || die "nothing to copy: $src"
  # shellcheck disable=SC2046
  fssh "$role" -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" \
    "umask 077; mkdir -p '$(dirname "$dst")'; cat > '$dst' && chmod $mode '$dst'" <"$src"
}

# rget <role> <remote path> <local file>: for files that hold addresses,
# which stay in the run directory and are never printed.
rget() {
  local role="$1" src="$2" dst="$3"
  if dry; then
    echo "fetch <$(role_label "$role")>:$src -> run directory" >&2
    return 0
  fi
  used "$role"
  # shellcheck disable=SC2046,SC2029
  fssh "$role" -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "cat '$src'" >"$dst"
}

# rpushdir <role> <dir under remote/>: that directory and remote/common,
# flat, into the scratch directory. A tar from Windows carries this PC's
# uid and no execute bits, hence the two fixes on the far side.
rpushdir() {
  local role="$1" dir="$2"
  if dry; then
    echo "copy remote/$dir/* and remote/common/* -> <$(role_label "$role")>:$REMOTE_DIR/" >&2
    return 0
  fi
  used "$role"
  # shellcheck disable=SC2046
  tar -C "$FLEET_DIR/remote" -cf - "$dir" common |
    fssh "$role" -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" \
      "umask 077; mkdir -p $REMOTE_DIR && tar --no-same-owner --strip-components=1 -xf - -C $REMOTE_DIR && chmod 700 $REMOTE_DIR/*.sh $REMOTE_DIR/*.py 2>/dev/null; true"
}

# rscript <role> <dir/script under remote/> [args...]
# Copied over and run as a file. Never `ssh host bash -s < script`: when
# the script calls `docker exec -i`, the container eats the rest of it.
#
# One remote call, where it used to be two (rpushdir, then rsh): the
# scripts go over on the call's standard input, and the script then runs
# with standard input from /dev/null, as under rsh -n -- never the rest
# of the tar stream. The unpack keeps rpushdir's umask 077 in a subshell,
# so the script runs with the shell's usual umask, as before. A failed
# unpack runs nothing: an older copy of the script may be there.
rscript() {
  local role="$1" rel="$2" q=""
  shift 2
  if [[ $# -gt 0 ]]; then q="$(printf ' %q' "$@")"; fi
  if dry; then
    rpushdir "$role" "${rel%%/*}"
    rsh "$role" "${RENV:-}$REMOTE_DIR/${rel#*/}$q"
    return 0
  fi
  used "$role"
  # shellcheck disable=SC2046
  tar -C "$FLEET_DIR/remote" -cf - "${rel%%/*}" common |
    fssh "$role" -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" \
      "(umask 077; mkdir -p $REMOTE_DIR && tar --no-same-owner --strip-components=1 -xf - -C $REMOTE_DIR) || { echo 'fleet: the scripts could not be unpacked on this host' >&2; exit 1; }; chmod 700 $REMOTE_DIR/*.sh $REMOTE_DIR/*.py 2>/dev/null; ${RENV:-}$REMOTE_DIR/${rel#*/}$q </dev/null"
}

# rclean <role> [keep]: shred what a run left in the scratch directory.
# With "keep", the panel host's record of temporary test users stays
# (temp/): a step that stopped with test users still in some Xray needs
# their emails to take them out on the next pass. The tunnel test's port
# lock is removed too, once nothing holds it (it used to be left in
# /dev/shm itself, empty, on every host a tunnel was dialled from).
rclean() {
  local keep="${2:-}" find_args="-type f"
  [[ "$keep" == keep ]] && find_args="-path $REMOTE_DIR/temp -prune -o -type f"
  rsh "$1" "if [ -d $REMOTE_DIR ]; then find $REMOTE_DIR $find_args -exec shred -u {} + 2>/dev/null; find $REMOTE_DIR -depth -mindepth 1 -type d ! -path '$REMOTE_DIR/temp*' -exec rmdir {} + 2>/dev/null; [ -d $REMOTE_DIR/temp ] && [ '$keep' = keep ] || rm -rf $REMOTE_DIR; fi; for l in /dev/shm/nx-e2e-port.lock; do [ -e \$l ] && flock -n \$l true 2>/dev/null && rm -f \$l; done; echo scratch-clean"
}

# cleanup_hosts: at the end of every pass, whatever ended it. The admin
# token goes from the panel host and the new box; every host this run
# reached loses its scratch directory, except the panel host's record of
# temporary test users while some may still be in an Xray (rclean keep).
cleanup_host_one() {
  local r="$1" left=""
  if [[ "$r" == panel ]]; then
    left="$(rsh panel "ls $REMOTE_DIR/temp 2>/dev/null | tr '\n' ' '" 2>/dev/null)" || left=""
    if [[ -n "${left// /}" ]]; then
      rclean panel keep >/dev/null 2>&1 && echo "  panel: clean, except the record of temporary test users ($left): the next pass needs it to take them out" || echo "  panel: COULD NOT CLEAN $REMOTE_DIR (look by hand)"
      return 0
    fi
  fi
  if rclean "$r" >/dev/null 2>&1; then echo "  $(role_label "$r"): clean"; else echo "  $(role_label "$r"): COULD NOT CLEAN $REMOTE_DIR (unreachable now? look by hand)"; fi
}
# The hosts are cleaned at once (they are independent), and reported in
# the order this pass first reached them.
cleanup_hosts() {
  local r k
  local -a hosts=()
  dry && return 0
  [[ -n "${RUN_DIR:-}" && -s "$RUN_DIR/hosts-used" ]] || return 0
  echo
  echo "Cleaning up on every host this pass used:"
  while read -r r; do [[ -n "$r" ]] && hosts+=("$r"); done <"$RUN_DIR/hosts-used"
  each_at_once 6 "$RUN_DIR/at-cleanup" cleanup_host_one "${hosts[@]}"
  for k in "${!hosts[@]}"; do at_out "$RUN_DIR/at-cleanup" "$k"; done
  rm -rf "$RUN_DIR/at-cleanup"
  : >"$RUN_DIR/hosts-used"
}

# ---------------------------------------------------------------- database

PSQL_REMOTE="docker exec -i ${PG_CONTAINER:-neoxify-postgres-1} sh -c 'psql -X -q -At -F \"|\" -v ON_ERROR_STOP=1 \"\$@\" -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' sh"

# sql_block <name> -> prints "<mode>" on the first line, then the query.
sql_block() {
  awk -v want="$1" '
    /^-- @@ / { on = ($3 == want); if (on) { mode = $4; gsub(/[()]/, "", mode); print mode; found = 1 } ; next }
    on { print }
    END { if (!found) exit 3 }
  ' "$FLEET_DIR/sql/fleet.sql"
}

# q <query name> [key=value ...]: one named query from sql/fleet.sql,
# with psql variables. Read queries run in a read-only transaction.
# Write queries are refused unless this run has its database dump
# (run_dump): one per run, taken before its first database write.
q() {
  local name="$1" block mode body v vargs=""
  shift
  block="$(sql_block "$name")" || die "no query '$name' in sql/fleet.sql"
  mode="$(head -1 <<<"$block")"
  body="$(tail -n +2 <<<"$block")"
  for v in "$@"; do
    # Under --dry-run a value may be a {placeholder} for something an
    # earlier step would have recorded.
    dry || [[ "$v" =~ ^[a-z_]+=[A-Za-z0-9._:,@/+\ -]*$ ]] || die "query $name: bad variable '$v'"
    vargs+=" -v $(printf '%q' "$v")"
  done
  if dry; then
    echo "panel sql [$mode] $name $*" >&2
    return 0
  fi
  if [[ "$mode" == "write" ]]; then
    state_has run_dump_file || die "query $name writes, and this run has no database dump yet (run_dump)"
  fi
  # One remote call: the query is psql's standard input straight from
  # here, where it used to be copied to a file first (rput, then rsh).
  # Nothing else on that call reads standard input.
  {
    if [[ "$mode" == "write" ]]; then
      printf 'BEGIN;\n%s\nCOMMIT;\n' "$body"
    else
      printf 'BEGIN READ ONLY;\n%s\nCOMMIT;\n' "$body"
    fi
  } | rpipe panel "$PSQL_REMOTE$vargs | grep -vx -e BEGIN -e COMMIT; exit \${PIPESTATUS[0]}"
}

# run_dump <label>: the run's ONE database dump. The first step of a run
# that writes to the database takes it; every later step of the same run
# reuses it and says so (the owner's rule: one dump per job, 2026-11-13;
# the same day a step that dumped unconditionally left a second 62 MB dump
# that the daily prune would have kept in place of the real one).
# --fresh-dump takes a new one, once, at the next step that asks.
run_dump() {
  local label="$1" f
  if dry; then
    say "database dump: the run's one dump (taken here if this run has none yet, else reused)"
    panel_dump "$label"
    return 0
  fi
  f="$(st run_dump_file "")"
  if [[ -n "$f" && "${OPT_FRESH_DUMP:-0}" == 1 && ! -e "$RUN_DIR/fresh-dump-$$" ]]; then
    touch "$RUN_DIR/fresh-dump-$$"
    say "--fresh-dump: a new dump in place of $f"
    f=""
  fi
  if [[ -n "$f" ]]; then
    # A run can be continued days later, and the daily prune keeps only the
    # newest dump of each day: the recorded file may be gone, or old.
    # Look at it on the panel host before trusting it.
    local why
    if why="$(dump_fresh_enough "$f")"; then
      say "database dump: reusing this run's dump $f (taken $(st run_dump_at "?"), $why); --fresh-dump takes a new one"
      undo "restore the rows this step changes from $f"
      return 0
    fi
    say "database dump: this run's dump $f cannot be reused ($why); taking a new one"
    log_line "DUMP-STALE $f ($why): a new dump taken"
  fi
  panel_dump "$label" || return 1
  state_set run_dump_file "$(st last_dump_file)"
  state_set run_dump_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$(st last_dump_file)" >"$RUN_DIR/dump.txt"
}

# How old a dump a step may lean on (seconds). A run continued the next
# day takes a new one.
DUMP_MAX_AGE_S="${DUMP_MAX_AGE_S:-14400}"

# dump_stat <file>: "<size> <mtime>" of a dump on the panel host, or a
# failure when it is missing or not a whole gzip file.
dump_stat() {
  local out
  out="$(rsh panel "gzip -t '$1' && stat -c '%s %Y' '$1'")" || return 1
  [[ "$out" =~ ^[0-9]+[[:space:]][0-9]+$ ]] || return 1
  echo "$out"
}

# dump_fresh_enough <file>: succeeds, printing its age, when the dump is
# on the panel host, whole, the size of a dump and younger than
# DUMP_MAX_AGE_S; otherwise fails, printing why.
dump_fresh_enough() {
  local out age
  out="$(dump_stat "$1")" || { echo "not on the panel host, or not a whole gzip file"; return 1; }
  ((${out%% *} > 1000000)) || { echo "too small to be a dump"; return 1; }
  age=$(($(date +%s) - ${out#* }))
  ((age <= DUMP_MAX_AGE_S)) || { echo "$((age / 60)) minutes old, more than $((DUMP_MAX_AGE_S / 3600)) hours"; return 1; }
  echo "$((age / 60)) minutes old, gzip -t ok"
}

# use_dump_given: --use-dump <file>, a dump this job already took (say,
# at the start of a session). Checked on the panel host and recorded as
# this run's one dump.
use_dump_given() {
  local f="${OPT_USE_DUMP:-}" out
  [[ -n "$f" ]] || return 0
  [[ "$f" =~ ^/root/db-backups/[A-Za-z0-9._-]+\.sql\.gz$ ]] || { echo "fleet: --use-dump must name a file in /root/db-backups/ ending .sql.gz" >&2; return 1; }
  out="$(dump_stat "$f")" || { echo "fleet: --use-dump: $f is not a good gzip file on the panel host" >&2; return 1; }
  ((${out%% *} > 1000000)) || { echo "fleet: --use-dump: $f is too small to be a dump" >&2; return 1; }
  local age=$(($(date +%s) - ${out#* }))
  ((age <= DUMP_MAX_AGE_S)) || { echo "fleet: --use-dump: $f is $((age / 60)) minutes old (more than $((DUMP_MAX_AGE_S / 3600)) hours); leave --use-dump off and the run takes a new one" >&2; return 1; }
  state_set run_dump_file "$f"
  state_set last_dump_file "$f"
  state_set last_dump "${out#* }"
  state_set run_dump_at "$(date -u -d "@${out#* }" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo given)"
  echo "$f" >"$RUN_DIR/dump.txt"
  log_line "DUMP $f (--use-dump: this job's dump, no new one taken)"
  echo "This run's database dump: $f (--use-dump, gzip -t ok)"
}

# panel_dump <label>: a dump before a write phase, checked with gzip -t.
# Steps call run_dump, never this.
panel_dump() {
  local label="$1" out
  out="$(rsh panel "set -o pipefail; mkdir -p /root/db-backups; TS=\$(date -u +%Y%m%dT%H%M%SZ); F=/root/db-backups/$label-\$TS.sql.gz; docker exec ${PG_CONTAINER:-neoxify-postgres-1} sh -c 'pg_dump -U \"\$POSTGRES_USER\" --exclude-table-data=site_visits \"\$POSTGRES_DB\"' | gzip > \$F && gzip -t \$F && stat -c '%s %n' \$F")" || return 1
  dry && return 0
  local size="${out%% *}" file="${out#* }"
  [[ "$size" =~ ^[0-9]+$ ]] && ((size > 1000000)) || { say "dump looks wrong: '$out'"; return 1; }
  state_set last_dump "$(date +%s)"
  state_set last_dump_file "$file"
  say "database dump: $file ($((size / 1048576)) MB, gzip -t ok)"
  undo "restore the rows this step changes from $file"
}

# ---------------------------------------------------------------- panel API

TOKEN_FILE="$REMOTE_DIR/admin-token"
PANEL_ENV="NX_TOKEN_FILE=$TOKEN_FILE NX_API=${PANEL_LOCAL_API:-http://127.0.0.1:4000} NX_PG=${PG_CONTAINER:-neoxify-postgres-1} NX_BACKEND=${BACKEND_CONTAINER:-neoxify-backend-1} NX_HEALTH=https://${PANEL_ORIGIN_NAME:-}/api "

# A 15-minute admin token, minted inside the backend container, kept in
# RAM on the panel host and never shown. Minted fresh before each use.
panel_mint() {
  RENV="$PANEL_ENV" rscript panel panel/nx-mint.sh "$TOKEN_FILE"
}

# pscript <script under remote/panel> [args]: a panel helper, with the
# token file and API address in its environment.
pscript() {
  local rel="$1"
  shift
  RENV="$PANEL_ENV" rscript panel "panel/$rel" "$@"
}

panel_token_shred() { rsh panel "shred -u $TOKEN_FILE 2>/dev/null; rm -f $TOKEN_FILE; test ! -e $TOKEN_FILE && echo token-gone"; }

# ---------------------------------------------------------------- lookups

# node_field <name> <column>: one column of one node. Columns are named,
# never `*`: several tables carry encrypted credential blobs.
node_field() {
  case "$2" in id | publicIp | status | role | region | agentVersion | mirrorHost | realityDest) ;; *) die "node_field: column $2 is not allowed" ;; esac
  if dry; then
    echo "{$1.$2}"
    echo "panel sql [read] node-field name=$1 col=$2" >&2
    return 0
  fi
  q node-field "name=$1" "col=$2"
}

# heartbeats_baseline: remember which servers are ONLINE before a pass
# that could disturb them.
heartbeats_baseline() {
  local names
  names="$(q online-names)" || return 1
  dry && return 0
  state_set hb_baseline "$names"
  say "online before: $names"
}

# heartbeats_fresh [server to leave out]: every server that was ONLINE at
# the baseline is still ONLINE and has reported in the last 90 seconds.
# Checked after every plan edit: a long edit once starved the backend,
# which closed one agent's stream without a word, and that server sat
# silent for an hour.
heartbeats_fresh() {
  local out try skip="${1:-}" base missing
  base="$(state_get hb_baseline "")"
  # Two minutes, as when it asked every 15 s: a question now costs a
  # round trip, not a new connection, so it asks every 3 s.
  for try in $(seq 1 40); do
    out="$(q heartbeats)" || return 1
    dry && return 0
    missing="$(awk -F'|' -v base="$base" -v skip="$skip" '
      BEGIN { n = split(base, b, ","); for (i = 1; i <= n; i++) want[b[i]] = 1; delete want[skip]; delete want[""] }
      ($1 in want) && $2 == "ONLINE" && $3 != "" && $3 <= 90 { delete want[$1] }
      END { for (k in want) printf "%s ", k }' <<<"$out")"
    if [[ -z "$missing" ]]; then
      say "heartbeats fresh on every server that was online"
      return 0
    fi
    sleep 3
  done
  say "not reporting (was online before, try $try): $missing"
  return 1
}

tool() { node "$FLEET_DIR/lib/tool.mjs" "$@"; }
cf() {
  if dry; then
    echo "cloudflare $*" >&2
    return 0
  fi
  CF_TOKEN_FILE="$CF_TOKEN_FILE" node "$FLEET_DIR/lib/cf.mjs" "$@"
}
