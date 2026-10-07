import type { Route } from "@/lib/types";

/**
 * What deleting a route does, for its confirmation dialog.
 *
 * The dialog used to say "Existing protocol users on it will block
 * deletion." That was true when it was written (e12e0cb) and stopped
 * being true a week later: since M23 the backend revokes every customer
 * credential on the route -- DELETE_USER on the node for each -- and then
 * deletes it. An operator relying on the promised refusal would take a
 * live path away from everyone on it, possibly the only one that works
 * on their network.
 */
export function routeDeleteWarning(
  route: Pick<Route, "id" | "name" | "exitProtocolConfigId" | "protocolUserCount">,
  trialRouteId?: string | null,
): string {
  const parts = [`This permanently removes ${route.name}. Customers on it do not stop the delete.`];
  const n = route.protocolUserCount;
  // "On the node" is a queued command (AgentGatewayService.enqueueCommand):
  // sent at once to a connected node, and to one that is not when it
  // reconnects -- which may be after the delete has long been forgotten.
  const delivery = "the node is told at once, or when it next connects if it is offline";
  if (n === undefined) {
    parts.push(`Every customer credential on it is revoked: ${delivery}.`);
  } else if (n === 0) {
    parts.push("No customer credentials are on it.");
  } else {
    parts.push(
      `${n === 1 ? "The 1 customer credential" : `All ${n} customer credentials`} on it ${n === 1 ? "is" : "are"} revoked: ${delivery}. Those customers lose this route and keep their others.`,
    );
  }
  if (route.exitProtocolConfigId) parts.push("Its uplink to the exit node is removed too.");
  if (trialRouteId && trialRouteId === route.id) {
    parts.push("It is the free-trial route: new sign-ups get no trial until another trial route is chosen in Settings.");
  }
  return parts.join(" ");
}
