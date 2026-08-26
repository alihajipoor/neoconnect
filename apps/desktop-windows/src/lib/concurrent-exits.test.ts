import { describe, expect, it } from "vitest";
import { carriesConcurrentExits, concurrentExitsFor } from "./concurrent-exits";
import type { GameExitGroup } from "./game-apps";
import type { ProtocolUser, RouteOption } from "./types";

/** What these tests are for.
 *
 * `concurrentExitsFor` is the last step before credentials leave the
 * client, so it is the last place a per-game exit can go wrong in a way
 * nobody sees. Two failures matter and neither shows up as an error:
 *
 * * **Sending an exit that cannot be carried.** The service drops it and
 *   the game silently rides the session's exit. That is the correct
 *   behaviour, but reaching it by sending something unusable means the
 *   client believed something false about what it had delivered.
 * * **Sending a game's exit while a sibling binary is not placed.** That
 *   is the two-source-address split, and it is the one thing this
 *   product could manufacture rather than merely fail to prevent. It is
 *   prevented here by construction -- every exit comes from
 *   `exitsForGames`, which emits a group whole or not at all -- and the
 *   tests below drive that through rather than trusting it.
 */

function route(id: string, exit: string | null, extra: Partial<RouteOption> = {}): RouteOption {
  return {
    id,
    name: id,
    protocol: "XRAY_VLESS_REALITY",
    isRelay: false,
    location: { region: "eu", nodeName: id },
    endpoint: { host: "203.0.113.5", port: 443 },
    nodeStatus: "ONLINE",
    exit,
    ...extra,
  } as RouteOption;
}

function user(id: string, routeId: string, extra: Partial<ProtocolUser> = {}): ProtocolUser {
  return {
    id,
    subscriptionId: "sub",
    routeId,
    nodeId: "node",
    protocolConfigId: "cfg",
    protocol: "XRAY_VLESS_REALITY",
    externalUserId: "ext",
    status: "ACTIVE",
    createdAt: "",
    updatedAt: "",
    credentials: {},
    connection: { host: "203.0.113.5", port: 443, publicParams: {} },
    ...extra,
  } as ProtocolUser;
}

function game(slug: string, exit: string | null, names: string[]): GameExitGroup {
  return { slug, displayName: slug.toUpperCase(), names, exit };
}

const pathFor = (slug: string, name: string) => `C:\\Games\\${slug}\\${name}`;

describe("concurrentExitsFor", () => {
  const routes = [
    route("r-de", "exit-de"),
    route("r-tr", "exit-tr"),
    route("r-fi", "exit-fi"),
  ];
  const held = [user("u-de", "r-de"), user("u-tr", "r-tr"), user("u-fi", "r-fi")];

  it("brings up the exits the placed games asked for", () => {
    const games = [game("a", "exit-tr", ["a.exe"]), game("b", "exit-fi", ["b.exe"])];
    const apps = [pathFor("a", "a.exe"), pathFor("b", "b.exe")];
    const result = concurrentExitsFor(user("u-de", "r-de"), held, routes, games, apps);
    expect(result.map((e) => e.exit)).toEqual(["exit-tr", "exit-fi"]);
    expect(result.map((e) => e.payload.id)).toEqual(["u-tr", "u-fi"]);
  });

  // The primary connection already leaves from its own exit. A second
  // outbound to the same node would be a second connection to one place
  // for no gain.
  it("skips the exit the connection already leaves from", () => {
    const games = [game("a", "exit-de", ["a.exe"]), game("b", "exit-tr", ["b.exe"])];
    const apps = [pathFor("a", "a.exe"), pathFor("b", "b.exe")];
    const result = concurrentExitsFor(user("u-de", "r-de"), held, routes, games, apps);
    expect(result.map((e) => e.exit)).toEqual(["exit-tr"]);
  });

  // Concurrent exits are one Xray process with several tagged inbounds.
  // A WireGuard primary has no equivalent, and that is a gap to state
  // rather than something to send and have dropped.
  it("sends nothing at all on a protocol that cannot carry them", () => {
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    const primary = user("u-wg", "r-de", { protocol: "WIREGUARD" as ProtocolUser["protocol"] });
    expect(concurrentExitsFor(primary, held, routes, games, apps)).toEqual([]);
  });

  // The outbound has to be one Xray can dial. A game whose exit is only
  // reachable by WireGuard is carried on the session's exit and
  // reported as `Fallback` -- the ordinary unsatisfiable case.
  it("skips an exit with no Xray-carried credential", () => {
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    const wgOnly = [
      user("u-de", "r-de"),
      user("u-tr", "r-tr", { protocol: "WIREGUARD" as ProtocolUser["protocol"] }),
    ];
    expect(concurrentExitsFor(user("u-de", "r-de"), wgOnly, routes, games, apps)).toEqual([]);
  });

  // The group rule, arriving here by construction rather than by being
  // repeated. `exitsForGames` emits a game's binaries together or not at
  // all, so a game with an unresolved binary contributes no exit and
  // its running half is carried on the session's exit alongside the
  // half that is not carried at all.
  it("sends no exit for a game whose binaries are only half selected", () => {
    const games = [game("a", "exit-tr", ["a.exe", "a-client.exe"])];
    const apps = [pathFor("a", "a.exe")]; // a-client.exe is missing
    expect(concurrentExitsFor(user("u-de", "r-de"), held, routes, games, apps)).toEqual([]);
  });

  // Two games sharing a binary and naming two exits withhold both, so
  // neither reaches this list.
  it("sends nothing for two games that share a binary and disagree", () => {
    const games = [game("a", "exit-tr", ["shared.exe"]), game("b", "exit-fi", ["shared.exe"])];
    const apps = [pathFor("shared", "shared.exe")];
    expect(concurrentExitsFor(user("u-de", "r-de"), held, routes, games, apps)).toEqual([]);
  });

  // Over the ceiling every preference is withheld upstream, so nothing
  // arrives here either -- the ceiling is not re-decided at this layer.
  it("sends nothing when the customer is over the ceiling", () => {
    const wide = [...routes, route("r-pl", "exit-pl")];
    const withPl = [...held, user("u-pl", "r-pl")];
    const games = [
      game("a", "exit-de", ["a.exe"]),
      game("b", "exit-tr", ["b.exe"]),
      game("c", "exit-fi", ["c.exe"]),
      game("d", "exit-pl", ["d.exe"]),
    ];
    const apps = ["a", "b", "c", "d"].map((s) => pathFor(s, `${s}.exe`));
    expect(concurrentExitsFor(user("u-de", "r-de"), withPl, wide, games, apps)).toEqual([]);
  });

  it("never returns more than the ceiling", () => {
    const wide = [...routes, route("r-pl", "exit-pl")];
    const withPl = [...held, user("u-pl", "r-pl")];
    const games = [
      game("a", "exit-tr", ["a.exe"]),
      game("b", "exit-fi", ["b.exe"]),
      game("c", "exit-pl", ["c.exe"]),
    ];
    const apps = ["a", "b", "c"].map((s) => pathFor(s, `${s}.exe`));
    // Three additional exits plus the primary's own is four nodes, and
    // the ceiling is three concurrent exits: the primary is one of
    // them, so at most three come back and the service truncates to
    // three regardless.
    const result = concurrentExitsFor(user("u-de", "r-de"), withPl, wide, games, apps);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  // A route with no handle gives this client no vocabulary for it, and
  // inventing one from a route id would produce the false placement the
  // whole feature exists to avoid -- two routes can share an exit.
  it("ignores credentials whose route has no exit handle", () => {
    const unnamed = [route("r-de", "exit-de"), route("r-tr", null)];
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    expect(concurrentExitsFor(user("u-de", "r-de"), held, unnamed, games, apps)).toEqual([]);
  });

  it("skips a credential that is not active", () => {
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    const disabled = [
      user("u-de", "r-de"),
      user("u-tr", "r-tr", { status: "DISABLED" as ProtocolUser["status"] }),
    ];
    expect(concurrentExitsFor(user("u-de", "r-de"), disabled, routes, games, apps)).toEqual([]);
  });

  // Ordering by what the control plane last saw up, and only as a
  // tiebreak: `nodeStatus` is a heartbeat rather than a measurement
  // from here, so it is worth ordering by and not worth refusing on.
  it("prefers a route the control plane last saw up", () => {
    const twoWays = [route("r-de", "exit-de"), route("r-tr-a", "exit-tr", { nodeStatus: "OFFLINE" }), route("r-tr-b", "exit-tr")];
    const both = [user("u-de", "r-de"), user("u-tr-a", "r-tr-a"), user("u-tr-b", "r-tr-b")];
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    const result = concurrentExitsFor(user("u-de", "r-de"), both, twoWays, games, apps);
    expect(result.map((e) => e.payload.id)).toEqual(["u-tr-b"]);
  });

  // But an exit reachable only by a route reported down is still
  // brought up. Refusing would take a preference away over something
  // that fixes itself the next time the node checks in.
  it("still brings up an exit whose only route is reported down", () => {
    const down = [route("r-de", "exit-de"), route("r-tr", "exit-tr", { nodeStatus: "OFFLINE" })];
    const games = [game("a", "exit-tr", ["a.exe"])];
    const apps = [pathFor("a", "a.exe")];
    const result = concurrentExitsFor(user("u-de", "r-de"), held, down, games, apps);
    expect(result.map((e) => e.exit)).toEqual(["exit-tr"]);
  });

  it("agrees with the service about which protocols can carry several exits", () => {
    for (const protocol of [
      "XRAY_VLESS_REALITY",
      "XRAY_VLESS_TLS",
      "XRAY_TROJAN",
      "SHADOWSOCKS",
    ]) {
      expect(carriesConcurrentExits(protocol)).toBe(true);
    }
    for (const protocol of ["WIREGUARD", "OPENVPN", "IKEV2"]) {
      expect(carriesConcurrentExits(protocol)).toBe(false);
    }
  });
});
