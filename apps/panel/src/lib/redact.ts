import type { MutationResult } from "./api";

/**
 * Secrets the API hands the panel's server that no page needs, taken out
 * before a row becomes a prop of a client component or the return value
 * of a server action -- either of which Next serialises into what the
 * browser receives, whatever the TypeScript type says. `canManage=false`
 * hid buttons; the RSC payload still carried the keys to every staff
 * role's page source.
 *
 * - OpenVPN's CA and server private keys, which live in publicParamsJson
 *   despite the column's name (docs/journal/log.md, 2026-08-31). With the
 *   CA key anyone can mint a client certificate the node accepts and no
 *   customer owns; with the server key, impersonate the node. Neither is
 *   needed to edit a config: the backend keeps both when a PATCH omits
 *   them (SERVER_MANAGED_PUBLIC_PARAMS in protocol-configs.service.ts).
 *   tlsCryptKey stays: every customer receives it anyway, and a PATCH
 *   without it would erase it.
 * - A relay route's uplinkCredentialsJson: a working credential on the
 *   exit node, metered to nobody. Nothing in the panel reads it.
 *
 * The backend withholds these from GET responses as well; this is the
 * panel's own line, so the next page to forget a filter does not ship
 * them.
 */
export const PRIVATE_PUBLIC_PARAMS = ["caKeyPem", "serverKeyPem"] as const;

export function withoutConfigSecrets<T extends { publicParamsJson?: unknown }>(config: T): T {
  const params = config.publicParamsJson;
  if (!params || typeof params !== "object" || Array.isArray(params)) return config;
  const kept = { ...(params as Record<string, unknown>) };
  for (const key of PRIVATE_PUBLIC_PARAMS) delete kept[key];
  return { ...config, publicParamsJson: kept };
}

export function withoutRouteSecrets<T extends object>(route: T): Omit<T, "uplinkCredentialsJson"> {
  const { uplinkCredentialsJson: _secret, ...rest } = route as T & { uplinkCredentialsJson?: unknown };
  void _secret;
  return rest;
}

/** A mutation's result with its row passed through `redact`, for server
 * actions that return what the backend sent back. */
export function redactResult<T, R>(result: MutationResult<T>, redact: (row: T) => R): MutationResult<R> {
  return result.ok ? { ok: true, data: redact(result.data) } : result;
}
