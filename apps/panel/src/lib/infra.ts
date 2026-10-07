import "server-only";
import { apiFetch } from "./api";
import { withoutConfigSecrets, withoutRouteSecrets } from "./redact";
import type { ProtocolConfig, Route } from "./types";

/** GET /routes for a page, without the relay credentials. Pages read
 * routes and protocol configs through these and never through apiFetch
 * directly; redact.test.ts holds every page to that. */
export async function fetchRoutes(): Promise<Route[]> {
  return (await apiFetch<Route[]>("/routes")).map(withoutRouteSecrets);
}

/** GET /protocol-configs for a page, without OpenVPN's private keys. */
export async function fetchProtocolConfigs(): Promise<ProtocolConfig[]> {
  return (await apiFetch<ProtocolConfig[]>("/protocol-configs")).map(withoutConfigSecrets);
}
