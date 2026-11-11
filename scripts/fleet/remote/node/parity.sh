#!/bin/bash
# parity.sh apply|check <panel address> <panel name> <name1> <name2>
# Runs on the box being built, after the installer and before any
# customer exists. Brings the pieces the installer does not write to the
# form every server in the fleet has. `apply` backs up what it changes
# under /root/pre-parity-<time> and can be run twice; `check` changes
# nothing and says ok or DRIFT per piece.
#
#   nginx     the API mirror reaches the panel by ADDRESS, with the
#             panel's name as Host and TLS name (a name lookup on every
#             request is one more thing to be poisoned); a second site on
#             2096 serves the direct mirror under its own name
#   hooks     the direct mirror's certificate must not trigger the Xray
#             and IKEv2 renewal hooks, which copy "the" certificate; it
#             gets its own hook that reloads nginx
#   agent     the agent dials the panel's control port by address, so it
#             needs the name to check the certificate against
#   openvpn   ccd-exclusive: a client with no ccd file is refused, which
#             is what makes revoking a credential take effect
#   ipv6      Xray (uid nobody) may not leave over IPv6: the fleet is
#             IPv4-only on purpose and this box has a global IPv6
#   modes     nothing public left owner-only by a tight umask
set -uo pipefail
MODE=${1:?apply or check}
PADDR=${2:?panel address}
PNAME=${3:?panel name}
L1=${4:?first name}
L2=${5:?second name}
D=/etc/letsencrypt/renewal-hooks/deploy
SA=/etc/nginx/sites-available
drift=0
B=""

ok() { echo "ok $1"; }
bad() {
  echo "DRIFT $1: $2"
  drift=1
}
backup() {
  [ "$MODE" = apply ] || return 0
  if [ -z "$B" ]; then
    B=/root/pre-parity-$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$B"
    echo "backups in $B"
  fi
  [ -e "$1" ] && cp -a "$1" "$B/"
}

api_block() {
  cat <<API
    location /api/ {
        resolver 8.8.8.8 1.1.1.1 valid=30s ipv6=off;
        resolver_timeout 5s;
        set \$neoxify_panel $PADDR;
        proxy_pass https://\$neoxify_panel\$request_uri;
        proxy_set_header Host $PNAME;
        proxy_ssl_name $PNAME;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_ssl_verify_depth 3;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
API
}

# nginx 1.25.1 and later want "http2 on;", older ones "listen ... http2".
http2_new() {
  local v
  v=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p')
  [ "$(printf '%s\n1.25.1\n' "$v" | sort -V | head -1)" = "1.25.1" ]
}

render_sites() { # <dir>
  local l h2line="" h2listen=" http2"
  if http2_new; then
    h2line="    http2 on;"
    h2listen=""
  fi
  : >"$1/neoxify-fallback"
  for l in 8080 8081; do
    {
      echo "server {"
      if [ "$l" = 8081 ]; then
        echo "    listen 127.0.0.1:8081${h2listen} proxy_protocol;"
        [ -n "$h2line" ] && echo "$h2line"
      else
        echo "    listen 127.0.0.1:8080 proxy_protocol;"
      fi
      cat <<CONF
    set_real_ip_from 127.0.0.1;
    real_ip_header proxy_protocol;
    server_name _;
    root /var/www/neoxify-fallback;
    index index.html;
    server_tokens off;
$(api_block)
}
CONF
    } >>"$1/neoxify-fallback"
  done
  {
    echo "server {"
    echo "    listen 2096 ssl${h2listen};"
    [ -n "$h2line" ] && echo "$h2line"
    cat <<CONF
    server_name $L2;
    ssl_certificate /etc/letsencrypt/live/$L2/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$L2/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:neoxify_mirror_direct:1m;
    server_tokens off;
    root /var/www/neoxify-fallback;
    index index.html;
$(api_block)
}
CONF
  } >"$1/neoxify-mirror-direct"
}

p_nginx() {
  local t f same=1
  t=$(mktemp -d)
  render_sites "$t"
  for f in neoxify-fallback neoxify-mirror-direct; do
    cmp -s "$t/$f" "$SA/$f" || same=0
  done
  [ -L /etc/nginx/sites-enabled/neoxify-mirror-direct ] || same=0
  if [ "$same" = 1 ]; then
    ok nginx
  elif [ "$MODE" = check ]; then
    bad nginx "the mirror sites are not in fleet form"
  else
    backup "$SA/neoxify-fallback"
    install -m 644 "$t/neoxify-fallback" "$SA/neoxify-fallback"
    install -m 644 "$t/neoxify-mirror-direct" "$SA/neoxify-mirror-direct"
    ln -sf ../sites-available/neoxify-fallback /etc/nginx/sites-enabled/neoxify-fallback
    ln -sf ../sites-available/neoxify-mirror-direct /etc/nginx/sites-enabled/neoxify-mirror-direct
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && echo "applied nginx (reloaded)"
    else
      nginx -t 2>&1 | tail -2
      bad nginx "nginx refuses the new sites; the old fallback is in the backup directory"
    fi
  fi
  rm -rf "$t"
}

p_hooks() {
  local f skip="case \"\${RENEWED_LINEAGE:-}\" in */$L2) exit 0 ;; esac" miss=0
  for f in reload-xray.sh neoxify-ikev2.sh; do
    [ -f "$D/$f" ] || continue
    grep -qF "*/$L2)" "$D/$f" || miss=1
  done
  [ -x "$D/reload-nginx-mirror-direct.sh" ] && grep -qF "*/$L2)" "$D/reload-nginx-mirror-direct.sh" || miss=1
  if [ "$miss" = 0 ]; then
    ok hooks
    return
  fi
  if [ "$MODE" = check ]; then
    bad hooks "a renewal hook does not tell the two certificates apart"
    return
  fi
  for f in reload-xray.sh neoxify-ikev2.sh; do
    [ -f "$D/$f" ] || continue
    grep -qF "*/$L2)" "$D/$f" && continue
    backup "$D/$f"
    # The exact lineage, never a pattern on the domain: a looser match
    # once skipped the main certificate too.
    {
      head -1 "$D/$f"
      echo '# The direct-mirror lineage (nginx :2096) is not the Xray/IKEv2 certificate.'
      echo "$skip"
      tail -n +2 "$D/$f"
    } >"$D/$f.new" && chmod --reference="$D/$f" "$D/$f.new" && mv "$D/$f.new" "$D/$f"
    sh -n "$D/$f" || bad hooks "$f no longer parses"
  done
  printf '#!/bin/sh\n# The direct mirror (nginx :2096) reads its certificate at reload.\ncase "${RENEWED_LINEAGE:-}" in */%s) systemctl reload nginx ;; esac\n' "$L2" >"$D/reload-nginx-mirror-direct.sh"
  chmod 755 "$D/reload-nginx-mirror-direct.sh"
  echo "applied hooks"
}

p_agent() {
  local f=/etc/neoxify/agent.json
  if [ "$(jq -r '.tlsServerName // empty' "$f" 2>/dev/null)" = "$PNAME" ]; then
    ok agent
    return
  fi
  if [ "$MODE" = check ]; then
    bad agent "the agent has no name to check the panel's certificate against"
    return
  fi
  backup "$f"
  jq --arg n "$PNAME" '.tlsServerName = $n' "$f" >"$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"
  systemctl restart neoxify-agentd
  sleep 5
  echo "applied agent (agent restarted; the engines are not touched by that): $(systemctl is-active neoxify-agentd)"
}

p_openvpn() {
  local f=/etc/openvpn/server/server.conf
  [ -f "$f" ] || { ok "openvpn (not on this box)"; return; }
  if grep -q '^ccd-exclusive' "$f"; then
    ok openvpn
    return
  fi
  if [ "$MODE" = check ]; then
    bad openvpn "no ccd-exclusive: a revoked credential would still connect"
    return
  fi
  backup "$f"
  echo ccd-exclusive >>"$f"
  systemctl restart openvpn-server@server
  sleep 1
  echo "applied openvpn: $(systemctl is-active openvpn-server@server)"
}

p_ipv6() {
  local IF
  IF=$(ip -6 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
  if [ -z "$IF" ]; then
    ok "ipv6 (no IPv6 route on this box)"
    return
  fi
  if ip6tables -C OUTPUT -o "$IF" -m owner --uid-owner nobody -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null &&
    ip6tables -C OUTPUT -o "$IF" -m owner --uid-owner nobody -j REJECT 2>/dev/null &&
    grep -q -- '--uid-owner nobody' /etc/iptables/rules.v6 2>/dev/null; then
    ok ipv6
    return
  fi
  if [ "$MODE" = check ]; then
    bad ipv6 "Xray could leave over IPv6"
    return
  fi
  [ -f /etc/iptables/rules.v6 ] && cp -a /etc/iptables/rules.v6 /root/rules.v6.bak-pre-ipv6-nobody
  ip6tables -C OUTPUT -o "$IF" -m owner --uid-owner nobody -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null ||
    ip6tables -A OUTPUT -o "$IF" -m owner --uid-owner nobody -p tcp -j REJECT --reject-with tcp-reset
  ip6tables -C OUTPUT -o "$IF" -m owner --uid-owner nobody -j REJECT 2>/dev/null ||
    ip6tables -A OUTPUT -o "$IF" -m owner --uid-owner nobody -j REJECT
  netfilter-persistent save >/dev/null 2>&1
  echo "applied ipv6 (forwarding stays $(cat /proc/sys/net/ipv6/conf/all/forwarding))"
}

p_modes() {
  local f list="" pub=(/etc/logrotate.d/xray /etc/neoxify/role /etc/nginx/sites-available/neoxify-http
    /etc/openvpn/server/ca.crt /etc/openvpn/server/dh.pem /etc/openvpn/server/server.crt
    /etc/swanctl/conf.d/neoxify.conf /var/www/neoxify-fallback/index.html /var/www/html/index.html
    /etc/wireguard/server_public.key /usr/local/bin/neoxify-sync-certs /usr/local/bin/neoxify-xray-restart)
  for f in "${pub[@]}" /etc/sysctl.d/99-neoxify-*; do
    [ -e "$f" ] || continue
    [ -n "$(find "$f" -maxdepth 0 ! -perm -o=r)" ] && list+=" $f"
  done
  if [ -z "$list" ]; then
    ok modes
  elif [ "$MODE" = check ]; then
    bad modes "owner-only but meant to be readable:$list"
  else
    for f in $list; do
      case "$f" in /usr/local/bin/*) chmod 755 "$f" ;; *) chmod 644 "$f" ;; esac
    done
    systemctl daemon-reload
    echo "applied modes:$list"
  fi
  # And the other way round: these must stay owner-only.
  for f in /etc/openvpn/server/server.key /etc/openvpn/server/tls-crypt.key /etc/wireguard/server_private.key \
    /etc/wireguard/wg0.conf /etc/neoxify/agent.json /etc/swanctl/conf.d/neoxify-users.conf /etc/swanctl/private/node.key; do
    [ -e "$f" ] || continue
    [ -z "$(find "$f" -maxdepth 0 -perm /o=r)" ] || bad secrets "$f is world-readable"
  done
}

p_nginx
p_hooks
p_agent
p_openvpn
p_ipv6
p_modes
exit $drift
