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
