# One Xray client config for one credential, the same shape the apps
# build. Used by nx-e2e-build.sh (a credential the panel issued) and by
# nx-e2e-temp.sh (a temporary one). Inputs: $c the protocol config row
# ({protocol, transport, port, host, pbk, sid, sni, path, method,
# serverKey, expect}), $u a protocol user ({credentials: {...}}).
#
# The local ports are placeholders: nx-e2e-run.sh moves them to the first
# free pair, so several runs can go at once.
($u.credentials) as $cr
| ($c.host) as $addr
| ($c.port) as $port
| (if $c.protocol == "XRAY_TROJAN" then
     {protocol: "trojan", settings: {servers: [{address: $addr, port: $port, password: $cr.password}]},
      streamSettings: {network: "tcp", security: "tls", tlsSettings: {serverName: $c.sni, fingerprint: "chrome"}}}
   elif $c.protocol == "SHADOWSOCKS" then
     {protocol: "shadowsocks", settings: {servers: [{address: $addr, port: $port, method: $c.method,
       password: ($c.serverKey + ":" + $cr.userKey), uot: true}]}}
   else
     {protocol: "vless",
      settings: {vnext: [{address: $addr, port: $port, users: [{id: $cr.uuid, encryption: "none", flow: ($cr.flow // "")}]}]},
      streamSettings: (
        if $c.protocol == "XRAY_VLESS_REALITY" then
          {network: "tcp", security: "reality",
           realitySettings: {serverName: $c.sni, fingerprint: "chrome", publicKey: $c.pbk, shortId: $c.sid}}
        elif $c.transport == "WS" then
          {network: "ws", security: "tls", tlsSettings: {serverName: $c.sni, fingerprint: "chrome", alpn: ["http/1.1"]},
           wsSettings: {path: $c.path, host: $c.sni}}
        else
          {network: "tcp", security: "tls", tlsSettings: {serverName: $c.sni, fingerprint: "chrome"}}
        end)}
   end) as $out
| {nxExpectIp: $c.expect,
   nxProto: ($c.protocol + "/" + ($c.transport // "TCP")),
   config: {
     log: {loglevel: "warning"},
     inbounds: ([{listen: "127.0.0.1", port: 18990, protocol: "socks", settings: {udp: false}}]
       + (if $c.protocol == "SHADOWSOCKS" then
            [{listen: "127.0.0.1", port: 15353, protocol: "dokodemo-door",
              settings: {address: "1.1.1.1", port: 53, network: "udp"}}]
          else [] end)),
     outbounds: [$out]}}
