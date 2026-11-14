#!/bin/bash
# nx-dial-image.sh [check]
# Runs on the panel host. Makes sure the one image the WireGuard, OpenVPN
# and IKEv2 proofs run in is there, and builds it when it is not.
#
# What stays on the panel host, on purpose: this one image, tagged
# nxf-dial:<version> (about 160 MB: Debian slim, wireguard-go, openvpn,
# strongSwan's charon with kernel-libipsec). Building it again on every
# run would pull and install the same packages each time. Older versions
# of it are removed here, and so is the base image's tag (its layers stay
# only as part of this image). Nothing else is kept: no container, no
# volume, no network, no file outside /dev/shm/nxf.
#
# Why Debian and not Alpine: Alpine's strongSwan has no kernel-libipsec,
# so IKEv2 would need the host kernel's ESP (and the esp4 module loaded on
# the production host). With libipsec, ESP is done in the container's own
# process over its own TUN device, and the host kernel is not asked for
# anything but a TUN device, as for OpenVPN and wireguard-go.
#
# "check" prints whether it is there and builds nothing.
set -uo pipefail
VER=1
IMG="nxf-dial:$VER"
if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "dial image $IMG present ($(docker images --format '{{.Size}}' "$IMG" | head -1))"
  exit 0
fi
if [ "${1:-}" = check ]; then
  echo "dial image $IMG absent"
  exit 1
fi
T0=$(date +%s)
# No build context: the Dockerfile comes on stdin, so nothing is written
# to the host's disk but the image itself. nice and ionice: the panel
# serves customers while this runs.
if ! timeout 600 nice -n 15 ionice -c3 docker build -q --label nxf-dial=1 -t "$IMG" - >/dev/null 2>/dev/shm/nxf/dial-build.err <<'EOF'; then
FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      wireguard-tools wireguard-go openvpn strongswan-charon strongswan-swanctl \
      libcharon-extauth-plugins libcharon-extra-plugins libstrongswan-standard-plugins \
      curl iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
EOF
  echo "dial image $IMG: BUILD FAILED"
  tail -5 /dev/shm/nxf/dial-build.err | cut -c1-200
  rm -f /dev/shm/nxf/dial-build.err
  exit 1
fi
rm -f /dev/shm/nxf/dial-build.err
# Older versions go; the base tag goes (its layers live on in this image).
docker images --format '{{.Repository}}:{{.Tag}}' nxf-dial | grep -vx "$IMG" | xargs -r docker rmi >/dev/null 2>&1
docker rmi debian:trixie-slim >/dev/null 2>&1
# The build cache this left goes too (the owner's rule for this host:
# build cache is pruned after every build, deploys included).
docker builder prune -f >/dev/null 2>&1
echo "dial image $IMG built in $(($(date +%s) - T0))s ($(docker images --format '{{.Size}}' "$IMG" | head -1))"
