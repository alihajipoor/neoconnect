import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Which requests on screen report it when nothing answered them
 * (unanswered-report.ts): the dashboard's load and its route list, and
 * the server list's refresh and switch. None did, so a launch that fell
 * back to the offline banner, or a list that said Neoxify could not be
 * reached, left no row anywhere. Read from the source, because the
 * screens have no harness of their own; what a report says is
 * unanswered-report.test.ts's. The phone's dashboard is checked in the
 * mobile app's own tests. */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The function starting at `signature`, up to the next function at the
 * same indentation. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  const indent = signature.match(/^\s*/)![0];
  const end = source.indexOf(`\n${indent}}\n`, start);
  return source.slice(start, end);
}

describe("the Windows dashboard's load", () => {
  const dashboard = read("../screens/Dashboard.tsx");
  const load = body(dashboard, "  async function loadAll(preferRouteId?: string) {");

  it("traces each of its three requests and settles them together", () => {
    expect(load).toContain('const requests = traceRequests("dashboard load", connectionState);');
    expect(load).toContain('getMe(requests.trace("me")),');
    expect(load).toContain('getSubscriptions(requests.trace("subscriptions")),');
    expect(load).toContain('getProtocolUsers(requests.trace("protocol-users")),');
    expect(load).toMatch(
      /const unanswered = requests\.settle\(\{\s*me: meResult,\s*subscriptions: subsResult,\s*"protocol-users": usersResult,?\s*\}\);/,
    );
  });

  /** Both ways a failed load ends -- on the cached snapshot or on the
   * error -- and not when the server ended the session, which is an
   * answer. */
  it("reports a load nothing answered, cached or not, and not a sign-out", () => {
    const signedOut = load.indexOf("onLoggedOut();");
    const cached = load.indexOf("const cached = await loadSnapshot();");
    const reported = load.indexOf("unanswered?.(");
    expect(signedOut).toBeGreaterThan(0);
    expect(reported).toBeGreaterThan(cached);
    expect(reported).toBeGreaterThan(signedOut);
    expect(reported).toBeLessThan(load.indexOf("if (cached) {"));
    const said = load.slice(reported, load.indexOf("if (cached) {"));
    expect(said).toContain("snapshotAge(cached.savedAt)");
    expect(said).toContain("with nothing cached to show");
  });

  it("reports its route list when that alone went unanswered", () => {
    const asked = load.indexOf('const routesResult = await getAvailableRoutes(sub.id, routeList.trace("routes"));');
    expect(asked).toBeGreaterThan(load.indexOf('const routeList = traceRequests("dashboard route list", connectionState);'));
    expect(load).toContain("const routesUnanswered = routeList.settle({ routes: routesResult });");
    const failed = load.indexOf("} else {", load.indexOf("if (routesResult.ok) {"));
    const reported = load.indexOf("routesUnanswered?.(");
    expect(reported).toBeGreaterThan(failed);
    // After the cached list is in hand, so the report can say what it held.
    expect(reported).toBeGreaterThan(load.indexOf("currentRoutes = await cachedRoutesFor(sub);"));
  });
});

/** Shared by both apps. */
describe("the server list", () => {
  const picker = read("../components/LocationPicker.tsx");

  it("reports a refresh nothing answered, with the error on screen or with its rows kept", () => {
    const load = body(picker, "  async function load() {");
    expect(load).toContain('const requests = traceRequests("server list", () => stateRef.current);');
    expect(load).toContain('const result = await getAvailableRoutes(subscriptionId, requests.trace("routes"));');
    expect(load).toContain("const unanswered = requests.settle({ routes: result });");
    const shown = load.indexOf("setError(failureText(result, t));");
    const reports = [...load.matchAll(/unanswered\?\.\(/g)].map((m) => m.index!);
    expect(reports).toHaveLength(2);
    // One with the error it showed, and one where the rows stood.
    expect(reports[0]).toBeGreaterThan(shown);
    expect(load.slice(reports[0])).toContain("showed the error, with no servers to list");
    expect(load.slice(reports[1])).toContain("kept the ${shown.length} servers already on screen");
    expect(reports[0]).toBeGreaterThan(load.indexOf("if (result.ok) {"));
  });

  it("reports a switch nothing answered", () => {
    const pick = body(picker, "  async function handlePick(route: RouteOption) {");
    expect(pick).toContain('const requests = traceRequests("server switch", () => stateRef.current);');
    expect(pick).toContain('const result = await switchRoute(subscriptionId, route.id, requests.trace("switch"));');
    expect(pick).toContain("const unanswered = requests.settle({ switch: result });");
    const reported = pick.indexOf("unanswered?.(");
    expect(reported).toBeGreaterThan(pick.indexOf("setSwitchError(failureText(result, t));"));
  });
});
