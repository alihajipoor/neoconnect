import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The phone's dashboard says it is still trying past eight seconds of
 * loading, as the shared screens do (still-trying.wiring.test.ts in the
 * shared lib). Read from the source because the screen has no test
 * harness of its own: the line could go and nothing else would notice. */
describe("the phone's dashboard", () => {
  it("says it is still trying under a load that has passed eight seconds", () => {
    const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(source).toContain("const loadingLong = useStillTrying(loading);");
    expect(source).toMatch(
      /\{loadingLong \? \(\s*<p className="max-w-xs px-6 text-center text-xs text-muted-foreground">\{t\("common\.stillTrying"\)\}<\/p>/,
    );
  });
});
