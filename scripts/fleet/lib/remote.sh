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

# rsh <role> <command string>
rsh() {
  local role="$1" cmd="$2"
  if dry; then
    echo "ssh <$(role_label "$role")> \$ $cmd" >&2
    return 0
  fi
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
  # shellcheck disable=SC2046,SC2029
  ssh -i "$(role_key "$role")" "${SSH_BASE[@]}" $(role_ssh_opts "$role") "root@$(role_addr "$role")" "$cmd"
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

# rclean <role>: shred what a run left in the scratch directory.
rclean() {
  rsh "$1" "if [ -d $REMOTE_DIR ]; then find $REMOTE_DIR -type f -exec shred -u {} + 2>/dev/null; rm -rf $REMOTE_DIR; fi; echo scratch-clean"
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
# Write queries are refused unless this run dumped the database in the
# last half hour.
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
    local at now
    at="$(state_get last_dump 0)"
    now="$(date +%s)"
    ((now - at < 1800)) || die "query $name writes, and this run has no database dump from the last 30 minutes"
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

# panel_dump <label>: a dump before a write phase, checked with gzip -t.
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
