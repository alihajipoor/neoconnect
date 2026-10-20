import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The headless fit check (`scripts/check-phone-fit.mjs --desktop`), which
 * measures what desktop-hero-fit.test.ts and speed-fit.test.ts pin: it has
 * to fail on what the VM found on 2026-10-20 -- a scrollbar beside the copy
 * at 1180x760, copy left to scroll there, and a speed reading cut short. */
describe("the headless fit check", () => {
  const script = readFileSync(new URL("../../scripts/check-phone-fit.mjs", import.meta.url), "utf8");

  it("fails on a scrollbar beside the copy, details open or not, a cut speed, or copy to scroll at 1180x760", () => {
    expect(script).toContain("bar: hero.offsetWidth - hero.clientWidth,");
    expect(script).toContain("if (row.details) row.opened = await ev(DESKTOP_DETAILS);");
    expect(script).toContain('if (r.size === "1180 × 760" && !DESKTOP_MAY_SCROLL.has(r.state) && r.overflow > 0)');
    expect(script).toContain('cut: [...frame.querySelectorAll(".nx-sval")]');
    expect(script).toMatch(/deskBars\.length \|\|\s*deskCut\.length \|\|\s*deskScrolls\.length/);
    // The widest readings are among the states it walks.
    expect(script).toMatch(/"speed",\s*"speedWidest",\s*\];/);
  });
});
