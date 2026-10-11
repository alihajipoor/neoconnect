import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the phone's server list", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = dashboard.indexOf("<LocationPicker");
  const picker = dashboard.slice(start, dashboard.indexOf("/>", start));

  it("opens on the servers the screen holds, cached ones included, rather than asking again first", () => {
    // Not given them, it opened empty and fetched, so with Neoxify out of
    // reach it said "Could not reach Neoxify" over the very servers the
    // screen had loaded from the cache. The Windows screen has passed them
    // since the picker learned to open on content.
    expect(start).toBeGreaterThan(0);
    expect(picker).toContain("initialRoutes={routes}");
    // And `routes` is what the load put on screen -- the cached list on
    // the offline path, and on the online one when only the list's own
    // request failed, as `standInRoutes` decides: never over a later
    // load's list, and never another plan's left standing.
    expect(dashboard).toContain("const [routes, setRoutes] = useState<RouteOption[]>([]);");
    expect(dashboard).toContain("setRoutes(cached.routes);");
    expect(dashboard).toContain("const standIn = standInRoutes(cachedRoutes, shown, planOf(sub), load);");
    expect(dashboard).toContain("if (standIn !== null) {");
  });
});
