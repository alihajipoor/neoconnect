#!/usr/bin/env bash
# Runs installer/lib/agent.sh's check of a new server's region label
# (node_region_problem) and the prompt around it (ask_node_region).
#
# The apps read a server's country off the first two letters of that
# label, and carry a flag and a name for every ISO country. A label that
# names none is a globe in apps customers already have -- which is how
# Sweden's server looked on 2026-11-11 -- so the installer asks until the
# label names one. Nothing here touches a panel or a box: the labels come
# from this file and the prompt is fed from a pipe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../installer/lib/agent.sh
. "$ROOT/installer/lib/agent.sh"

fail=0
accepted() {
  local why
  why="$(node_region_problem "$1")"
  if [[ -n "$why" ]]; then
    echo "FAIL: '$1' was refused: $why"
    fail=1
  fi
}
# refused LABEL [WORDS THE REASON MUST CARRY]
refused() {
  local why
  why="$(node_region_problem "$1")"
  if [[ -z "$why" ]]; then
    echo "FAIL: '$1' was accepted"
    fail=1
  elif [[ -n "${2:-}" && "$why" != *"$2"* ]]; then
    echo "FAIL: '$1' was refused without saying '$2': $why"
    fail=1
  fi
}

# Every label in the fleet on 2026-11-11, and the shapes a new one may take.
for label in de-germany fi-finland fr-france gb-united-kingdom in-india ir-iran \
  nl-netherlands se-sweden sg-singapore tr-turkey us-new-york kr-seoul-2; do
  accepted "$label"
done

# Each of these is a globe, or another country's flag, in the apps.
refused "uk-london" "the United Kingdom is gb"
refused "el-athens" "Greece is gr"
refused "xk-pristina" "not a country's ISO code"
refused "zz-nowhere" "not a country's ISO code"
refused "eu-west" "not a country's ISO code"
refused "frankfurt" "like fi-finland"
refused "deu-frankfurt"
refused "de"
refused "de-"
refused "-germany"
refused "de--germany"
refused "de_germany"
refused "de.frankfurt"
refused "de frankfurt"
refused "No region"
refused "St Petersburg"
refused "DE-germany"
refused ""

# All 249 countries, and no other pair of letters.
read -r -a codes <<<"$ISO_COUNTRY_CODES"
if [[ "${#codes[@]}" -ne 249 ]]; then
  echo "FAIL: ISO_COUNTRY_CODES holds ${#codes[@]} codes, not 249"
  fail=1
fi
# One line comes out for each pair refused. (Counted in one go: a process
# for each of the 676 takes minutes where starting one is slow.)
turned_away="$(
  for a in {a..z}; do
    for b in {a..z}; do
      node_region_problem "$a$b-somewhere"
    done
  done | wc -l
)"
if [[ "$((676 - turned_away))" -ne 249 ]]; then
  echo "FAIL: $((676 - turned_away)) of the 676 two-letter codes are accepted, not 249"
  fail=1
fi
for code in "${codes[@]}"; do
  case "$code" in
    [a-z][a-z]) ;;
    *)
      echo "FAIL: '$code' in ISO_COUNTRY_CODES is not two lower-case letters"
      fail=1
      ;;
  esac
done

# The prompt asks again until the label names a country, and takes it
# trimmed and in lower case.
node_region=""
ask_node_region 2>/dev/null <<<$'UK-London\nNo region\n\n  SE-Stockholm  \nde-germany' || true
if [[ "$node_region" != "se-stockholm" ]]; then
  echo "FAIL: the prompt left '$node_region', not 'se-stockholm'"
  fail=1
fi

# And when the answers run out it stops, failing, rather than asking for
# ever: the install is sometimes fed from a file.
if timeout 20 bash -c '. "$1"; ask_node_region' _ "$ROOT/installer/lib/agent.sh" 2>/dev/null <<<"uk-london"; then
  echo "FAIL: the prompt did not fail when its input ended on a refused label"
  fail=1
elif [[ $? -eq 124 ]]; then
  echo "FAIL: the prompt kept asking after its input ended"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "node region label: OK"
