#!/bin/bash
# inside.sh <verb> ...   Runs on a box inside the watched country (the
# relay box or the sign-in box). Holds nothing and leaves nothing: no
# credential ever goes through this script.
#
#   bare <address> <port>...
#       the bare-box test against node/sink.py: 256 KB up and down per port
#   zone <zone>
#       is every name under the zone rewritten here? Asks for a random
#       label that was never created, from the system resolver and from a
#       public one. A real zone answers "no such name"; a blocked one
#       answers with an address, for anything. Prints zone-clean or
#       zone-rewritten.
#   probe
#       the data check the panel runs every 30 minutes, once, now:
#       "nodeId address port" lines on stdin, one JSON line each
#   sni <address> <port> <name>
#       does a TLS hello with that name get through to that address?
#       Prints sni-ok or sni-reset.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
verb=${1:-}
shift || true
case "$verb" in
  bare)
    A=${1:?address}
    shift
    for p in "$@"; do python3 "$HERE/probe.py" "$A" "$p"; done
    ;;
  zone)
    Z=${1:?zone}
    L="nx$(head -c 5 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    a=$(dig +short +time=4 +tries=1 "$L.$Z" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
    b=$(dig +short +time=4 +tries=1 @1.1.1.1 "$L.$Z" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
    c=$(dig +short +time=4 +tries=1 example.com A 2>/dev/null | grep -cE '^[0-9.]+$')
    [ "$c" -ge 1 ] || { echo "zone-unknown (this box resolves nothing at all right now)"; exit 1; }
    if [ -z "$a" ] && [ -z "$b" ]; then echo "zone-clean"; else echo "zone-rewritten (a name that does not exist got an address)"; exit 1; fi
    ;;
  probe)
    /usr/local/bin/neoxify-inside-probe | sed -E 's/"nodeId":"[^"]*",//'
    ;;
  sni)
    A=${1:?address}
    P=${2:?port}
    N=${3:?name}
    # Captured first: piped into `grep -q` under pipefail, openssl is
    # killed when grep closes the pipe on its match, and a name that got
    # through would read as reset.
    O=$(echo | timeout 8 openssl s_client -connect "$A:$P" -servername "$N" 2>/dev/null)
    if grep -q 'BEGIN CERTIFICATE' <<<"$O"; then echo "sni-ok"; else echo "sni-reset"; exit 1; fi
    ;;
  *)
    echo "usage: inside.sh bare|zone|probe|sni ..." >&2
    exit 2
    ;;
esac
