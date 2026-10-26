/** Fresh credentials in the middle of a ladder pass.
 *
 * A pass dials what it holds: the answer the screen loaded, or the cache
 * inside its ten-minute horizon (`refreshConnectionConfig`), without asking.
 * When a rung's tunnel comes up and carries nothing on a credential nobody
 * asked about this pass, the credentials are asked for again at once -- not
 * after the rest of the ladder has been walked on the same answer -- and the
 * rungs still to come are dialled on what comes back. A rung that carried
 * nothing on a credential the server has since changed is dialled again on
 * the new one, once, before the ladder moves on: the node refusing an old
 * credential says nothing about its route.
 *
 * Nothing is ever dropped: a rung the fresh answer holds no copy of is
 * dialled as it was. A protocol is never taken off the ladder. */

import type { ProtocolUser } from "./types";

/** How many times one pass asks for fresh credentials: once, and once more
 * if that answer did not come from the server. */
export const FRESH_ASKS = 2;

/** One pass's ask for fresh credentials (the Windows ladder's).
 *
 * Asked only where the caller calls `ask`: once a rung that carried nothing
 * is torn down. Asked while its tunnel was still up, the question went into
 * it -- with the tunnel's IPv4 confined, the app's only way out -- and a
 * node refusing the credential carries nothing, so the answer the ask
 * exists for never came; and it was never asked again in that pass.
 *
 * Now an ask that did not come back from the server is asked once more, at
 * the next `ask` -- the next teardown: the ladder does not wait for it, and
 * the next rung's tunnel may come up under it. Never two at once, and never
 * after the server has answered. Never rejects. */
export function createFreshAsk(
  request: () => Promise<{ source: string; protocolUsers: ProtocolUser[] }>,
  onAnswer: (protocolUsers: ProtocolUser[]) => void = () => undefined,
): {
  /** Asks, unless an ask is in flight, the server has answered, or it has
   * been asked `FRESH_ASKS` times. */
  ask(): void;
  /** The ask in flight, or null. */
  pending(): Promise<void> | null;
  /** The server's answer, once: null before it, and after it is taken. */
  take(): ProtocolUser[] | null;
} {
  let asked = 0;
  let answered = false;
  let inFlight: Promise<void> | null = null;
  let answer: ProtocolUser[] | null = null;
  return {
    ask() {
      if (answered || inFlight !== null || asked >= FRESH_ASKS) return;
      asked += 1;
      inFlight = request()
        .then(
          (reply) => {
            if (reply.source !== "network") return;
            answered = true;
            answer = reply.protocolUsers;
            onAnswer(reply.protocolUsers);
          },
          () => undefined,
        )
        .finally(() => {
          inFlight = null;
        });
    },
    pending() {
      return inFlight;
    },
    take() {
      const taken = answer;
      answer = null;
      return taken;
    },
  };
}

/** What a dial of `user` sends: which credential, its secrets, and where. */
function dialKey(user: ProtocolUser): string {
  const c = user.connection;
  return JSON.stringify([user.id, user.credentials, c?.host, c?.port, c?.transport, c?.security, c?.publicParams]);
}

/** `user`'s copy in a fresh answer: by its id, or else the credential that
 * answer holds for the same subscription, route and protocol -- one replaced
 * on the server keeps neither its id nor its secrets. Null when it holds
 * none. */
export function freshCopyOf(user: ProtocolUser, fresh: readonly ProtocolUser[]): ProtocolUser | null {
  return (
    fresh.find((f) => f.id === user.id) ??
    fresh.find((f) => f.subscriptionId === user.subscriptionId && f.routeId === user.routeId && f.protocol === user.protocol) ??
    null
  );
}

/** Whether the server has changed what a dial of `dialled` would send. */
export function credentialChanged(dialled: ProtocolUser, fresh: ProtocolUser): boolean {
  return dialKey(dialled) !== dialKey(fresh);
}

/** The rest of a ladder once a fresh answer is in: first, once each, the
 * rungs whose tunnel came up and carried nothing on a credential that has
 * changed since (`carriedNothing`), on the new one; then every rung still to
 * come, on its fresh copy, or as it was when the answer holds none. */
export function onFreshCredentials(
  remaining: readonly ProtocolUser[],
  carriedNothing: readonly ProtocolUser[],
  fresh: readonly ProtocolUser[],
): ProtocolUser[] {
  const again: ProtocolUser[] = [];
  for (const dialled of carriedNothing) {
    const copy = freshCopyOf(dialled, fresh);
    if (copy !== null && credentialChanged(dialled, copy) && !again.some((a) => a.id === copy.id)) again.push(copy);
  }
  const tried = new Set(again.map((a) => a.id));
  const rest = remaining.map((user) => freshCopyOf(user, fresh) ?? user).filter((user) => !tried.has(user.id));
  return [...again, ...rest];
}
