import type { ServerDoor } from "./types";

/** The servers' doors this device holds: the ones in the server list it
 * last kept (credential-cache.ts).
 *
 * A file of its own, with nothing in it but the list, because two sides
 * meet here that must not import each other. The credential cache says
 * what the list is -- every time it reads or writes the snapshot, and
 * when a sign-out clears it -- and server-doors.ts reads it when a
 * request has nowhere else to go. Kept in memory so that asking costs a
 * request nothing, and replaced whole each time: a server that is no
 * longer in the list has no door here either, which is how a replaced
 * server's door goes away with no other step.
 *
 * The doors come only from the API's own answers to this signed-in
 * customer, and from the cache of them. Nothing else adds one. */

/** What is held. Null until the cache has said anything in this run. */
let known: ServerDoor[] | null = null;

/** Reads the cache, when it has not been read yet (`knownDoors`). */
let primer: (() => Promise<unknown>) | null = null;
let primed = false;

const PIN = /^sha256\/[A-Za-z0-9+/]{43}=$/;
const ADDRESS = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isServerName(value: string): boolean {
  return value.length <= 253 && /[a-z]/.test(value) && value.split(".").every((label) => LABEL.test(label));
}

/** One door, read defensively: the list is cached across versions of the
 * app and of the backend, and a door that is not whole is no door. The
 * command that dials one checks it again, and more strictly
 * (`parse_door` in src-tauri/src/door_http.rs). */
function doorOf(value: unknown): ServerDoor | null {
  if (value === null || typeof value !== "object") return null;
  const { host, port, pins, sni } = value as Record<string, unknown>;
  if (typeof host !== "string" || !ADDRESS.test(host)) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Array.isArray(pins) || pins.length < 1 || pins.length > 3) return null;
  if (!pins.every((pin): pin is string => typeof pin === "string" && PIN.test(pin))) return null;
  if (new Set(pins).size !== pins.length) return null;
  if (sni !== null && sni !== undefined && (typeof sni !== "string" || !isServerName(sni))) return null;
  return { host, port, pins: [...pins], sni: sni ?? null };
}

/** The doors in a server list, one per server and port, in the list's
 * order. Several credentials on one server carry the same door. */
export function doorsFrom(users: readonly unknown[]): ServerDoor[] {
  const doors = new Map<string, ServerDoor>();
  for (const user of users) {
    const connection = (user as { connection?: { door?: unknown } } | null)?.connection;
    const door = doorOf(connection?.door);
    if (door === null) continue;
    const key = `${door.host}:${door.port}`;
    if (!doors.has(key)) doors.set(key, door);
  }
  return [...doors.values()];
}

/** The server list as the cache now holds it. */
export function rememberDoors(users: readonly unknown[]): void {
  known = doorsFrom(users);
}

/** No list is held: a sign-out, or a cache with nothing in it. */
export function forgetDoors(): void {
  known = [];
}

/** How to read the cache, for a run that needs a door before anything
 * else has read it. Set by credential-cache.ts as it loads. */
export function setDoorPrimer(read: (() => Promise<unknown>) | null): void {
  primer = read;
}

/** The doors held now. Never throws.
 *
 * Reads the cache first if nothing has in this run, and once only: an app
 * restarted on a network where doors were answering would otherwise send
 * its first request the long way round. */
export async function knownDoors(): Promise<ServerDoor[]> {
  if (known === null && !primed && primer !== null) {
    primed = true;
    try {
      await primer();
    } catch {
      // No cache is no doors.
    }
  }
  return known ?? [];
}

/** For tests: a run in which nothing has been read. */
export function resetDoorListForTests(): void {
  known = null;
  primed = false;
}
