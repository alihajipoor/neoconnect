import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The phone's dashboard reports a load that nothing answered, as the
 * Windows one does (unanswered-report.ts in the shared lib). A launch on a
 * filtered network fell back to the cached snapshot, or to the error, and
 * left no row anywhere. The server list is shared, and checked with the
 * Windows app's tests. Read from the source because the screen has no
 * test harness of its own. */
describe("the phone's dashboard load", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = dashboard.indexOf("  async function loadScreen(");
  const load = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));

  it("traces each of its three requests and settles them together", () => {
    expect(start).toBeGreaterThan(0);
    expect(load).toContain('const requests = traceRequests("dashboard load", connectionState);');
    expect(load).toContain('getMe(requests.trace("me")),');
    expect(load).toContain('getSubscriptions(requests.trace("subscriptions")),');
    expect(load).toContain('getProtocolUsers(requests.trace("protocol-users")),');
    expect(load).toMatch(
      /const unanswered = requests\.settle\(\{\s*me: meResult,\s*subscriptions: subsResult,\s*"protocol-users": usersResult,?\s*\}\);/,
    );
  });

  it("reports a load nothing answered, cached or not, and not a sign-out", () => {
    const reported = load.indexOf("unanswered?.(");
    expect(reported).toBeGreaterThan(load.indexOf("const cached = await loadSnapshot();"));
    expect(reported).toBeGreaterThan(load.indexOf("onLoggedOut();"));
    expect(reported).toBeLessThan(load.indexOf("if (cached) {"));
  });

  it("reports its route list when that alone went unanswered", () => {
    expect(load).toContain('const routeList = traceRequests("dashboard route list", connectionState);');
    expect(load).toContain('const routesResult = await getAvailableRoutes(sub.id, routeList.trace("routes"));');
    expect(load).toContain("const routesUnanswered = routeList.settle({ routes: routesResult });");
    const failed = load.indexOf("} else {", load.indexOf("if (routesResult.ok) {"));
    expect(load.indexOf("routesUnanswered?.(")).toBeGreaterThan(failed);
  });
});
