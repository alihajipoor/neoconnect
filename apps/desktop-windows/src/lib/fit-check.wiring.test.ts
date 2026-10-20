import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The headless fit check (`scripts/check-phone-fit.mjs --desktop`), which
 * measures what desktop-hero-fit.test.ts and speed-fit.test.ts pin: it has
 * to fail on what the VM found on 2026-10-20 -- a scrollbar beside the copy
 * at 1180x760, copy left to scroll there, a speed reading cut short, and
 * the tray's address and plan cut at 922x648. */
describe("the headless fit check", () => {
  const script = readFileSync(new URL("../../scripts/check-phone-fit.mjs", import.meta.url), "utf8");

  it("fails on a scrollbar beside the copy, details open or not, a cut speed, or copy to scroll at 1180x760", () => {
    expect(script).toContain("bar: hero.offsetWidth - hero.clientWidth,");
    expect(script).toContain("if (row.details) row.opened = await ev(DESKTOP_DETAILS);");
    expect(script).toContain('if (r.size === "1180 × 760" && !DESKTOP_MAY_SCROLL.has(r.state) && r.overflow > 0)');
    expect(script).toContain('cut: [...frame.querySelectorAll(".nx-sval, .nx-tray .nx-tval, .nx-tray .nx-tsub, .nx-tray .nx-tlabel, .nx-tray .nx-tlink")]');
    // The tray's address whole, the widest IPv4 on one line (VM, 2026-10-20:
    // "38.60.249.…" and "Checked through the …" at 922x648).
    expect(script).toContain('probe.textContent = "255.255.255.255";');
    expect(script).toContain("if (r.ip && (r.ip.lines > 1 || r.ip.widest > 1)) deskCut.push(");
    expect(script).toMatch(/deskBars\.length \|\|\s*deskCut\.length \|\|\s*deskScrolls\.length/);
    // The widest readings are among the states it walks.
    expect(script).toMatch(/"speed",\s*"speedWidest",\s*\];/);
  });
});
