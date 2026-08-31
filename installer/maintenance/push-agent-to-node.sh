#!/usr/bin/env bash
# Install an agentd release on a node that cannot reach GitHub.
#
# Written 2026-08-31, after ir1 (the Iran relay) timed out fetching its
# own binary during the v0.2.7 rollout. Measured from that node:
#
#   connect.neoxify.site  -> 188.114.99.0 (Cloudflare)  UNREACHABLE
#   167.233.65.166:443    -> HTTP 200 in 0.28s          fine
#   167.233.65.166:50051  -> open                       fine
#
# So Cloudflare is filtered from there and the origin is not, which is
# also why that node's grpcTarget must be the origin address rather than
# the panel hostname.
#
# The panel's /api/updates/download/:tag/:asset proxy is NOT a way round
# this. It validates the requested asset against the newest *desktop*
# build specifically so it cannot become an open redirect, and widening
# that guard to carry agent binaries would trade a security property for
# an operational one. Don't.
#
# This does what a human would: fetch where GitHub is reachable, verify
# the checksum HERE, copy over SSH, verify again on the node, then
# install. The checksum is verified on both ends deliberately -- the
# point of the second check is the copy, not the download.
#
# Usage:  ./push-agent-to-node.sh v0.2.7 root@ir1.neoxify.site [ssh-key]
set -euo pipefail

TAG="${1:?usage: push-agent-to-node.sh <tag> <user@host> [ssh-key]}"
DEST="${2:?usage: push-agent-to-node.sh <tag> <user@host> [ssh-key]}"
KEY="${3:-}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

ASSET="agentd-linux-amd64"
BASE="https://github.com/alihajipoor/neoconnect/releases/download/$TAG"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $TAG from GitHub..."
curl -fsSL -o "$TMP/$ASSET"          "$BASE/$ASSET"
curl -fsSL -o "$TMP/sha256sums.txt"  "$BASE/sha256sums.txt"

echo "Verifying locally..."
( cd "$TMP" && grep "$ASSET" sha256sums.txt | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; } )

echo "Copying to $DEST (this is the slow part over a filtered link)..."
scp "${SSH_OPTS[@]}" "$TMP/$ASSET" "$TMP/sha256sums.txt" "$DEST:/tmp/"

echo "Verifying on the node, then installing..."
ssh "${SSH_OPTS[@]}" "$DEST" bash -s <<'REMOTE'
set -euo pipefail
cd /tmp
grep 'agentd-linux-amd64' sha256sums.txt | sha256sum -c - || {
  echo "CHECKSUM FAILED ON THE NODE -- the copy is corrupt, not installing" >&2
  exit 1
}
# Keep the outgoing binary so a bad rollout can be undone without a
# network fetch, which is the whole problem on this class of node.
install -d -m 755 /var/lib/neoxify/agentd-rollback
if [[ -x /usr/local/bin/agentd ]]; then
  cp -a /usr/local/bin/agentd \
    "/var/lib/neoxify/agentd-rollback/agentd-prev-$(sha256sum /usr/local/bin/agentd | cut -c1-12)"
fi
install -m 755 agentd-linux-amd64 /usr/local/bin/agentd
systemctl restart neoxify-agentd
rm -f /tmp/agentd-linux-amd64 /tmp/sha256sums.txt
sleep 10
echo "  version : $(/usr/local/bin/agentd --version)"
echo "  service : $(systemctl is-active neoxify-agentd)"
journalctl -u neoxify-agentd --since '20 sec ago' --no-pager -o cat | grep -a 'connected to control plane' | tail -1
REMOTE
echo "Done."
