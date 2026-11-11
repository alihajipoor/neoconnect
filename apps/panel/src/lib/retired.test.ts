import { describe, expect, it } from "vitest";
import { groupRoutesByServer, isRetiredRoute, routeServers } from "./retired";
import type { Node, Route } from "./types";

const node = (id: string, status: Node["status"], role: Node["role"] = "STANDALONE"): Node => ({
  id,
  name: id,
  role,
  region: "x",
  publicIp: "",
  status,
  lastHeartbeatAt: null,
  agentVersion: null,
  agentPubKey: null,
  createdAt: "",
  updatedAt: "",
});
const route = (id: string, entry: string, exit: string | null = null): Route => ({
  id,
  name: id,
  entryProtocolConfigId: entry,
  exitProtocolConfigId: exit,
  isEnabled: true,
  createdAt: "",
  updatedAt: "",
});

const nodes = [node("live", "ONLINE"), node("old", "DISABLED"), node("relay", "ONLINE", "RELAY")];
const configs = [
  { id: "pc-live", nodeId: "live" },
  { id: "pc-old", nodeId: "old" },
  { id: "pc-relay", nodeId: "relay" },
];

describe("retired servers", () => {
  it("marks a route retired when either leg is on a DISABLED node", () => {
    expect(isRetiredRoute(routeServers(route("a", "pc-live"), configs, nodes))).toBe(false);
    expect(isRetiredRoute(routeServers(route("b", "pc-old"), configs, nodes))).toBe(true);
    expect(isRetiredRoute(routeServers(route("c", "pc-relay", "pc-old"), configs, nodes))).toBe(true);
    expect(isRetiredRoute(routeServers(route("d", "pc-relay", "pc-live"), configs, nodes))).toBe(false);
  });

  it("groups direct routes by server and relayed ones apart, losing none", () => {
    const routes = [
      route("a", "pc-live"),
      route("b", "pc-old"),
      route("c", "pc-relay", "pc-old"),
      route("d", "pc-relay", "pc-live"),
      route("e", "pc-missing"),
    ];
    const groups = groupRoutesByServer(routes, configs, nodes);
    expect(groups.map((g) => [g.label, g.retired, g.routes.map((r) => r.id)])).toEqual([
      ["live", false, ["a"]],
      ["relay (relay)", false, ["c", "d"]],
      ["Unknown server", false, ["e"]],
      ["old", true, ["b"]],
    ]);
  });
});
