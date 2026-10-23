import type { IspTag } from "./types";
import type { UplinkStep } from "./uplink-watch";

/** Whether the map's evidence still describes the network the device is on.
 *
 * The map's legend says "for the network you're on now", and two of its
 * three sources are about one network: this device's own history is filed
 * under the gateway fingerprint (`network_fingerprint`), and the route
 * list's per-network tags were made for the network the list was asked
 * with. Both are read at a load. A window left open while its owner moves
 * from home Wi-Fi to mobile data -- common in Iran -- kept twinkling the
 * Wi-Fi's evidence under that legend.
 *
 * So a roam is noted when it is seen, and until each source has been read
 * again since, the map does without it: steady "not proven" dots, which
 * claim nothing. The connected light is about the tunnel, not the network,
 * and is untouched.
 *
 * Pure, so the rules can be pinned without a screen. */

export interface NetworkFreshness {
  /** When the way out last changed under this screen; null for never. */
  roamedAt: number | null;
  /** When the network id in hand was asked for. */
  idReadAt: number;
  /** When the route list's tags were made: when the network reading the
   * list was asked with was taken, or the ask itself when there was none
   * (the server then tags by the request's own address). */
  tagsReadAt: number;
}

export const NO_ROAM: NetworkFreshness = { roamedAt: null, idReadAt: 0, tagsReadAt: 0 };

/** The network id the map may read this device's history under: null --
 * none -- from a roam until the id has been asked for again. */
export function mapNetwork(networkId: string | null, fresh: NetworkFreshness): string | null {
  return fresh.roamedAt === null || fresh.idReadAt >= fresh.roamedAt ? networkId : null;
}

/** Whether the route list's per-network tags describe this network: not
 * after a roam, until a list asked with a network reading taken since has
 * arrived. */
export function tagsCurrent(fresh: NetworkFreshness): boolean {
  return fresh.roamedAt === null || fresh.tagsReadAt >= fresh.roamedAt;
}

/** The list without its per-network tags, for when they are not current. */
export function withoutTags<T extends { ispTag?: IspTag | null }>(routes: readonly T[]): T[] {
  return routes.map((route) => (route.ispTag ? { ...route, ispTag: null } : route));
}

/** How often the way out is looked at while nothing is up. A local table
 * read (`network_uplinks`); nothing leaves the machine. Slower than the
 * live tunnel's watch: nothing is at stake but the map's words. */
export const IDLE_WAY_OUT_POLL_MS = 3_000;

/** One look while nothing is up: another way out than this stretch began
 * on is a roam. No answer, or no way out at all, is not news -- the way
 * out that comes back is compared with the one before. */
export function idleWayOut(prev: string | null, seen: string | null): { next: string | null; roamed: boolean } {
  if (seen === null || seen === "") return { next: prev, roamed: false };
  if (prev === null) return { next: seen, roamed: false };
  return { next: seen, roamed: seen !== prev };
}

/** What the live tunnel's watch (`nextUplink`) saw, for the map:
 *  - `moved`: re-verified onto another way out -- a roam, or a new address;
 *  - `lost`: no way out at all, so whichever network comes back is not
 *    known to be this one;
 *  - null: nothing, or the same way out back after a blip. */
export function tunnelWayOut(prevSeen: string | null, step: UplinkStep, nextSeen: string | null): "moved" | "lost" | null {
  if (step === "lost") return "lost";
  if (step !== "recheck") return null;
  return prevSeen !== null && prevSeen !== "" && nextSeen !== null && nextSeen !== "" && nextSeen !== prevSeen ? "moved" : null;
}
