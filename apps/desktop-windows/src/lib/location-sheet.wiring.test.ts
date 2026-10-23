import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../components/overlay.tsx", import.meta.url), "utf8");

/** The phone's location sheet while a server switch is out. The list
 * ignores Escape then, because closing cannot recall a request already
 * sent; the sheet's scrim, handle and close button closed it all the same,
 * and a switch that then failed was never said -- its error landed on a
 * list no longer drawn, and only the old location was left on screen. */
describe("the location sheet while a switch is in flight", () => {
  it("is held open from the pick until the switch is answered", () => {
    expect(dashboard).toMatch(/onPicking=\{\(routeId\) => \{\s*if \(routeId !== null\) setSwitchInFlight\(true\);\s*pickingLocation\(routeId\);/);
    expect(dashboard).toMatch(/onPickFailed=\{\(\) => \{\s*setSwitchInFlight\(false\);/);
    expect(dashboard).toMatch(/onSwitched=\{\(routeId\) => \{\s*setSwitchInFlight\(false\);/);
    expect(dashboard).toContain("dismissible={!switchInFlight}");
  });

  it("closes by none of its own ways out while it is held", () => {
    // The scrim: never while held, nor while the sheet is already leaving
    // (it stays mounted for its exit, lib/motion.ts usePresence).
    expect(overlay).toContain("onClick={dismissible && !closing ? onClose : undefined}");
    expect(overlay).toContain("const handle = useSheetDrag(ref, scrim, onClose, dismissible, open);");
    expect(overlay).toContain("if (!sheet || event.button !== 0 || !dismissible) return;");
    expect(overlay).toMatch(/onClick=\{onClose\}\s*onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}\s*disabled=\{!dismissible\}/);
  });
});
