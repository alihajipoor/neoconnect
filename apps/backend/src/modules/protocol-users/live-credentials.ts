import type { Prisma } from "@prisma/client";

/** The credentials that should exist on their nodes right now -- what the
 * re-assert puts back every 60 s, and what a plan's new speed cap is
 * pushed to.
 *
 * ACTIVE alone is not enough:
 *
 * * A device credential whose session has been signed out is on its way
 *   off the nodes. Sign-out sends DELETE_USER and then deletes the row;
 *   if the delete fails after the command went out, or the sessions were
 *   ended in bulk and the sweep has not reached them yet, the row is
 *   still ACTIVE -- and a re-assert of it put the signed-out device's
 *   credential straight back, for up to an hour.
 *
 * Shared credentials (no session) are always included. */
export function liveCredentialWhere(): Prisma.ProtocolUserWhereInput {
  return {
    status: "ACTIVE",
    AND: [{ OR: [{ sessionId: null }, { session: { is: { revokedAt: null } } }] }],
  };
}
