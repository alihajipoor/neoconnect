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
  ssh -n -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "$cmd"
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
  ssh -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "$cmd"
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
  ssh -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" \
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
  ssh -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "cat '$src'" >"$dst"
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
    ssh -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" \
      "umask 077; mkdir -p $REMOTE_DIR && tar --no-same-owner --strip-components=1 -xf - -C $REMOTE_DIR && chmod 700 $REMOTE_DIR/*.sh $REMOTE_DIR/*.py 2>/dev/null; true"
}

# rscript <role> <dir/script under remote/> [args...]
# Copied over and run as a file. Never `ssh host bash -s < script`: when
# the script calls `docker exec -i`, the container eats the rest of it.
rscript() {
  local role="$1" rel="$2" q=""
  shift 2
  rpushdir "$role" "${rel%%/*}" || return 1
  if [[ $# -gt 0 ]]; then q="$(printf ' %q' "$@")"; fi
  rsh "$role" "${RENV:-}$REMOTE_DIR/${rel#*/}$q"
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
cleanup_hosts() {
  local r left=""
  dry && return 0
  [[ -n "${RUN_DIR:-}" && -s "$RUN_DIR/hosts-used" ]] || return 0
  echo
  echo "Cleaning up on every host this pass used:"
  while read -r r; do
    [[ -n "$r" ]] || continue
    if [[ "$r" == panel ]]; then
      left="$(rsh panel "ls $REMOTE_DIR/temp 2>/dev/null | tr '\n' ' '" 2>/dev/null)" || left=""
      if [[ -n "${left// /}" ]]; then
        rclean panel keep >/dev/null 2>&1 && echo "  panel: clean, except the record of temporary test users ($left): the next pass needs it to take them out" || echo "  panel: COULD NOT CLEAN $REMOTE_DIR (look by hand)"
        continue
      fi
    fi
    if rclean "$r" >/dev/null 2>&1; then echo "  $(role_label "$r"): clean"; else echo "  $(role_label "$r"): COULD NOT CLEAN $REMOTE_DIR (unreachable now? look by hand)"; fi
  done <"$RUN_DIR/hosts-used"
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
  local name="$1" block mode body v vargs="" tmp
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
  tmp="$RUN_DIR/q-$$.sql"
  if [[ "$mode" == "write" ]]; then
    printf 'BEGIN;\n%s\nCOMMIT;\n' "$body" >"$tmp"
  else
    printf 'BEGIN READ ONLY;\n%s\nCOMMIT;\n' "$body" >"$tmp"
  fi
  rput panel "$tmp" "$REMOTE_DIR/q-$$.sql" 600 || return 1
  rm -f "$tmp"
  rsh panel "$PSQL_REMOTE$vargs < $REMOTE_DIR/q-$$.sql | grep -vx -e BEGIN -e COMMIT; rc=\${PIPESTATUS[0]}; rm -f $REMOTE_DIR/q-$$.sql; exit \$rc"
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
    say "database dump: reusing this run's dump $f (taken $(st run_dump_at "?")); --fresh-dump takes a new one"
    undo "restore the rows this step changes from $f"
    return 0
  fi
  panel_dump "$label" || return 1
  state_set run_dump_file "$(st last_dump_file)"
  state_set run_dump_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$(st last_dump_file)" >"$RUN_DIR/dump.txt"
}

# use_dump_given: --use-dump <file>, a dump this job already took (say,
# at the start of a session). Checked on the panel host and recorded as
# this run's one dump.
use_dump_given() {
  local f="${OPT_USE_DUMP:-}" out
  [[ -n "$f" ]] || return 0
  [[ "$f" =~ ^/root/db-backups/[A-Za-z0-9._-]+\.sql\.gz$ ]] || { echo "fleet: --use-dump must name a file in /root/db-backups/ ending .sql.gz" >&2; return 1; }
  out="$(rsh panel "gzip -t '$f' && stat -c '%s %Y' '$f'")" || { echo "fleet: --use-dump: $f is not a good gzip file on the panel host" >&2; return 1; }
  ((${out%% *} > 1000000)) || { echo "fleet: --use-dump: $f is too small to be a dump" >&2; return 1; }
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
  for try in 1 2 3 4 5 6 7 8; do
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
    sleep 15
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
