/**
 * Plan route-list arithmetic (lib/planlist.mjs).
 *
 * An edit that sends the wrong list revokes real customers' credentials,
 * so every way of getting it wrong that has happened, or nearly
 * happened, is pinned here.
 *
 *   node --test scripts/fleet/test/*.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planBody, planDelta, planGuard, planNew, planOrder, planResult, planSteps } from "../lib/planlist.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (...ns) => ns.map(id);

describe("planNew", () => {
  it("is the current list, minus the removes, plus the adds, unique and sorted", () => {
    assert.deepEqual(planNew(ids(3, 1, 2), ids(5, 4), ids(2)), ids(1, 3, 4, 5));
  });
  it("does not duplicate a route the plan already holds", () => {
    assert.deepEqual(planNew(ids(1, 2), ids(2, 3), []), ids(1, 2, 3));
  });
  it("ignores a remove the plan does not hold", () => {
    assert.deepEqual(planNew(ids(1, 2), [], ids(9)), ids(1, 2));
  });
});

describe("planGuard", () => {
  it("returns the new list for an ordinary swap", () => {
    assert.deepEqual(planGuard({ old: ids(1, 2, 3), add: ids(4), del: ids(2) }), ids(1, 3, 4));
  });
  it("refuses an empty result: that would revoke every subscriber on the plan", () => {
    assert.throws(() => planGuard({ old: ids(1, 2), add: [], del: ids(1, 2) }), /empty/);
  });
  it("refuses an id that is in both lists", () => {
    assert.throws(() => planGuard({ old: ids(1), add: ids(2), del: ids(2) }), /both/);
  });
  it("refuses anything that is not a route id", () => {
    assert.throws(() => planGuard({ old: ids(1), add: ["germany-3"], del: [] }), /not a route id/);
    assert.throws(() => planGuard({ old: [id(1), null], add: [], del: [] }), /not a route id/);
    assert.throws(() => planGuard({ old: "all", add: [], del: [] }), /not an array/);
  });
  it("refuses a default route that is not in the new list", () => {
    assert.throws(() => planGuard({ old: ids(1, 2), add: [], del: ids(2), def: id(2) }), /default/);
    assert.throws(() => planGuard({ old: ids(1, 2), add: [], del: [], def: "x" }), /default/);
  });
  it("accepts a default that is being added in the same edit", () => {
    assert.deepEqual(planGuard({ old: ids(1), add: ids(2), del: ids(1), def: id(2) }), ids(2));
  });
  it("is safe to repeat: the same remove twice asks for nothing new", () => {
    const once = planGuard({ old: ids(1, 2, 3), add: [], del: ids(3) });
    assert.deepEqual(planGuard({ old: once, add: [], del: ids(3) }), once);
  });
});

describe("planBody", () => {
  it("carries defaultRouteId only when one is being set", () => {
    assert.deepEqual(planBody(ids(1)), { allowedRouteIds: ids(1) });
    assert.deepEqual(planBody(ids(1), id(1)), { allowedRouteIds: ids(1), defaultRouteId: id(1) });
  });
});

describe("planOrder", () => {
  it("puts the plan with the fewest subscribers first, ties by name", () => {
    const order = planOrder([
      { name: "Starter", activeSubs: 33 },
      { name: "Pro", activeSubs: 8 },
      { name: "Max", activeSubs: 1 },
      { name: "Alpha", activeSubs: 8 },
    ]).map((p) => p.name);
    assert.deepEqual(order, ["Max", "Alpha", "Pro", "Starter"]);
  });
});

describe("planResult", () => {
  it("names what the backend left out and what it added", () => {
    assert.deepEqual(planResult(ids(1, 2, 9), ids(1, 2, 3)), { missing: ids(3), extra: ids(9) });
    assert.deepEqual(planResult(ids(2, 1), ids(1, 2)), { missing: [], extra: [] });
  });
});

describe("planDelta", () => {
  const incoming = { direct: ids(10, 11), relay: ids(20) };
  const outgoing = { direct: ids(1, 2), relay: ids(5) };
  it("gives a direct plan direct routes and a relay-only plan relay routes", () => {
    assert.deepEqual(planDelta({ relayOnly: false, routeIds: ids(1, 2, 3) }, incoming, outgoing), {
      add: ids(10, 11),
      del: ids(1, 2),
    });
    assert.deepEqual(planDelta({ relayOnly: true, routeIds: ids(5, 6) }, incoming, outgoing), {
      add: ids(20),
      del: ids(5),
    });
  });
  it("asks for nothing a half-done earlier pass already did", () => {
    assert.deepEqual(planDelta({ relayOnly: false, routeIds: ids(3, 10, 11) }, incoming, outgoing), {
      add: [],
      del: [],
    });
  });
});

describe("planSteps", () => {
  const plans = [
    { id: id(901), name: "Starter", relayOnly: false, activeSubs: 33, routeIds: ids(1, 2, 3), defaultRouteId: id(1) },
    { id: id(902), name: "Trial", relayOnly: false, activeSubs: 48, routeIds: ids(1, 2, 3), defaultRouteId: id(3) },
    { id: id(903), name: "Ultimate", relayOnly: true, activeSubs: 5, routeIds: ids(5, 6), defaultRouteId: null },
  ];
  const outgoing = {
    direct: ids(1, 2),
    relay: ids(5),
    shapes: { [id(1)]: "XRAY_TROJAN/TCP", [id(2)]: "WIREGUARD/UDP", [id(5)]: "relay:XRAY_TROJAN/TCP" },
  };
  const incoming = {
    direct: ids(10, 11),
    relay: ids(20),
    byShape: { "XRAY_TROJAN/TCP": id(10), "WIREGUARD/UDP": id(11), "relay:XRAY_TROJAN/TCP": id(20) },
  };

  it("replace: one edit per plan, smallest first, in and out together, defaults following by kind", () => {
    const steps = planSteps(plans, incoming, outgoing);
    assert.deepEqual(steps.map((s) => s.name), ["Ultimate", "Starter", "Trial"]);
    assert.deepEqual(steps[0], { id: id(903), name: "Ultimate", add: ids(20), del: ids(5), def: "", next: ids(6, 20) });
    assert.equal(steps[1].def, id(10), "Starter's default was the old Trojan route: it moves to the new one");
    assert.equal(steps[2].def, "", "Trial's default is on another server: it stays");
    assert.deepEqual(steps[2].next, ids(3, 10, 11));
  });

  it("add: nothing leaves, and a plan that already holds everything is skipped", () => {
    const done = plans.map((p) => (p.relayOnly ? { ...p, routeIds: ids(5, 6, 20) } : p));
    const steps = planSteps(done, incoming, {});
    assert.deepEqual(steps.map((s) => s.name), ["Starter", "Trial"]);
    assert.ok(steps.every((s) => s.del.length === 0 && s.def === ""));
  });

  it("retire: a default on the leaving server needs somewhere to go", () => {
    assert.throws(() => planSteps(plans, {}, outgoing), /Starter.*default route is leaving/);
    const steps = planSteps(plans, {}, outgoing, { byShape: { "XRAY_TROJAN/TCP": id(3) } });
    assert.equal(steps.find((s) => s.name === "Starter").def, id(3));
  });

  it("retire: refuses to leave a plan with no route at all", () => {
    const only = [{ id: id(904), name: "Solo", relayOnly: false, activeSubs: 2, routeIds: ids(1, 2), defaultRouteId: null }];
    assert.throws(() => planSteps(only, {}, outgoing), /Solo.*empty/);
  });

  it("is converged after the edits: asking again finds nothing to do", () => {
    const after = planSteps(plans, incoming, outgoing).map((s) => ({
      ...plans.find((p) => p.id === s.id),
      routeIds: s.next,
      defaultRouteId: s.def || plans.find((p) => p.id === s.id).defaultRouteId,
    }));
    assert.deepEqual(planSteps(after, incoming, outgoing), []);
  });
});
