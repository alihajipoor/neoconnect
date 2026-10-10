import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routesToAdopt } from "./picker-routes";
import type { RouteOption } from "./types";

/** The servers an open picker takes from the dashboard beneath it.
 *
 * Opened while the dashboard's own route request was still waiting, the
 * picker had nothing to start from, and its own request could fail too:
 * it said Neoxify could not be reached while the dashboard, a moment
 * later, put the cached servers on screen beneath it. */

const germany = { id: "route-1", name: "Germany" } as RouteOption;
const finland = { id: "route-2", name: "Finland" } as RouteOption;

describe("a list the dashboard offers after the picker opened", () => {
  it("is taken while the picker has nothing to show and its own request has not answered", () => {
    expect(routesToAdopt([], false, [germany, finland])).toEqual([germany, finland]);
  });

  it("is not taken over rows the picker is showing", () => {
    expect(routesToAdopt([germany], false, [finland])).toBeNull();
  });

  /** Its own answer is newer than anything the dashboard holds -- an
   * empty one too, which says the plan has no servers now. */
  it("is not taken once the picker's own request has answered", () => {
    expect(routesToAdopt([], true, [germany])).toBeNull();
  });

  it("is nothing to take when the dashboard has nothing either", () => {
    expect(routesToAdopt([], false, [])).toBeNull();
    expect(routesToAdopt([], false, undefined)).toBeNull();
  });
});

/** Read from the source: the picker has no harness of its own. */
describe("the picker", () => {
  const source = readFileSync(new URL("../components/LocationPicker.tsx", import.meta.url), "utf8");

  it("takes the dashboard's list whenever the dashboard offers a new one", () => {
    const effect = source.slice(source.indexOf("useEffect(() => {\n    const adopted = routesToAdopt("));
    expect(effect.indexOf("routesToAdopt(routesRef.current, ownAnswered.current, initialRoutes)")).toBeGreaterThan(-1);
    expect(effect.indexOf("}, [initialRoutes]);")).toBeGreaterThan(-1);
    // And a failure of its own after that does not put an error over it.
    expect(source).toContain("const shown = routesRef.current;");
    expect(source).toContain("} else if (shown.length === 0) {");
  });

  /** The dashboard beneath may connect or disconnect while the list is
   * open; the report's probe must not run across that. */
  it("tells the report the dashboard's state as it is when the request settles", () => {
    expect(source).toContain('traceRequests("server list", () => stateRef.current)');
    expect(source).toContain('traceRequests("server switch", () => stateRef.current)');
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const picker = screen.slice(screen.indexOf("<LocationPicker"));
      expect(picker.slice(0, 1500), path).toContain("connectionState={connectionState}");
    }
  });
});

/** Read from the source: the dashboards have no harness of their own. */
describe("the dashboards", () => {
  /** A refresh's answer after its budget reaches the dashboard on screen,
   * not only the one that asked, which may have unmounted. */
  it("hold a late config answer whichever of them asked for it", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(screen, path).toContain("useEffect(() => onLateConfig(adoptRefreshed), []);");
      expect(screen, path).not.toContain("onLateAnswer:");
    }
  });
});
