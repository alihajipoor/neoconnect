import type { ProtocolUser } from "@shared/lib/types";

/** Builds the xray-core config for one credential.
 *
 * Here rather than in Kotlin because this is protocol knowledge, and it
 * belongs beside the credential types that feed it. The Kotlin side owns
 * the tunnel and needs to know nothing about VLESS to do that job.
 *
 * The outbound shapes are deliberately identical to the ones the Windows
 * client generates (see the service's engines/xray.rs). Those are
 * live-proven against these exact nodes, and two clients quietly
 * disagreeing about, say, whether to send an ALPN list is the kind of
 * difference that shows up as "it works on my laptop but not my phone"
 * weeks later.
 */

/** The DNS the tunnel advertises.
 *
 * Set on the VpnService rather than inside xray. With the default route
 * captured, a resolver learned from the phone's Wi-Fi is often on a
 * private address the tunnel cannot reach, so name resolution stops
 * and the customer reads it as "the internet is down". */
export const TUN_DNS = "1.1.1.1";

/** Below the usual 1500 to leave room for the outer packet's own
 * headers. A tunnel that fragments works, but slowly and unevenly, and
 * the symptom -- some sites fine, some hanging -- is hard to attribute. */
export const TUN_MTU = 1400;

/** Where the engine's own resolver sends the tunnel's A lookups: DNS over
 * HTTPS, through the proxy.
 *
 * Every lookup the phone makes goes to TUN_DNS on port 53 and is routed to
 * the DNS outbound (DNS_OUT_TAG), which answers A and AAAA from this
 * resolver and its cache. Before, each lookup from a new source port was a
 * UDP flow of its own, and on Stealth a UDP flow is a new connection to the
 * server -- TCP, REALITY and VLESS before the question was even asked:
 * 868 ms median on a 182 ms line, measured 2026-11-17 on the emulator.
 *
 * HTTPS rather than the desktop's `tcp://` (engines/xray.rs,
 * TUNNEL_RESOLVERS) because xray-core's TCP name server dials a new
 * connection for every query (app/dns/nameserver_tcp.go, `sendQuery`),
 * which through the proxy is the same per-lookup server handshake again.
 * The DoH name server keeps one HTTP/2 connection and sends every query
 * down it (nameserver_doh.go, an http2.Transport with keep-alive pings).
 * By address, so finding the resolver needs no lookup of its own.
 *
 * A dead kept-open connection must not cost a lookup. After a switch
 * between Wi-Fi and mobile data the kept HTTP/2 connection can be dead
 * without knowing it -- it is noticed only after 45 s idle, and a query in
 * flight on it is not retried -- and the emulator measured a first lookup
 * of 0.9-1.1 s after a switch, and one in three with no reply at all. So
 * the servers are asked in turn, not at once, and the DoH one gets 2 s
 * (`timeoutMs`, per server: app/dns/nameserver.go) before the lookup moves
 * on, within the same lookup, to a TCP server. That one dials a fresh
 * connection for every query, so it cannot be left holding a dead one; it
 * is slower (a server handshake), which is why it is second. Both go
 * through the proxy: the DNS app's connections carry its own tag, match
 * no routing rule, and take the first outbound. Asked in turn because
 * xray-core's parallel race answers early only on addresses, so an
 * NXDOMAIN with one server unreachable could go unanswered.
 *
 * Never a direct lookup ("localhost" or a "+local" scheme): that would
 * leave outside the tunnel, and is answered falsely on the networks this
 * exists for. */
export const ENGINE_RESOLVERS: (string | { address: string; timeoutMs: number })[] = [
  { address: "https://1.1.1.1/dns-query", timeoutMs: 2000 },
  "tcp://8.8.8.8:53",
];

/** The outbound every lookup the tunnel carries -- port 53 -- is routed to.
 * The same tag as the desktop's. */
const DNS_OUT_TAG = "dns-out";

/** How long a lookup's session in the DNS outbound outlives its last
 * question, and the policy level that carries it (the DNS outbound's
 * `userLevel`; nothing else uses level 1).
 *
 * The default is the 300 s every connection gets, and the phone asks
 * every question from a new source port -- three per name on iOS -- so a
 * session per question was kept for five minutes. Opening apps after a
 * connect held thousands of them, and an iPhone's packet tunnel was killed
 * at its 50 MB ceiling 30 s into a session (2026-11-17). A lookup is over
 * in one answer, at most the 2 s DoH try plus the TCP server's 4 s
 * (ENGINE_RESOLVERS); 10 s covers that with room, and the timer counts
 * from the question, so no answer is cut off. On iOS the TUN inbound also
 * ends such a flow 2 s after its answer, or 10 s after an unanswered
 * question (plugins/vpn/xray/patches/ios-udp-flows.patch). */
export const LOOKUP_LEVEL = 1;
export const LOOKUP_IDLE_SECS = 10;

/** The local refusal: anything routed here is closed on the phone without
 * dialling anything. */
const BLOCK_TAG = "block";

/** The flow the server issues for Vision (generate-credentials.ts). */
const VISION = "xtls-rprx-vision";

/** What a Vision connection (Stealth, and VLESS+TLS over TCP) does with
 * QUIC -- UDP to port 443.
 *
 * xray-core's VLESS outbound refuses UDP/443 under plain Vision
 * (proxy/vless/outbound/outbound.go: "XTLS rejected UDP/443 traffic"), and
 * it does so after it has already dialled the server: a wasted REALITY
 * handshake per attempt, and silence for the app, which then waits out its
 * own QUIC timeout before falling back to TCP. Measured on 0.2.41.
 *
 * "carry": the client asks for `xtls-rprx-vision-udp443`, a client-only
 * spelling. The outbound trims the suffix before anything is sent
 * (`requestAddons.Flow[:16]`), so the server sees the plain Vision flow it
 * issued, and the UDP travels as XUDP inside the VLESS connection exactly
 * as every other UDP flow on Vision already does. A 26.3.27 server's VLESS
 * inbound takes that mux command under Vision (proxy/vless/inbound, read
 * at v1.260327.0); the nodes' routing has no UDP/443 rule.
 *
 * Carrying works (measured on the emulator: answered, 0.86-0.92 s per new
 * flow), but it changes what apps get, and on a throttled line all QUIC
 * would ride one TCP stream with an effect nobody has measured.
 *
 * "drop-locally", the default: a routing rule refuses UDP/443 on the phone
 * before anything is dialled. The app gets what it gets today -- no QUIC,
 * so it uses TCP -- without the wasted server dial per attempt; the flow
 * is sent as issued. Shadowsocks carries QUIC already, so the two can be
 * compared in the field before carrying is chosen here too. */
export type VisionQuic = "carry" | "drop-locally";
export const VISION_QUIC: VisionQuic = "drop-locally";

type Json = Record<string, unknown>;

/** The flow to send. Only the exact Vision flow is changed, and only when
 * carrying QUIC: anything else -- empty over WebSocket, or a future flow --
 * passes through as issued. */
function clientFlow(issued: string | undefined, quic: VisionQuic): string {
  const flow = issued ?? "";
  return flow === VISION && quic === "carry" ? `${VISION}-udp443` : flow;
}

/** The one short ID a client sends, out of the list the server holds.
 *
 * The server's `publicParams` carries `shortIds`, an array -- the set it
 * will accept -- and a client picks one. This read `params.shortId`,
 * singular, which no server has ever sent, so every Android REALITY
 * connection went out with an empty short ID.
 *
 * That failed in the worst possible way rather than an obvious one.
 * REALITY's entire design is to hand an unauthenticated client to the
 * site it is imitating, so the connection succeeded, the tunnel came
 * up, and the customer was quietly browsing cloudflare.com instead of
 * being proxied. The app's own evidence check caught it -- "up but not
 * carrying traffic" -- and failed over to WireGuard, which is why it
 * showed a green tick while REALITY had never worked at all.
 *
 * The desktop client has always read `shortIds[0]` and thrown when it
 * is absent. This is the same, and the caller now validates it for the
 * same reason: silently sending nothing is what made this invisible.
 */
function shortIdFrom(params: Record<string, unknown>): string | null {
  const list = params.shortIds;
  if (Array.isArray(list) && typeof list[0] === "string" && list[0].length > 0) {
    return list[0];
  }
  // Accepted as a fallback only because a config written by hand might
  // carry the singular form; never emitted by the backend.
  if (typeof params.shortId === "string" && params.shortId.length > 0) {
    return params.shortId;
  }
  return null;
}

function realityOutbound(user: ProtocolUser, params: Record<string, unknown>, quic: VisionQuic): Json {
  return {
    tag: "proxy",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: user.connection.host,
          port: user.connection.port,
          users: [
            { id: user.credentials.uuid, encryption: "none", flow: clientFlow(user.credentials.flow, quic) },
          ],
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        serverName: params.serverName,
        // Presenting Chrome's TLS fingerprint matters as much as the
        // borrowed certificate: a handshake that looks like no browser
        // on earth is itself the signal a censor watches for.
        fingerprint: "chrome",
        publicKey: params.publicKey ?? params.realityPublicKey,
        shortId: shortIdFrom(params),
      },
    },
  };
}

/** The stream wrapper, which is where TCP and WebSocket differ.
 *
 * One function because everything else about a VLESS+TLS outbound is
 * identical between them -- the credential, the address, the
 * fingerprint. Only how the bytes are carried changes.
 */
function tlsStream(params: Record<string, unknown>, transport: string): Json {
  const settings: Json = {
    network: transport === "WS" ? "ws" : "tcp",
    security: "tls",
    tlsSettings: {
      // Verified normally, with no allowInsecure escape hatch. A client
      // that accepts any certificate hands its traffic to whoever is on
      // the path, which is the opposite of the point.
      serverName: params.serverName,
      fingerprint: "chrome",
      alpn: ["h2", "http/1.1"],
    },
  };

  if (transport === "WS") {
    settings.wsSettings = {
      path: (params.path as string) || "/",
      // Sent as the Host header. A WebSocket upgrade with no Host, or
      // one that disagrees with the SNI, is a mismatch a censor can
      // pick out precisely because no browser produces it.
      host: params.serverName,
    };
  }

  return settings;
}

function vlessTlsOutbound(user: ProtocolUser, params: Record<string, unknown>, transport: string, quic: VisionQuic): Json {
  return {
    tag: "proxy",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: user.connection.host,
          port: user.connection.port,
          users: [
            // Empty over WebSocket: XTLS Vision needs a TLS record
            // stream to splice into and there is none inside a
            // WebSocket. The server clears it at generation, so this
            // simply passes through whatever was issued. Over TCP it is
            // Vision, and QUIC is handled as on Stealth (VISION_QUIC).
            { id: user.credentials.uuid, encryption: "none", flow: clientFlow(user.credentials.flow, quic) },
          ],
        },
      ],
    },
    streamSettings: tlsStream(params, transport),
  };
}

function trojanOutbound(user: ProtocolUser, params: Record<string, unknown>): Json {
  return {
    tag: "proxy",
    protocol: "trojan",
    settings: {
      servers: [
        {
          address: user.connection.host,
          port: user.connection.port,
          password: user.credentials.password,
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "tls",
      tlsSettings: {
        serverName: params.serverName,
        fingerprint: "chrome",
        alpn: ["h2", "http/1.1"],
      },
    },
  };
}

/** Shadowsocks 2022.
 *
 * No streamSettings at all, and that is the whole character of it: there
 * is no TLS to configure and no handshake to disguise, because the
 * protocol encrypts everything itself and looks like random bytes from
 * the first packet. Nothing to fingerprint -- and equally nothing to
 * hide behind once the port is known, which is why it complements the
 * certificate-based transports rather than replacing them.
 */
function shadowsocksOutbound(user: ProtocolUser, params: Record<string, unknown>): Json {
  return {
    tag: "proxy",
    protocol: "shadowsocks",
    settings: {
      servers: [
        {
          address: user.connection.host,
          port: user.connection.port,
          method: params.method,
          // Both halves, joined here rather than stored joined. The
          // server key belongs to the listener and the user key to the
          // customer; keeping them apart until now means rotating the
          // server key does not have to rewrite every credential.
          password: `${String(params.serverKey)}:${String(user.credentials.userKey)}`,
        },
      ],
    },
    // UDP inside TCP, so DNS, calls and games are not lost where UDP is
    // blocked. This was `uot: true` until the engine moved to xray-core
    // v26.6.27 (the TUN crash fix), which dropped Shadowsocks'
    // UDP-over-TCP (#6286) and ignores that key without a word -- every
    // UDP flow, DNS included, would have gone to the node as plain UDP.
    // Upstream's answer is XUDP over Xray's mux, the same shape the
    // Windows client has sent since 0.9.49 (engines/xray.rs): TCP stays
    // one connection each (`concurrency: -1`), UDP rides one muxed TCP
    // connection, and UDP/443 (QUIC) is carried as UoT carried it. The
    // nodes' Shadowsocks inbound dispatches through mux.Server, and
    // plugins/vpn/xray's engine tests carry UDP this way against a
    // 26.3.27 server, the version the nodes run.
    mux: { enabled: true, concurrency: -1, xudpConcurrency: 16, xudpProxyUDP443: "allow" },
  };
}

/** Whether this build can connect with the given protocol. */
export function isXrayProtocol(protocol: string): boolean {
  return (
    protocol === "XRAY_VLESS_REALITY" ||
    protocol === "XRAY_VLESS_TLS" ||
    protocol === "XRAY_TROJAN" ||
    // Not an "Xray protocol" by name, but it is served by the same
    // engine and built as an ordinary xray outbound, which is all this
    // predicate is really asking.
    protocol === "SHADOWSOCKS"
  );
}

/** The full config, ready to hand to the engine.
 *
 * Throws rather than returning a half-built config: a missing REALITY
 * public key produces a tunnel that comes up and silently carries
 * nothing, which is far harder to diagnose than a refusal naming the
 * field that was absent.
 */
export function buildXrayConfig(user: ProtocolUser, quic: VisionQuic = VISION_QUIC): string {
  const params = (user.connection.publicParams ?? {}) as Record<string, unknown>;
  // Defaulted for nodes registered before the column existed, which were
  // all plain TCP.
  const transport = user.connection.transport ?? "TCP";

  let outbound: Json;
  switch (user.protocol) {
    case "XRAY_VLESS_REALITY":
      // shortId is checked alongside the rest, not left out of it.
      // Omitting it from this list is what let an empty one through to
      // a server that would then treat the customer as a stranger and
      // send them to the camouflage site.
      if (
        !params.serverName ||
        !(params.publicKey ?? params.realityPublicKey) ||
        !shortIdFrom(params)
      ) {
        throw new Error("This server is missing its REALITY parameters");
      }
      outbound = realityOutbound(user, params, quic);
      break;
    case "XRAY_VLESS_TLS":
      if (!params.serverName) throw new Error("This server is missing its TLS server name");
      outbound = vlessTlsOutbound(user, params, transport, quic);
      break;
    case "XRAY_TROJAN":
      if (!params.serverName) throw new Error("This server is missing its TLS server name");
      outbound = trojanOutbound(user, params);
      break;
    case "SHADOWSOCKS":
      // Both halves are required. Without the server key the password is
      // half a secret, which authenticates nobody and produces a tunnel
      // that connects and carries nothing.
      if (!params.serverKey || !params.method) {
        throw new Error("This server is missing its Shadowsocks parameters");
      }
      outbound = shadowsocksOutbound(user, params);
      break;
    default:
      throw new Error(`${user.protocol} is not an Xray protocol`);
  }

  const rules: Json[] = [
    // The tunnel's lookups, to the engine's resolver (ENGINE_RESOLVERS).
    // First, so a lookup sent to an IPv6 resolver is answered rather than
    // refused by the next rule. Matched on `tun-in`: the resolver's own
    // connections carry the DNS app's tag instead, match no rule, and so
    // take the first outbound -- the proxy. One that matched here would
    // loop back into the DNS outbound.
    { type: "field", inboundTag: ["tun-in"], port: "53", outboundTag: DNS_OUT_TAG },
    // No IPv6, closed on the phone. The nodes leave over IPv4 only and
    // refuse IPv6 (`block-ipv6-egress` in the node template), but only
    // after the phone's own netstack has completed the handshake and the
    // server has been dialled: "connected, then dead" a round trip later.
    // Here it is closed before anything is dialled. Lookups no longer
    // return IPv6 addresses (queryStrategy below), so this catches only
    // literals. iOS keeps its IPv6 default route, which is what stops
    // IPv6 leaving outside the tunnel.
    { type: "field", ip: ["::/0"], outboundTag: BLOCK_TAG },
  ];
  if (quic === "drop-locally" && outbound.protocol === "vless" && user.credentials.flow === VISION) {
    rules.push({ type: "field", inboundTag: ["tun-in"], network: "udp", port: "443", outboundTag: BLOCK_TAG });
  }

  return JSON.stringify({
    log: { loglevel: "warning" },
    // The bytes sent and received through the server, which the engine
    // reads back for the app's speeds (Uplink and Downlink in
    // plugins/vpn/xray/xray.go, under the outbound's tag "proxy"). A count
    // of the customer's own traffic, never an estimate; each section is an
    // xray-core app the engine package registers, or core.New refuses the
    // config (counters_test.go there builds these two).
    stats: {},
    policy: {
      system: { statsOutboundUplink: true, statsOutboundDownlink: true },
      // The DNS outbound's own level: see LOOKUP_IDLE_SECS.
      levels: { [LOOKUP_LEVEL]: { connIdle: LOOKUP_IDLE_SECS } },
    },
    // The engine's resolver: app/dns, registered in plugins/vpn/xray.
    // IPv4 only, so an AAAA question gets an empty answer and apps stop
    // trying IPv6 the nodes would refuse anyway. The cache is xray-core's
    // own, with its defaults: entries live for their TTL and are swept
    // every 5 minutes, no stale answers kept (`serveStale` off). It has no
    // entry cap to set; at a few hundred bytes a name it stays far below
    // the iPhone extension's memory limit.
    dns: { servers: ENGINE_RESOLVERS, queryStrategy: "UseIPv4", enableParallelQuery: false },
    inbounds: [
      {
        tag: "tun-in",
        protocol: "tun",
        // Port and listen are ignored by this inbound -- it is not a
        // proxy and never binds. On Android the device itself arrives
        // out of band, as the file descriptor VpnService created.
        port: 0,
        settings: { name: "neoxify", MTU: TUN_MTU },
      },
    ],
    // The proxy stays first: it is where anything no rule names goes,
    // the resolver's own connections included.
    outbounds: [
      outbound,
      {
        tag: DNS_OUT_TAG,
        protocol: "dns",
        settings: {
          // Whatever is passed on goes over TCP, wherever it was sent.
          rewriteNetwork: "tcp",
          // A lookup's session lets go LOOKUP_IDLE_SECS after its last
          // question, not after the default 300 s.
          userLevel: LOOKUP_LEVEL,
          rules: [
            // A and AAAA from the engine's resolver and its cache.
            { action: "hijack", qType: "1,28" },
            // SVCB and HTTPS records: an empty answer, which is what any
            // resolver says for a name without one, and clients then use
            // the A answer. Android and iOS ask for HTTPS records beside
            // ordinary lookups, and passing each on would be a new
            // connection through the proxy -- the per-lookup handshake
            // this change exists to remove. What is lost is the hint
            // (HTTP/3, ECH) those records carry, nothing a page needs.
            { action: "return", qType: "64,65" },
            // Anything else -- SRV, TXT, MX -- as it is, through the
            // proxy, rather than the empty answer this outbound gives
            // by default. The desktop does the same.
            { action: "direct" },
          ],
        },
        proxySettings: { tag: "proxy" },
      },
      { tag: BLOCK_TAG, protocol: "blackhole" },
    ],
    routing: { domainStrategy: "AsIs", rules },
  });
}
