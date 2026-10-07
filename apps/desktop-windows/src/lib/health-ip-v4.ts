import { invoke } from "@tauri-apps/api/core";
import type { HealthIpAnswer, HealthIpTransport } from "./egress";

/** `/health/ip` for the egress check, asked over IPv4 only, by
 * `health_ip::health_ip_v4` in the Rust side.
 *
 * Why it exists: through tauri-plugin-http the family was the system's
 * choice, and on a machine with native IPv6 the baseline -- taken on the
 * bare network -- came back as the customer's IPv6 address, while every
 * reading through a full tunnel is IPv4. Those never match, so the check
 * said "You're protected" on such machines whatever IPv4 was doing. With
 * both readings over IPv4 the comparison means what it says again; IPv6
 * is checked by its own instrument (`checkIpv6`).
 *
 * Both clients: installed from each app's `main.tsx`. The mobile app
 * compiles the same Rust file by path (`apps/mobile/src-tauri/src/lib.rs`)
 * and needed it more than Windows did: a phone's tunnel is IPv4 only on
 * both platforms, and a dual-stack phone's IPv6 baseline made every
 * rung of every connect "indeterminate".
 *
 * Its answer also carries `peer`, the address the request actually
 * connected to, passed through untouched: it is how the check recognises
 * an endpoint on the tunnel's own server, which is reached around the
 * tunnel (`TunnelServer` in egress.ts).
 */
export const ipv4OnlyHealthIp: HealthIpTransport = (base, timeoutMs) => {
  // The command has its own timeout; this one only guards against an
  // IPC reply that never comes, so a stalled call cannot hold the
  // egress walk past the endpoint's budget.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health_ip_v4: no reply")), timeoutMs + 1_000);
  });
  return Promise.race([invoke<HealthIpAnswer>("health_ip_v4", { base, timeoutMs }), stalled]).finally(() =>
    clearTimeout(timer),
  );
};
