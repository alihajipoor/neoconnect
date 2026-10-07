import { invoke } from "@tauri-apps/api/core";

/** Where a credential's tunnel is dialled, as addresses -- the egress
 * check's `TunnelServer` (see egress.ts).
 *
 * The client routes this address around the tunnel so the tunnel's own
 * packets can reach the server, and an API mirror on the same node is
 * therefore asked over the customer's own line. Measured on 2026-10-06:
 * through a working tunnel to finland1, finland1's own mirror answered
 * `/health/ip` with the VM's home address while every other endpoint
 * answered the node's.
 *
 * Shared by both apps (the phones take this file through `@shared`).
 */

/** What of a credential names its server. Structural, so both apps'
 * `ProtocolUser` fit, and a credential missing any of it still does. */
export type DialledCredential = {
  connection?: { host?: string; publicParams?: Record<string, unknown> } | null;
  credentials?: Record<string, unknown> | null;
};

/** How long resolving one server name may take. The connect ladder asks
 * before every rung; a name that does not resolve in this long is one
 * the engine itself would be failing to dial. */
export const RESOLVE_TIMEOUT_MS = 2_000;

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
 * than knowing which engine reads which, and an address of the node that
 * this engine did not dial is still the node: an endpoint there answers
 * from around the tunnel or from the node itself, neither of them the
 * tunnel's exit as the world sees it. */
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

/** The addresses a credential's tunnel is dialled at.
 *
 * Literals as they are; a name resolved through the system resolver,
 * IPv4 only, the way the engines resolve it (`resolve_ipv4` in
 * health_ip.rs). Asked just before the rung is dialled, which is when
 * the engine asks too. A name that cannot be resolved contributes
 * nothing -- the check then simply cannot recognise that server, which
 * is how it behaved before it could recognise any.
 *
 * Never throws. */
export async function tunnelServerOf(
  user: DialledCredential,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<Set<string>> {
  const addresses = new Set<string>();
  const names: string[] = [];
  for (const host of serverHostsOf(user)) {
    if (isAddressLiteral(host)) addresses.add(host.replace(/^\[|\]$/g, ""));
    else names.push(host);
  }
  // At once, so a rung waits on the slowest name rather than the sum.
  const resolved = await Promise.all(
    names.map((host) =>
      invoke<unknown>("resolve_ipv4", { host, timeoutMs })
        // Unresolvable, or a build without the command: nothing known.
        .catch(() => []),
    ),
  );
  for (const list of resolved) {
    if (!Array.isArray(list)) continue;
    for (const address of list) if (typeof address === "string" && address) addresses.add(address);
  }
  return addresses;
}
