#!/usr/bin/env bash
# Fails when the rule that stops Neoxify splitting one game across two
# exits stops being enforced.
#
# The rule, stated once: **a game's binaries go to one exit, or to none.**
#
# A game is routinely several executables and the split is systematic --
# an anti-cheat wrapper or a launcher starts, then spawns the game. Rust
# is `Rust.exe` (the EAC wrapper Steam launches) plus `RustClient.exe`.
# Sea of Thieves is `SeaOfThieves.exe` plus `SoTGame.exe`. VALORANT is
# the Riot client, the game, and Vanguard's `vgc.exe` and `vgm.exe`.
# Per-game exit preferences are keyed on the EXECUTABLE, so without
# something holding a game's binaries together nothing at all guarantees
# they name the same exit -- and one account's connections arriving from
# two source addresses at the same instant is the account-sharing
# signature publishers look for. See docs/design/ban-safety.md, "The
# two-source-IP split", and docs/design/per-game-exits.md section 5.
#
# This is the same failure shape as check-prefix-completeness.sh, which
# guards the OTHER route to the identical outcome: there, a partial
# prefix list splits a game by destination; here, a partial group splits
# it by egress. Both cost a customer their game account rather than a
# feature, and the owner has been explicit that a Gaming Mode which gets
# players banned is worse than no Gaming Mode at all.
#
# Six invariants, all offline, no network, no database:
#
#   1. game-apps.ts     -- `exitsForGames` exists and is the only
#      producer of an AppExit. It withholds a group that is not whole
#      and withholds both sides of a conflict.
#   2. split-tunnel.ts  -- the persisted settings carry `games`
#      (the groups) and NO per-application exit field. A customer cannot
#      hand-build a split because there is nowhere to write one.
#   3. split-tunnel.ts  -- `pushSplitTunnel` derives `exits` only from
#      `exitsForGames`. Everything above is bypassed if the wire is
#      filled in from somewhere else.
#   4. ipc/src/lib.rs   -- `AppExit` still carries `group`, and
#      `validate` still refuses a config that puts one game on two
#      exits. That is the trust boundary, and it must refuse rather
#      than assume the sender is us.
#   5. owner.rs         -- `Selection::with_exits` still drops a group
#      whose members are not all selected. The service holds the rule
#      independently of the client.
#   6. curated.json     -- the multi-binary games still list both halves
#      in one row. A row IS the group, so an entry that loses half of
#      itself silently returns that game to being splittable.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLIENT_RULE="apps/desktop-windows/src/lib/game-apps.ts"
CLIENT_WIRE="apps/desktop-windows/src/lib/split-tunnel.ts"
IPC="apps/desktop-windows/ipc/src/lib.rs"
SERVICE="apps/desktop-windows/service/src/split_tunnel/owner.rs"
CATALOGUE="apps/backend/prisma/catalogue/curated.json"

for f in "$CLIENT_RULE" "$CLIENT_WIRE" "$IPC" "$SERVICE" "$CATALOGUE"; do
  [ -f "$f" ] || { echo "check-exit-groups: missing $f" >&2; exit 1; }
done

status=0

fail() {
  echo "check-exit-groups: $1" >&2
  shift
  for line in "$@"; do echo "  $line" >&2; done
  echo "" >&2
  status=1
}

# --- 1. the client rule ----------------------------------------------------

rule=$(sed -n '/^export function exitsForGames/,/^}/p' "$CLIENT_RULE")
if [ -z "$rule" ]; then
  fail "exitsForGames is gone from $CLIENT_RULE." \
    "That function is the only thing that turns a customer's per-game" \
    "choice into per-application wire entries, and the only place the" \
    "all-or-nothing rule lives on this side. If it moved, point this" \
    "check at it."
else
  if ! grep -q 'unresolvedNames(group, apps)' <<< "$rule"; then
    fail "exitsForGames in $CLIENT_RULE no longer asks which of a game's" \
      "executables are missing." \
      "" \
      "A group is routinely PART-present: names resolve against running" \
      "processes, so a launcher can be up while the game is not. Placing" \
      "the half that was found and hoping the rest follows is the split."
  fi
  if ! grep -qE 'reason: "partial"' <<< "$rule"; then
    fail "exitsForGames in $CLIENT_RULE no longer withholds a partial group." \
      "" \
      "The honest outcome for a group that cannot be placed coherently is" \
      "NO per-game exit: the game rides the session's exit like everything" \
      "else, which is safe. Fail toward that, never toward a split."
  fi
  if ! grep -qE 'reason: "conflict"' <<< "$rule"; then
    fail "exitsForGames in $CLIENT_RULE no longer withholds a conflicting group." \
      "" \
      "61 executable names in the shipped catalogue belong to more than one" \
      "game -- vgc.exe and RiotClientServices.exe are in both Riot titles." \
      "Honouring one of two disagreeing games places the shared binary away" \
      "from the other game that also runs it, which is the same split."
  fi
fi

# --- 2. no per-application exit anywhere in the persisted state ------------

settings=$(sed -n '/^export type SplitTunnelSettings/,/^};/p' "$CLIENT_WIRE")
if [ -z "$settings" ]; then
  fail "SplitTunnelSettings is gone from $CLIENT_WIRE."
else
  if ! grep -qE '^\s*games: GameExitGroup\[\];' <<< "$settings"; then
    fail "SplitTunnelSettings in $CLIENT_WIRE no longer carries the game groups." \
      "" \
      "Without them, a game's paths are flattened into one undifferentiated" \
      "'apps' list and nothing knows which binaries belong together any" \
      "more -- which is the state this whole guard exists to leave behind."
  fi
  if grep -qE '^\s*exits\s*:' <<< "$settings"; then
    fail "SplitTunnelSettings in $CLIENT_WIRE has grown a per-application" \
      "exit field." \
      "" \
      "An exit belongs to a GAME. A field that can hold one per application" \
      "is a field in which a customer can put Rust.exe and RustClient.exe on" \
      "two different exits, and no warning covers a state the app persists." \
      "Keep the exit on GameExitGroup, where a split is unrepresentable."
  fi
fi

# --- 3. the wire is derived, not stored ------------------------------------

push=$(sed -n '/^export async function pushSplitTunnel/,/^}/p' "$CLIENT_WIRE")
if [ -z "$push" ]; then
  fail "pushSplitTunnel is gone from $CLIENT_WIRE."
elif ! grep -q 'exits: exitsForGames(settings.games, settings.apps).exits' <<< "$push"; then
  fail "pushSplitTunnel in $CLIENT_WIRE no longer derives 'exits' from" \
    "exitsForGames." \
    "" \
    "Every rule in game-apps.ts is bypassed the moment the wire is filled" \
    "in from anywhere else. This is the last line before the service."
fi

# --- 4. the trust boundary -------------------------------------------------

if ! grep -qE '^\s*pub group: Option<String>,' "$IPC"; then
  fail "AppExit in $IPC no longer carries a group." \
    "" \
    "Without it the protocol cannot tell a config that places a whole game" \
    "from one that places its launcher and leaves its client behind, and" \
    "the service has nothing to hold the all-or-nothing rule against."
fi

validate=$(sed -n '/impl SplitTunnelConfig {/,/^}/p' "$IPC")
if ! grep -q 'puts one game on two exits' <<< "$validate"; then
  fail "SplitTunnelConfig::validate in $IPC no longer refuses a config that" \
    "puts one game on two exits." \
    "" \
    "This is the trust boundary. A config naming two exits for one group is" \
    "not merely unsatisfiable -- it is self-contradictory, no live egress" \
    "present or future satisfies it, and honouring any part of it is the" \
    "account-sharing signature. Refuse it; do not assume the sender is us."
fi
if ! grep -q 'puts one application on two exits' <<< "$validate"; then
  fail "SplitTunnelConfig::validate in $IPC no longer refuses one" \
    "application named twice with two exits." \
    "" \
    "The same contradiction with the group filed off. A hand-written config" \
    "can express it, and one executable cannot leave from two places."
fi

# --- 5. the service holds the rule on its own ------------------------------

with_exits=$(awk '/pub fn with_exits/{f=1} f{print} f&&/^    }$/{exit}' "$SERVICE")
if [ -z "$with_exits" ]; then
  fail "Selection::with_exits is gone from $SERVICE." \
    "That constructor is where the service decides whether a preference" \
    "survives at all. If it moved, point this check at it."
else
  if ! grep -q 'broken' <<< "$with_exits"; then
    fail "Selection::with_exits in $SERVICE no longer tracks groups it" \
      "cannot honour whole." \
      "" \
      "A group whose members are not all selected must get NO preference," \
      "not the part that happens to be selected. The unselected binary is" \
      "not carried, so when it starts it leaves from the customer's own" \
      "address while its siblings leave from the exit."
  fi
  if ! grep -q 'paths.contains(&exit.app.to_lowercase())' <<< "$with_exits"; then
    fail "Selection::with_exits in $SERVICE no longer checks a group" \
      "member against the selection." \
      "" \
      "That check is what makes a partly-selected group detectable here at" \
      "all, independently of the client having behaved."
  fi
fi

# --- 6. the catalogue still states the groups ------------------------------
#
# A row IS the group. Each pair below has first-party evidence behind it,
# recorded in that entry's own `source` and `notes`.

check_pair() {
  local slug="$1"
  shift
  local row exe
  # The entry, from its slug line to the next one. The catalogue is
  # pretty-printed one field per line, which is the whole reason it is
  # JSON a person can read a diff of.
  row=$(awk -v pat="\"slug\": \"$slug\"" '
    index($0, pat) { f = 1; print; next }
    f && /"slug":/ { exit }
    f { print }
  ' "$CATALOGUE")
  if [ -z "$row" ]; then
    fail "'$slug' is gone from $CATALOGUE."       "It is one of the games whose launcher and client are separate"       "binaries. If it was renamed, rename it here too."
    return
  fi
  # Matched in bash rather than through grep: the row is a multi-line
  # string and a name like DeadByDaylight-Win64-Shipping.exe is full of
  # characters a pattern would have to be escaped against.
  for exe in "$@"; do
    if [[ "${row,,}" != *"\"${exe,,}\""* ]]; then
      fail "'$slug' in $CATALOGUE no longer lists '$exe'."         ""         "A catalogue row is the exit GROUP. Dropping half of a game does"         "not merely lose coverage -- it makes the client believe the"         "remaining half is a whole game, which is exactly the state that"         "earns a per-game exit and exactly the state that must not."
    fi
  done
}

check_pair rust Rust.exe RustClient.exe
check_pair sea-of-thieves SeaOfThieves.exe SoTGame.exe
check_pair dead-by-daylight DeadByDaylight.exe DeadByDaylight-Win64-Shipping.exe
check_pair ark-survival-evolved ShooterGame_BE.exe ShooterGame.exe
check_pair ark-survival-ascended ArkAscended_BE.exe ArkAscended.exe
check_pair lost-ark LOSTARK.exe Launch_Game.exe LostArkLauncher.exe

if [ "$status" -eq 0 ]; then
  echo "check-exit-groups: ok -- a game's binaries go to one exit or to none, at every layer."
fi

exit "$status"
