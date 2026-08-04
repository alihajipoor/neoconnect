import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints } from "./api-endpoints";

/** Proving a tunnel actually carries traffic, rather than merely existing.
 *
 * The obvious check -- "can I reach 8.8.8.8 / google.com after
 * connecting?" -- looks right and is not sufficient. It proves the
 * internet works, not that it works *through the VPN*. A tunnel that
 * came up but is carrying nothing leaves the normal route intact, so the
 * probe succeeds and the app reports success: precisely the false
 * "Connected" this exists to catch.
 *
 * Comparing the public IP before and after has no such hole. If the
 * world sees a different address afterwards, the packets provably left
 * via somewhere else. If it sees the same one, traffic is bypassing the
 * tunnel no matter how healthy the interface looks.
 */

/** Short: this runs while the customer is watching a spinner, and a
 * server that will not answer quickly has already failed the check. */
const EGRESS_TIMEOUT_MS = 6000;

async function publicIp(): Promise<string | null> {
  // The same endpoint list the rest of the app uses, and for a sharper
  // reason here: this check decides whether the customer is told they
  // are protected. Pinned to one address, a blocked control plane would
  // report a perfectly working tunnel as carrying nothing -- turning a
  // reachability problem into a false accusation against the VPN.
  //
  // Each endpoint gets its own budget rather than sharing one. A first
  // address that is blocked burns the whole timeout doing nothing, and a
  // shared deadline would leave the working one no time to answer.
  for (const base of await apiEndpoints()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EGRESS_TIMEOUT_MS);
      const res = await fetch(`${base}/health/ip`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = (await res.json()) as { ip?: string };
      if (body.ip) return body.ip;
    } catch {
      // Try the next one. Exhausting the list returns null, which the
      // caller already treats as "no evidence" rather than as failure.
    }
  }
  return null;
}

/** The address the world saw before connecting, for later comparison.
 *
 * Null means we could not establish a baseline. That is not a failure to
 * report to anyone -- it just means the after-check has nothing to
 * compare against and must not claim the tunnel is broken.
 */
export const captureBaselineIp = publicIp;

export type EgressVerdict =
  /** The exit address changed: traffic is provably leaving via the VPN. */
  | { state: "throughTunnel"; exitIp: string }
  /** Reachable, but from the same address as before -- the tunnel is not
   * carrying this traffic. The leak case. */
  | { state: "bypassingTunnel"; exitIp: string }
  /** Nothing answered. Either the tunnel is black-holing traffic or the
   * connection is genuinely down; both mean the customer is not working. */
  | { state: "unreachable" }
  /** No baseline, so no comparison is possible. Reported rather than
   * guessed, so the UI can stay quiet instead of alarming. */
  | { state: "indeterminate"; exitIp: string | null };

export async function verifyEgress(baselineIp: string | null): Promise<EgressVerdict> {
  const exitIp = await publicIp();

  if (exitIp === null) return { state: "unreachable" };
  if (baselineIp === null) return { state: "indeterminate", exitIp };
  return exitIp === baselineIp
    ? { state: "bypassingTunnel", exitIp }
    : { state: "throughTunnel", exitIp };
}
