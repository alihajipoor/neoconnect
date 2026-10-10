import { invoke } from "@tauri-apps/api/core";
import type { TunnelServer } from "./egress";

/** Where a credential's tunnel is dialled, as addresses, and whether this
 * client reaches that address around the tunnel or through it -- the
 * egress check's `TunnelServer` (see egress.ts).
 *
 * The two differ by platform and engine, and only one combination has
 * been measured: on Windows, through a working Stealth tunnel to
 * finland1 (2026-10-06), finland1's own mirror answered `/health/ip`
 * with the VM's home address while every other endpoint answered the
 * node's -- the service's host route for the server takes the app's
 * requests to that address around the tunnel too. Everything else in
 * `reachesServerAround` is read from source, and says so.
 *
 * Shared by both apps (the phones take this file through `@shared`).
 */

/** What of a credential names its server. Structural, so both apps'
 * `ProtocolUser` fit, and a credential missing any of it still does. */
export type DialledCredential = {
  protocol?: string;
  connection?: { host?: string; publicParams?: Record<string, unknown> } | null;
  credentials?: Record<string, unknown> | null;
};

/** Which client is asking. */
export type ClientPlatform = "windows" | "phone";

/** How long resolving one server name may take. The connect ladder asks
 * before every rung; a name that does not resolve in this long is one
 * the engine itself would be failing to dial. */
export const RESOLVE_TIMEOUT_MS = 2_000;

/** How much longer than its own bound `resolve_ipv4` is waited for
 * before it is given up on here. The command is bounded in Rust; this
 * only guards against a call that never comes back at all, as
 * `ipv4OnlyHealthIp` does for `health_ip_v4`. */
const RESOLVE_GRACE_MS = 1_000;

/** The engines whose own sockets are the only thing kept off the
 * tunnel on the phones. Every Xray protocol runs in one engine: on
 * Android a VpnService routing `0.0.0.0/0` into the tunnel, with only
 * xray-core's sockets `protect`ed (NeoxifyTunService.kt), and this app's
 * own traffic deliberately inside; on iOS a packet tunnel claiming the
 * default route with a made-up `tunnelRemoteAddress`, so no route is
 * excluded for the node (PacketTunnelProvider.swift). WireGuard the same
 * way: GoBackend protects its UDP socket and routes `AllowedIPs`, and on
 * iOS it shares that packet tunnel. Read from the source, NOT measured
 * on a device. */
const PHONE_THROUGH = new Set([
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_VMESS",
  "XRAY_TROJAN",
  "SHADOWSOCKS",
  "WIREGUARD",
]);

/** Whether this client reaches a route's server address around the
 * tunnel (true) or through it (false); see `TunnelServer` in egress.ts.
 *
 * Windows:
 *  - Xray protocols (and Shadowsocks, which runs in Xray): around. The
 *    service installs a host route for the server via the physical
 *    gateway (`routing::install_full_tunnel`), and every request to
 *    that address takes it. **Measured** for Stealth on 2026-10-06.
 *  - OpenVPN: around. `redirect-gateway` adds a host route for the
 *    remote via the old gateway. Not measured.
 *  - IKEv2: around. Windows' own client routes the server via the
 *    physical interface. Not measured.
 *  - WireGuard: through. wireguard.exe installs no route for the
 *    endpoint; it binds its own socket to the physical interface, and
 *    the rest of the machine's traffic to that address follows the
 *    tunnel's routes. From upstream's design, NOT measured here.
 *
 * Phones: through for Xray and WireGuard (see `PHONE_THROUGH`), around
 * for IKEv2 -- the system's own client, whose routing for its server is
 * not ours to read; assumed around because that is the direction whose
 * mistake costs "not confirmed" rather than an accusation. Not measured
 * either way.
 *
 * Anything not listed is taken to be around, for the same reason. */
export function reachesServerAround(platform: ClientPlatform, protocol: string | undefined): boolean {
  if (platform === "phone") return !(protocol !== undefined && PHONE_THROUGH.has(protocol));
  return protocol !== "WIREGUARD";
}

/** Every host a credential's engine may dial, as written.
 *
 *  - `connection.host` -- the node's `publicIp`, an address the server
 *    validates. What the Xray engines dial, and what the Windows service
 *    routes around the tunnel for them.
 *  - `publicParams.endpointHost` -- the certificate name IKEv2 dials on
 *    both platforms, because the certificate does not name the address.
 *  - the host half of `credentials.endpoint` -- "host:port", what the
 *    WireGuard and OpenVPN configs dial.
 *
 * All of them name the same node in practice. Listing each is cheaper
 * than knowing which engine reads which. */
export function serverHostsOf(user: DialledCredential): string[] {
  const hosts: string[] = [];
  const add = (host: unknown) => {
    if (typeof host !== "string") return;
    const trimmed = host.trim();
    if (trimmed && !hosts.includes(trimmed)) hosts.push(trimmed);
  };
  add(user.connection?.host);
  add(user.connection?.publicParams?.endpointHost);
  const endpoint = user.credentials?.endpoint;
  if (typeof endpoint === "string") add(hostOfEndpoint(endpoint));
  return hosts;
}

/** The host half of "host:port", "[v6]:port", or a bare host. */
export function hostOfEndpoint(endpoint: string): string {
  const text = endpoint.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) return bracketed[1];
  // One colon is host:port; more is a bare IPv6 address.
  const colons = text.split(":").length - 1;
  return colons === 1 ? text.slice(0, text.indexOf(":")) : text;
}

/** Whether `host` is an address literal rather than a name. */
export function isAddressLiteral(host: string): boolean {
  const plain = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(plain) || plain.includes(":");
}

/** A credential's server as far as its address literals name it, with
 * no resolver asked. `connection.host` is always one, so for the node
 * this is the whole answer; `tunnelServerOf` adds what names resolve to.
 *
 * For the steps that run before the previous rung's tunnel is known to
 * be gone -- the Windows settle -- where a lookup could still go into
 * that tunnel and answer from its resolver. */
export function literalTunnelServer(user: DialledCredential, platform: ClientPlatform): TunnelServer {
  const addresses = new Set<string>();
  for (const host of serverHostsOf(user)) {
    if (isAddressLiteral(host)) addresses.add(host.replace(/^\[|\]$/g, ""));
  }
  return { addresses, reachedAround: reachesServerAround(platform, user.protocol) };
}

/** The addresses a credential's tunnel is dialled at, and how this
 * client reaches them.
 *
 * Literals as they are; a name resolved through the system resolver,
 * IPv4 only, the way the engines resolve it (`resolve_ipv4` in
 * health_ip.rs). Asked once nothing of ours is up -- after the settle on
 * Windows, after the teardown wait on the phones -- just before the rung
 * is dialled, which is when the engine asks too. A name that cannot be
 * resolved contributes nothing: the check then simply cannot recognise
 * that server, which is how it behaved before it could recognise any.
 *
 * Never throws, and never waits much past `timeoutMs`, whatever the
 * command does. */
export async function tunnelServerOf(
  user: DialledCredential,
  platform: ClientPlatform,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<TunnelServer> {
  const literal = literalTunnelServer(user, platform);
  const addresses = new Set(literal.addresses);
  const names = serverHostsOf(user).filter((host) => !isAddressLiteral(host));
  // At once, so a rung waits on the slowest name rather than the sum.
  const resolved = await Promise.all(names.map((host) => resolveIpv4(host, timeoutMs)));
  for (const list of resolved) {
    for (const address of list) addresses.add(address);
  }
  return { addresses, reachedAround: literal.reachedAround };
}

/** `resolve_ipv4`, given up on a little after its own bound. Unresolvable,
 * a build without the command, or a call that never returns: nothing
 * known. */
export function resolveIpv4(host: string, timeoutMs: number): Promise<string[]> {
  return resolveWith(host, timeoutMs, false);
}

/** The same lookup with the name's IPv6 addresses kept as well -- every
 * address the HTTP plugin's own connection may try. How a race looks for
 * Iran's block page behind a name (`resolvesToBlockPage` in
 * endpoint-demotion.ts), which must not take a name for the block page
 * when it has a real IPv6 address too. A build whose command predates the
 * option answers IPv4 only, as before. */
export function resolveAddresses(host: string, timeoutMs: number): Promise<string[]> {
  return resolveWith(host, timeoutMs, true);
}

function resolveWith(host: string, timeoutMs: number, withIpv6: boolean): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs + RESOLVE_GRACE_MS);
  });
  const asked = invoke<unknown>("resolve_ipv4", withIpv6 ? { host, timeoutMs, withIpv6 } : { host, timeoutMs }).then(
    (list) => (Array.isArray(list) ? list.filter((a): a is string => typeof a === "string" && a !== "") : []),
    () => [],
  );
  return Promise.race([asked, stalled]).finally(() => clearTimeout(timer));
}

/** Our nodes' public addresses, as far as these credentials name them:
 * each one's `connection.host`, which the server fills with the node's
 * `publicIp`.
 *
 * For `captureBaselineIp`'s `nodeAddresses`, in both apps. A pre-connect
 * reading of one of these is never this device's own address; it is a
 * node mirror that answers `/health/ip` with its node's address to
 * everyone (or a tunnel not yet gone). Taken as the baseline, every
 * comparison through that mirror afterwards came back "the same address"
 * -- `bypassingTunnel`, which the ladder holds against the route and the
 * poll shows as "Your traffic is NOT protected" -- over a tunnel that
 * worked.
 *
 * The mirrors an app derives from its own credentials (`mirrorsFrom`)
 * live on exactly these nodes. One from the signed bundle on a node this
 * customer has no credential for is not covered here; the self-report
 * rule in egress.ts covers it wherever the transport reports the address
 * it connected to. */
export function nodeAddressesOf(users: readonly { connection?: { host?: string } | null }[]): Set<string> {
  const addresses = new Set<string>();
  for (const user of users) {
    const host = user.connection?.host?.trim();
    if (host) addresses.add(host);
  }
  return addresses;
}
