import type { Node, ProtocolConfig, Route } from "./types";

/** Retired servers, for the panel's own lists.
 *
 * A retired server is a node whose status is DISABLED. It stays in the
 * database on purpose: deleting a node wipes the usage history that
 * points at it (see the node retirement notes). So the panel keeps
 * receiving it, and these helpers are how pages put it out of the way
 * without pretending it never existed.
 *
 * Only the panel's lists use this. What the API returns to the customer
 * apps is not touched here.
 */
export function isRetiredNode(node: Pick<Node, "status"> | undefined): boolean {
  return node?.status === "DISABLED";
}

export function retiredNodeIds(nodes: Pick<Node, "id" | "status">[]): Set<string> {
  return new Set(nodes.filter(isRetiredNode).map((n) => n.id));
}

export interface RouteServers {
  /** The node the customer's app dials. */
  entry: Node | undefined;
  /** Where a relayed route leaves; undefined for a direct route. */
  exit: Node | undefined;
  relayed: boolean;
}

export function routeServers(
  route: Pick<Route, "entryProtocolConfigId" | "exitProtocolConfigId">,
  protocolConfigs: Pick<ProtocolConfig, "id" | "nodeId">[],
  nodes: Node[],
): RouteServers {
  const nodeOf = (configId: string | null) => {
    if (!configId) return undefined;
    const pc = protocolConfigs.find((c) => c.id === configId);
    return pc ? nodes.find((n) => n.id === pc.nodeId) : undefined;
  };
  return {
    entry: nodeOf(route.entryProtocolConfigId),
    exit: nodeOf(route.exitProtocolConfigId),
    relayed: Boolean(route.exitProtocolConfigId),
  };
}

/** A route is retired when either of its servers is: a relay to a
 * retired exit carries nobody anywhere, however healthy the relay is. */
export function isRetiredRoute(servers: RouteServers): boolean {
  return isRetiredNode(servers.entry) || isRetiredNode(servers.exit);
}

/** Whether a protocol config sits on a retired server. */
export function isRetiredConfig(pc: Pick<ProtocolConfig, "nodeId">, retired: Set<string>): boolean {
  return retired.has(pc.nodeId);
}

export interface RouteGroup {
  key: string;
  /** Server name, or the relay's name with "(relay)". */
  label: string;
  retired: boolean;
  routes: Route[];
}

/** Routes grouped by the server they belong to: live servers first.
 *
 * A direct route belongs to its entry server. Relayed routes are grouped
 * under the relay they enter through, apart from that exit's direct
 * routes: ticking "all of germany-3" must not quietly add the relay
 * routes too, which are a different product.
 *
 * A route whose config or node cannot be found goes under "Unknown
 * server" rather than disappearing.
 */
export function groupRoutesByServer(
  routes: Route[],
  protocolConfigs: Pick<ProtocolConfig, "id" | "nodeId">[],
  nodes: Node[],
): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const route of routes) {
    const servers = routeServers(route, protocolConfigs, nodes);
    const node = servers.entry;
    const key = `${servers.relayed ? "relay" : "direct"}:${node?.id ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      const name = node?.name ?? "Unknown server";
      group = {
        key,
        label: servers.relayed ? `${name} (relay)` : name,
        // A relay group is retired only when its relay is; its routes to
        // retired exits are hidden one by one below.
        retired: isRetiredNode(node),
        routes: [],
      };
      groups.set(key, group);
    }
    group.routes.push(route);
  }
  // Live servers first, then retired ones, each in name order.
  return [...groups.values()].sort(
    (a, b) => Number(a.retired) - Number(b.retired) || a.label.localeCompare(b.label),
  );
}
