import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The phone's own screens say a failed request in the customer's
 * language, as the shared ones do (failure-text.ts in the shared lib).
 *
 * The phone's dashboard put the account request's own sentence on screen
 * as it was, so in Persian mode a first launch on a filtered network read
 * "Could not reach Neoxify. Check your internet connection." in English.
 * Read from the source because the screen has no test harness of its own. */
describe("the phone's screens", () => {
  const dirs = ["../screens", "../components"];
  const files = dirs.flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, import.meta.url))
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => ({ name, source: readFileSync(new URL(`${dir}/${name}`, import.meta.url), "utf8") })),
  );

  it("never put a request's own sentence on screen as it is", () => {
    const raw = /\bset[A-Z]\w*\(\s*\w+\.error\b|\?\s*\w+Result\.error\b/g;
    const offenders = files.flatMap(({ name, source }) => (source.match(raw) ?? []).map((m) => `${name}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it("words the dashboard's failed load through failureText", () => {
    const dashboard = files.find((f) => f.name === "Dashboard.tsx");
    expect(dashboard).toBeDefined();
    expect(dashboard!.source).toContain("failureText(meResult, t)");
    expect(dashboard!.source).toContain("failureText(subsResult, t)");
  });
});
