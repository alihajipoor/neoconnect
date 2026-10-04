import { invoke } from "@tauri-apps/api/core";
import type { Protocol, ProtocolUser } from "./types";

/** Which candidates can be reached right now, asked all at once.
 *
 * The ladder finds this out by dialling: spawn the engine, install
 * routes, wait out a settle budget, fail, tear down, move on. Each dead
 * protocol costs seconds -- OpenVPN alone spends ten to twenty
 * negotiating -- and they are tried in series, so three bad rungs is a
 * minute of "Connecting..." before anything that works is reached. That
 * is the shape of the complaint: people try three or four, conclude the
 * app does not work, and stop.
 *
 * A TCP handshake answers the cheap half of the same question for every
 * candidate simultaneously, in about a second, with nothing to tear
 * down afterwards.
 */

/** Protocols a TCP handshake can say anything about.
 *
 * WireGuard (UDP 51820), OpenVPN (UDP 1194) and IKEv2 (UDP 500/4500)
 * are not TCP, so a connect against them fails on a perfectly good
 * network. `measure_latency` already records this: it was measured at
 * 2661ms for both UDP protocols against 176ms for Xray on 443, which is
 * the timeout, not the network.
 *
 * So they are never probed, and -- this is the part that matters --
 * never treated as unreachable for not having been. Silence here means
 * "not asked", which must order the same as "asked and unknown", not
 * the same as "asked and failed". Getting that backwards would bury the
 * protocol that is some customers' only working option.
 */
function probeable(protocol: Protocol): boolean {
  return protocol.startsWith("XRAY_") || protocol === "SHADOWSOCKS";
}

export type Reachability = "reachable" | "unreachable" | "unknown";

/** Keyed `routeId|protocol`, for the candidates that were asked. */
export type ReachabilityMap = Record<string, Reachability>;

export function reachabilityKey(routeId: string, protocol: Protocol): string {
  return `${routeId}|${protocol}`;
}

export function reachabilityOf(
  map: ReachabilityMap | undefined,
  routeId: string,
  protocol: Protocol,
): Reachability {
  return map?.[reachabilityKey(routeId, protocol)] ?? "unknown";
}

/** Probes every TCP-carried candidate at once.
 *
 * Concurrent rather than sequential on purpose: these are independent
 * questions and the whole point is to have all the answers before the
 * first dial. A probe that throws is recorded as unknown rather than
 * unreachable -- a failure to *ask* is not an answer, and the ladder
 * must still be free to try it.
 */
export async function probeCandidates(users: ProtocolUser[]): Promise<ReachabilityMap> {
  const asked = users.filter((u) => probeable(u.protocol) && u.connection?.host);

  const results = await Promise.all(
    asked.map(async (u) => {
      const key = reachabilityKey(u.routeId, u.protocol);
      try {
        const ok = await invoke<boolean>("probe_tcp", {
          host: u.connection.host,
          port: u.connection.port,
        });
        return [key, ok ? "reachable" : "unreachable"] as const;
      } catch {
        return [key, "unknown"] as const;
      }
    }),
  );

  const map: ReachabilityMap = {};
  for (const [key, value] of results) map[key] = value;
  return map;
}
