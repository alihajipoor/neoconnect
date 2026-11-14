/**
 * Plan route-list arithmetic for `fleet`.
 *
 * A plan's `allowedRouteIds` is sent as the FULL list, and the backend
 * revokes every credential on a route the list no longer holds. So the
 * list is never built by hand: it is the plan's current list, minus the
 * routes going, plus the routes coming, and a guard refuses anything
 * else before a byte is sent.
 *
 * The same arithmetic runs twice on purpose: here (tested), and in jq
 * inside remote/panel/nx-plan-edit.sh right before the PATCH, against
 * the list as it is at that moment. The two must agree or nothing is
 * sent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (s) => typeof s === "string" && UUID.test(s);

const uniqSorted = (xs) => [...new Set(xs)].sort();

/** (old − del) ∪ add, unique and sorted, which is what jq's `unique` gives. */
export function planNew(old, add, del) {
  const gone = new Set(del);
  return uniqSorted([...old.filter((id) => !gone.has(id)), ...add]);
}

/**
 * Throws with the reason when the edit must not be sent. Returns the new
 * list when it may.
 *
 * - an empty list revokes every subscriber on the plan (the DTO comment
 *   that says "no restriction" is stale);
 * - an id in both lists is a typo, not an instruction;
 * - a default route outside the list is a default nothing serves.
 */
export function planGuard({ old, add, del, def = "" }) {
  for (const [label, xs] of [["current", old], ["add", add], ["remove", del]]) {
    if (!Array.isArray(xs)) throw new Error(`${label} list is not an array`);
    const bad = xs.find((x) => !isUuid(x));
    if (bad !== undefined) throw new Error(`${label} list holds something that is not a route id`);
  }
  const both = add.filter((id) => del.includes(id));
  if (both.length) throw new Error("a route id is in both the add and the remove list");
  if (def !== "" && !isUuid(def)) throw new Error("default route is not a route id");

  const next = planNew(old, add, del);
  if (next.length === 0) throw new Error("the new list is empty: that would revoke every subscriber on the plan");
  const has = new Set(next);
  if (!add.every((id) => has.has(id))) throw new Error("an added route is missing from the new list");
  if (del.some((id) => has.has(id))) throw new Error("a removed route is still in the new list");

  // Nothing else may change: what is left after taking the adds away must
  // be exactly what the plan had, minus the removes and the adds.
  const addSet = new Set(add);
  const delSet = new Set(del);
  const keptNew = uniqSorted(next.filter((id) => !addSet.has(id)));
  const keptOld = uniqSorted(old.filter((id) => !delSet.has(id) && !addSet.has(id)));
  if (keptNew.length !== keptOld.length || keptNew.some((id, i) => id !== keptOld[i])) {
    throw new Error("the new list changes routes that were not asked for");
  }
  if (def !== "" && !has.has(def)) throw new Error("the default route is not in the new list");
  return next;
}

/** The PATCH body. `defaultRouteId` only when one is being set. */
export function planBody(next, def = "") {
  return def === "" ? { allowedRouteIds: next } : { allowedRouteIds: next, defaultRouteId: def };
}

/**
 * Smallest plan first: a mistake shows on the few before it reaches the
 * many. Ties by name so the order is the same on every run.
 */
export function planOrder(plans) {
  return [...plans].sort((a, b) => a.activeSubs - b.activeSubs || a.name.localeCompare(b.name));
}

/** What the backend answered, held against what was sent. */
export function planResult(resultIds, next) {
  const got = new Set(resultIds);
  const want = new Set(next);
  return {
    missing: next.filter((id) => !got.has(id)),
    extra: resultIds.filter((id) => !want.has(id)),
  };
}

/**
 * Which routes a plan gains and loses when `incoming` joins and
 * `outgoing` leaves. A relay-only plan takes relay routes, every other
 * plan takes direct ones. Only routes the plan actually holds are
 * removed, so a re-run after a half-done pass asks for nothing twice.
 */
export function planDelta(plan, incoming, outgoing, bothKinds = false) {
  // The canary plan ("Internal test") takes both kinds: it is where a new
  // server's relay routes are proven with panel-issued credentials too,
  // before any customer plan holds either.
  const kinds = bothKinds ? ["direct", "relay"] : [plan.relayOnly ? "relay" : "direct"];
  const held = new Set(plan.routeIds);
  const add = kinds.flatMap((k) => incoming?.[k] ?? []).filter((id) => !held.has(id));
  const del = kinds.flatMap((k) => outgoing?.[k] ?? []).filter((id) => held.has(id));
  return { add, del };
}

/**
 * The whole plan pass, in order: for every plan, what to add, what to
 * remove, and where its default route goes when the old default is
 * leaving.
 *
 *   plans     [{id, name, relayOnly, activeSubs, routeIds, defaultRouteId}]
 *   incoming  {direct:[ids], relay:[ids], byShape:{"PROTOCOL/TRANSPORT": id}}   (may be empty)
 *   outgoing  {direct:[ids], relay:[ids], shapes:{routeId: "PROTOCOL/TRANSPORT"}} (may be empty)
 *   fallback  {byShape:{...}}  routes of another server, used for a default
 *             only when nothing is incoming (a plain retirement)
 *   bothKinds [plan names] that take direct AND relay routes (the canary)
 *
 * A plan with nothing to change is left out. Throws rather than send a
 * plan to an empty list or leave its default on a route that is going.
 */
export function planSteps(plans, incoming = {}, outgoing = {}, fallback = {}, bothKinds = []) {
  const steps = [];
  for (const plan of planOrder(plans)) {
    const { add, del } = planDelta(plan, incoming, outgoing, bothKinds.includes(plan.name));
    let def = "";
    const leaving = new Set([...(outgoing.direct ?? []), ...(outgoing.relay ?? [])]);
    if (plan.defaultRouteId && leaving.has(plan.defaultRouteId)) {
      const shape = outgoing.shapes?.[plan.defaultRouteId];
      def = incoming.byShape?.[shape] ?? fallback.byShape?.[shape] ?? "";
      if (!def) {
        throw new Error(`plan "${plan.name}": its default route is leaving and no replacement of the same kind was given`);
      }
    }
    if (!add.length && !del.length && !def) continue;
    let next;
    try {
      next = planGuard({ old: plan.routeIds, add, del, def });
    } catch (e) {
      throw new Error(`plan "${plan.name}": ${e.message}`);
    }
    steps.push({ id: plan.id, name: plan.name, add, del, def, next });
  }
  return steps;
}
