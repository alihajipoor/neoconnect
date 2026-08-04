#!/usr/bin/env bash
# Fails when the backend reads an environment variable the installer
# never creates.
#
# This exists because that drift is invisible until somebody installs
# from scratch, and nobody does -- the production panel has been
# upgraded in place for weeks. A missing secret would not break the
# upgrade that introduced it; it would break the next fresh install,
# months later, for a person who has no idea what changed.
#
# The same class of problem as a release workflow that has never run:
# infrastructure nobody exercises is a guess. This turns it into a
# check that runs on every commit.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONFIG="apps/backend/src/config/configuration.ts"
PANEL_LIB="installer/lib/panel.sh"
COMPOSE="infra/docker-compose.prod.yml"

# Everything the backend actually reads.
mapfile -t required < <(grep -oE 'process\.env\.[A-Z0-9_]+' "$CONFIG" | sed 's/process\.env\.//' | sort -u)

missing=()
for key in "${required[@]}"; do
  # A variable with a literal fallback in the config needs nothing from
  # the installer -- the default is the answer. Matching `?? "..."` on
  # the same line is deliberately narrow: `?? someOtherVar` is not a
  # default, it is a rename, and should still be reported.
  if grep -qE "process\.env\.$key\s*\?\?\s*[\"'\`]" "$CONFIG"; then continue; fi
  # Satisfied either by the installer generating it into infra/.env, or
  # by docker-compose setting it on the container directly. Both are
  # legitimate -- DATABASE_URL and REDIS_URL point at sibling services
  # and have no business being in a secrets file.
  if grep -q "ensure_env_key \"$key\"" "$PANEL_LIB"; then continue; fi
  if grep -qE "^\s+$key:" "$COMPOSE"; then continue; fi
  missing+=("$key")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "These environment variables are read by the backend but never set up by the installer:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Add an ensure_env_key line to generate_panel_secrets() in $PANEL_LIB" >&2
  echo "(or set it in $COMPOSE if it is not a secret), so a fresh install works." >&2
  exit 1
fi

echo "installer covers all ${#required[@]} backend environment variables"
