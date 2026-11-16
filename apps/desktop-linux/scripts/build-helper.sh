#!/usr/bin/env bash
# Builds the root daemon and puts it where the package picks it up.
#
# The helper is its own Cargo workspace (this directory), separate from the
# Tauri app in src-tauri, so it is built here and copied rather than being
# a dependency of the app. CARGO_TARGET_DIR is honoured, so a shared build
# machine can keep each checkout's output apart.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
cargo build --release -p neoxify-helper
target="${CARGO_TARGET_DIR:-$root/target}"
install -D -m 0755 "$target/release/neoxify-helper" "$root/src-tauri/resources/neoxify-helper"
echo "  neoxify-helper -> src-tauri/resources/neoxify-helper"
