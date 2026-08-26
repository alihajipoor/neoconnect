import { describe, expect, it } from "vitest";
import { exitOfRoute, exitOptions, hasExitVocabulary } from "./exit-options";
import type { RouteOption } from "./types";

/** An exit is not a route, and the difference is the whole feature.
 *
 * Per-game exits were built and could not be used, for exactly one
 * reason: the only handle a client held was a route id, and two routes
 * can end on one machine. A picker built on route ids would let a
 * customer put two games on what they believe are two exits and land
 * both on one -- and would report `Fallback` for a game sitting exactly
 * where they put it. These tests pin the arithmetic that fixes that.
 *
 * Addresses are documentation-range throughout, per
 * `docs/node-address-hygiene.md`.
 */

/** Two protocols on germany-1: two routes, one machine, one exit. */
const DE_WG: RouteOption = {
  id: "route-de-wg",
  name: "Germany (Fast)",
  exit: "aaaaaaaaaaaaaaaaaaaaaa",
  protocol: "WIREGUARD" as RouteOption["protocol"],
  isRelay: false,
  location: { region: "de", nodeName: "germany-1" },
  endpoint: { host: "203.0.113.10", port: 51820 },
  nodeStatus: "ONLINE",
};

const DE_REALITY: RouteOption = {
  ...DE_WG,
  id: "route-de-reality",
  name: "Germany (Stealth)",
  protocol: "XRAY_VLESS_REALITY" as RouteOption["protocol"],
  endpoint: { host: "203.0.113.10", port: 443 },
};

/** Another machine entirely. */
const FI: RouteOption = {
  id: "route-fi",
  name: "Finland (Stealth)",
  exit: "bbbbbbbbbbbbbbbbbbbbbb",
  protocol: "XRAY_VLESS_REALITY" as RouteOption["protocol"],
  isRelay: false,
  location: { region: "fi", nodeName: "finland1" },
  endpoint: { host: "203.0.113.20", port: 443 },
  nodeStatus: "ONLINE",
};

/** Dialled in Iran, leaves from germany-1. The case a route id gets
 * wrong, and the case a *node name* gets wrong too. */
const IR_RELAY: RouteOption = {
  id: "route-ir-relay",
  name: "Iran relay",
  exit: DE_WG.exit,
  protocol: "XRAY_VLESS_REALITY" as RouteOption["protocol"],
  isRelay: true,
  location: { region: "ir", nodeName: "ir1" },
  endpoint: { host: "198.51.100.10", port: 443 },
  nodeStatus: "ONLINE",
};

/** An exit nothing in the list reaches directly. */
const IR_RELAY_ELSEWHERE: RouteOption = {
  ...IR_RELAY,
  id: "route-ir-relay-2",
  name: "Iran relay (second)",
  exit: "cccccccccccccccccccccc",
};

describe("exitOptions", () => {
  it("folds two routes on one machine into one exit", () => {
    // The plain case, and the one a route-id picker gets wrong first: a
    // customer choosing "Germany (Fast)" and "Germany (Stealth)" for two
    // games has spread nothing at all.
    const options = exitOptions([DE_WG, DE_REALITY]);
    expect(options).toHaveLength(1);
    expect(options[0].routes.map((r) => r.id).sort()).toEqual(["route-de-reality", "route-de-wg"]);
    expect(options[0].directNames).toEqual(["germany-1"]);
  });

  it("keeps two machines apart", () => {
    const options = exitOptions([DE_WG, FI]);
    expect(options).toHaveLength(2);
    expect(new Set(options.map((o) => o.exit)).size).toBe(2);
  });

  it("folds a relay in with the direct route to the same machine", () => {
    // The sharp case. Three entry addresses, two protocols, one machine
    // the far end sees. `docs/design/ban-safety.md` mechanism 5 is about
    // blast radius across *addresses*, so a picker that called these two
    // places would be advising the concentration it exists to spread.
    const options = exitOptions([DE_WG, IR_RELAY, FI]);
    expect(options).toHaveLength(2);
    const german = options.find((o) => o.exit === DE_WG.exit);
    expect(german?.routes.map((r) => r.id).sort()).toEqual(["route-de-wg", "route-ir-relay"]);
    // Reached directly by germany-1 and only by germany-1: the relay's
    // own node name is an ENTRY and must not be offered as where this
    // traffic appears from.
    expect(german?.directNames).toEqual(["germany-1"]);
    expect(german?.hidden).toBe(false);
  });

  it("never borrows a relay's entry name for the exit behind it", () => {
    // The dishonest label this guards against: telling a customer their
    // traffic appears from Iran when it appears from somewhere Neoxify
    // deliberately does not name.
    const options = exitOptions([IR_RELAY_ELSEWHERE]);
    expect(options).toHaveLength(1);
    expect(options[0].hidden).toBe(true);
    expect(options[0].directNames).toEqual([]);
    expect(options[0].directRegions).toEqual([]);
  });

  it("reports an exit as reachable when any route to it is up", () => {
    const options = exitOptions([{ ...DE_WG, nodeStatus: "OFFLINE" }, DE_REALITY]);
    expect(options[0].online).toBe(true);
    const down = exitOptions([{ ...FI, nodeStatus: "OFFLINE" }]);
    expect(down[0].online).toBe(false);
  });

  it("drops routes with no handle rather than inventing one", () => {
    // An older backend, or one with no handle secret configured. The
    // honest answer is no exit vocabulary and therefore no picker --
    // synthesising handles from route ids is precisely the false
    // `Fallback` this whole field exists to prevent.
    expect(exitOptions([{ ...DE_WG, exit: null }, { ...FI, exit: undefined }])).toEqual([]);
    expect(exitOptions([{ ...DE_WG, exit: "" }])).toEqual([]);
  });
});

describe("exitOfRoute", () => {
  const routes = [DE_WG, FI, IR_RELAY];

  it("answers with the machine the route leaves from, not the one it is dialled at", () => {
    // What the connect path sends as `egress` once a candidate is up.
    // Taking the entry would be silently wrong for exactly the routes
    // where the customer's choice of exit matters most.
    expect(exitOfRoute(routes, "route-ir-relay")).toBe(DE_WG.exit);
    expect(exitOfRoute(routes, "route-de-wg")).toBe(DE_WG.exit);
    expect(exitOfRoute(routes, "route-fi")).toBe(FI.exit);
  });

  it("abstains rather than guessing", () => {
    // Every one of these ends up reported as `unknown`, which is the
    // truthful answer. A guess here would be a match nobody established.
    expect(exitOfRoute(routes, null)).toBeNull();
    expect(exitOfRoute(routes, "route-that-is-gone")).toBeNull();
    expect(exitOfRoute([{ ...DE_WG, exit: null }], "route-de-wg")).toBeNull();
  });
});

describe("hasExitVocabulary", () => {
  it("is false when nothing can be named, which is when no picker is offered", () => {
    expect(hasExitVocabulary([])).toBe(false);
    expect(hasExitVocabulary([{ ...DE_WG, exit: null }])).toBe(false);
  });

  it("is true as soon as one route names an exit", () => {
    expect(hasExitVocabulary([{ ...DE_WG, exit: null }, FI])).toBe(true);
  });
});
