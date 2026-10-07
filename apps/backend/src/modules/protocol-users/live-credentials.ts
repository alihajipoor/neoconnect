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
 * * A credential the device-limit backstop is holding (heldUntil in the
 *   future) is meant to stay off its node. Re-asserting it undid every
 *   cut within a minute; the backstop's hold is only durable because
 *   this skips it. When the hold lapses, the next re-assert restores the
 *   credential as it is then -- never a list captured at the cut.
 *
 * * A credential of a subscription that is not ACTIVE is not live,
 *   whatever its own status says. Suspension and expiry switch every
 *   credential off as they happen, so this changes nothing for them; it
 *   is for the rows provisionAll used to mint ACTIVE on PENDING,
 *   CANCELLED, EXPIRED and SUSPENDED subscriptions, which this re-assert
 *   then kept putting back every minute.
 * * Nor is a credential of a customer an operator has DISABLED. Disabling
 *   takes them off the nodes without rewriting their status (see
 *   ProtocolUsersService.switchOffCustomer); this is what keeps them off,
 *   and what brings back exactly the ones still ACTIVE once the customer
 *   is ACTIVE again.
 *
 * Shared credentials (no session) are always included unless held.
 *
 * Combine it with other conditions through `AND: [liveCredentialWhere(),
 * {...}]`, not by spreading it into an object that has the same keys: it
 * sets `status`, `subscription` and `AND`, and a spread silently replaces
 * whichever of those the other side also sets. That is how a plan's new
 * speed cap reached every plan (PlansService.reapplyRateLimits). */
export function liveCredentialWhere(now = new Date()): Prisma.ProtocolUserWhereInput {
  return {
    status: "ACTIVE",
    subscription: { status: "ACTIVE", customer: { status: "ACTIVE" } },
    AND: [
      { OR: [{ sessionId: null }, { session: { is: { revokedAt: null } } }] },
      { OR: [{ heldUntil: null }, { heldUntil: { lte: now } }] },
    ],
  };
}
