#!/usr/bin/env bash
# Restore OpenVPN on a REBUILT node from the panel's stored material.
#
# Written 2026-08-31 while rebuilding finland1 after its host was wiped.
#
# install_openvpn cannot do this. It registers by POSTing to
# /protocol-configs, and the panel is what generates the CA and returns
# it -- so on a node whose config already exists the POST is refused
# ("A OPENVPN protocol config already exists on this node"), the CA is
# never returned, and the function exits before writing a single file.
# The refusal is correct: deleting the config to get past it regenerates
# the CA and invalidates every client cert ever issued against it.
#
# But nothing is actually lost when a node is wiped, because the panel
# stores caCertPem, serverCertPem, serverKeyPem and tlsCryptKey. This
# script fetches those and puts the node back with the SAME CA, so
# existing client certs keep working.
#
# Requires: an admin bearer token at /root/.nx-admin-token, and an
# already-enrolled agent (/etc/neoxify/agent.json).
#
# Ports/proto are pinned to what the panel already advertises for the
# node -- change them here only if you also change them in the panel,
# or clients will dial a port nothing listens on.
set -euo pipefail
cd /root/neoconnect/installer
export SCRIPT_DIR=/root/neoconnect/installer
. lib/os-detect.sh; . lib/deps.sh; . lib/systemd.sh; . lib/agent.sh
detect_os

panel_url="$(jq -r .panelUrl /etc/neoxify/agent.json)"
node_id="$(jq -r .nodeId /etc/neoxify/agent.json)"
token="$(cat /root/.nx-admin-token)"
listen_port=49266; proto=udp; mgmt_port=7505; ovpn_subnet="10.77.0.0/24"

cfg="$(curl -sSL "$panel_url/protocol-configs" -H "Authorization: Bearer $token" \
  | jq --arg n "$node_id" '[.[] | select(.nodeId==$n and .protocol=="OPENVPN")][0]')"
[[ "$(echo "$cfg" | jq -r '.id // empty')" ]] || { echo "no OPENVPN config in panel"; exit 1; }
echo "using panel config $(echo "$cfg" | jq -r .id)"

install -d -m 755 /etc/openvpn/server /etc/openvpn/ccd
echo "$cfg" | jq -r '.publicParamsJson.caCertPem'     > /etc/openvpn/server/ca.crt
echo "$cfg" | jq -r '.publicParamsJson.serverCertPem' > /etc/openvpn/server/server.crt
echo "$cfg" | jq -r '.publicParamsJson.serverKeyPem'  > /etc/openvpn/server/server.key
echo "$cfg" | jq -r '.publicParamsJson.tlsCryptKey'   > /etc/openvpn/server/tls-crypt.key
chmod 600 /etc/openvpn/server/server.key /etc/openvpn/server/tls-crypt.key
for f in ca.crt server.crt server.key tls-crypt.key; do
  [[ -s /etc/openvpn/server/$f ]] || { echo "empty $f -- panel did not hold it"; exit 1; }
done
openssl dhparam -dsaparam -out /etc/openvpn/server/dh.pem 2048 2>/dev/null

cat > /etc/openvpn/server/server.conf <<EOF
port ${listen_port}
proto ${proto}
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
tls-crypt tls-crypt.key
topology subnet
server 10.77.0.0 255.255.255.0
client-config-dir /etc/openvpn/ccd
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
keepalive 10 60
cipher AES-256-GCM
persist-key
persist-tun
management 127.0.0.1 ${mgmt_port}
status /var/log/openvpn-status.log
verb 3
EOF

systemctl enable --now openvpn-server@server
systemctl restart openvpn-server@server
apt-get install -y -qq iptables iptables-persistent >/dev/null 2>&1
iface="$(detect_default_iface)"
[[ -n "$iface" ]] || { echo "no default iface"; exit 1; }
enable_ip_forwarding
masquerade_client_subnet "$ovpn_subnet" "$iface"
netfilter-persistent save >/dev/null 2>&1
echo "openvpn: $(systemctl is-active openvpn-server@server)"
