import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { claimCheckPop, rearmCheckPop } from "./check-pop";

/** The check bounces once a session (design-system.md principle 6), not at
 * the end of every brief gap (review: "a 4 s involuntary reconnect goes
 * check, spin, check, and the new nx-popc class replays the bounce"). Each
 * time the chip draws the check is a fresh `CheckDot` (Hero.tsx), which
 * asks `claimCheckPop` once. */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("the check's one bounce", () => {
  it("check, spin, check: only the first check bounces", () => {
    rearmCheckPop();
    const session = 41;
    const draws = ["check", "spin", "check", "spin", "check"].filter((g) => g === "check").map(() => claimCheckPop(session));
    expect(draws).toEqual([true, false, false]);
  });

  it("a cleared banner or a screen that remounts draws the check again, without the bounce", () => {
    rearmCheckPop();
    expect(claimCheckPop(7)).toBe(true);
    expect(claimCheckPop(7)).toBe(false);
  });

  it("bounces again after the customer's own Disconnect, and for the next signed-in account", () => {
    rearmCheckPop();
    expect(claimCheckPop(3)).toBe(true);
    rearmCheckPop();
    expect(claimCheckPop(3)).toBe(true);
    expect(claimCheckPop(3)).toBe(false);
    // Sign-out moves the session generation.
    expect(claimCheckPop(4)).toBe(true);
  });

  it("is wired: the chip asks once per check it draws, before the first paint; Disconnect rearms it", () => {
    const hero = read("../components/main/Hero.tsx");
    expect(hero).toContain('<span className={cn("nx-dot check", pop && "nx-popc")} aria-hidden>');
    expect(hero).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(claimCheckPop\(\)\) setPop\(true\);\s*\}, \[\]\);/);
    expect(hero).not.toContain('className="nx-dot check nx-popc"');
    for (const rel of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      expect(read(rel).match(/rearmCheckPop\(\);/g)?.length, rel).toBe(1);
    }
  });
});
