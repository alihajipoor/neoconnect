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

type Json = Record<string, unknown>;

function realityOutbound(user: ProtocolUser, params: Record<string, unknown>): Json {
  return {
    tag: "proxy",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: user.connection.host,
          port: user.connection.port,
          users: [
            { id: user.credentials.uuid, encryption: "none", flow: user.credentials.flow ?? "" },
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
        shortId: params.shortId,
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

function vlessTlsOutbound(user: ProtocolUser, params: Record<string, unknown>, transport: string): Json {
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
            // simply passes through whatever was issued.
            { id: user.credentials.uuid, encryption: "none", flow: user.credentials.flow ?? "" },
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

/** Whether this build can connect with the given protocol. */
export function isXrayProtocol(protocol: string): boolean {
  return protocol === "XRAY_VLESS_REALITY" || protocol === "XRAY_VLESS_TLS" || protocol === "XRAY_TROJAN";
}

/** The full config, ready to hand to the engine.
 *
 * Throws rather than returning a half-built config: a missing REALITY
 * public key produces a tunnel that comes up and silently carries
 * nothing, which is far harder to diagnose than a refusal naming the
 * field that was absent.
 */
export function buildXrayConfig(user: ProtocolUser): string {
  const params = (user.connection.publicParams ?? {}) as Record<string, unknown>;
  // Defaulted for nodes registered before the column existed, which were
  // all plain TCP.
  const transport = user.connection.transport ?? "TCP";

  let outbound: Json;
  switch (user.protocol) {
    case "XRAY_VLESS_REALITY":
      if (!params.serverName || !(params.publicKey ?? params.realityPublicKey)) {
        throw new Error("This server is missing its REALITY parameters");
      }
      outbound = realityOutbound(user, params);
      break;
    case "XRAY_VLESS_TLS":
      if (!params.serverName) throw new Error("This server is missing its TLS server name");
      outbound = vlessTlsOutbound(user, params, transport);
      break;
    case "XRAY_TROJAN":
      if (!params.serverName) throw new Error("This server is missing its TLS server name");
      outbound = trojanOutbound(user, params);
      break;
    default:
      throw new Error(`${user.protocol} is not an Xray protocol`);
  }

  return JSON.stringify({
    log: { loglevel: "warning" },
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
    outbounds: [outbound],
  });
}
