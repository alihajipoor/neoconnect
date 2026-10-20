/** DEV ONLY: the cached plan the Plans page shows as "Current plan", from
 * the samples, for the dev preview (see mocks/customer.ts for how this is
 * swapped in). Everything not overridden here is the real module. */

export * from "../../lib/credential-cache";
import type { ConnectionSnapshot } from "../../lib/credential-cache";
import { SAMPLE_SUBSCRIPTION } from "./customer";

export async function loadSnapshot(): Promise<ConnectionSnapshot | null> {
  return {
    version: 1,
    savedAt: Date.now() - 4 * 60_000,
    askedAt: Date.now() - 4 * 60_000,
    subscription: SAMPLE_SUBSCRIPTION,
    protocolUsers: [],
    routes: [],
  };
}
