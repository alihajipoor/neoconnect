#!/usr/bin/env bash
# Keeps the manual test-installer build unable to ship anything.
#
# build-test-installer.yml produces an unsigned installer from any branch
# or commit, for the test VM. What makes that safe is what it cannot do:
# publish a release, push a tag, reach the public releases repository,
# or sign with the updater key -- an updater-signed build of an arbitrary
# branch is something every installed client would accept. Those are
# properties of the file, and a later edit that copies one more step
# across from release-desktop-windows.yml would remove them silently, so
# they are checked here rather than trusted to a comment.
set -euo pipefail

wf=${1:-.github/workflows/build-test-installer.yml}
status=0
fail() { echo "  $1"; status=1; }

if [ ! -f "$wf" ]; then
  echo "  $wf: missing"
  exit 1
fi

# Comments say what the file must never do, so they would match the very
# patterns below. Checked against the code only -- comment lines are
# blanked rather than deleted, so a reported line number is the file's.
code=$(sed -E -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]+#.*$//' "$wf")

block_keys() { # top-level key -> the keys directly under it
  printf '%s\n' "$code" | awk -v key="$1" '
    $0 ~ "^" key ":" { inside = 1; next }
    inside && /^[^[:space:]]/ { inside = 0 }
    inside && /^  [A-Za-z_-]+:/ { sub(/^  /, ""); print }'
}

triggers=$(block_keys on | sed -E 's/:.*//' | sort -u | tr '\n' ' ')
[ "$triggers" = "workflow_dispatch " ] ||
  fail "triggers are '${triggers% }', not workflow_dispatch alone"

printf '%s\n' "$code" | grep -qE '^      ref:' ||
  fail "no 'ref' input to choose what to build"

perms=$(block_keys permissions | tr -d ' ' | tr '\n' ' ')
[ "$perms" = "contents:read " ] ||
  fail "top-level permissions are '${perms% }', not contents: read alone"

if printf '%s\n' "$code" | grep -nE '(:[[:space:]]*write)|write-all'; then
  fail "grants a write permission"
fi

if printf '%s\n' "$code" | grep -nE 'secrets\.|TAURI_SIGNING|ANDROID_|AZURE_'; then
  fail "references a secret or a signing credential"
fi

if printf '%s\n' "$code" | grep -nE 'action-gh-release|gh release|git push|git tag|neoxify-releases'; then
  fail "can publish a release, push, tag or reach the releases repository"
fi

printf '%s\n' "$code" | grep -qE '"createUpdaterArtifacts"[[:space:]]*:[[:space:]]*false' ||
  fail "does not turn off updater artifacts, so the build would need the signing key"

printf '%s\n' "$code" | grep -qE 'retention-days:[[:space:]]*3$' ||
  fail "artifact retention is not 3 days"

if [ "$status" -eq 0 ]; then
  echo "  $wf: cannot publish, tag or sign"
fi
exit "$status"
