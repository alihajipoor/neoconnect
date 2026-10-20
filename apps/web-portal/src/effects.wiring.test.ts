import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The shared screens draw their theme, glass and motion from attributes on
 * <html> that `startEffects()` sets (desktop-windows/src/lib/effects.ts).
 * The portal never called it: a theme, glass or motion choice made in its
 * Settings was lost on reload, and the OS's reduced motion reached only
 * the rules that read the media query directly. */
describe("the portal's entry", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

  it("starts the effects before anything renders, and only outside a frame", () => {
    const started = main.search(/^\s*startEffects\(\);$/m);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(main).toMatch(/import \{ startEffects \} from "@shared\/lib\/effects";/);
    expect(started).toBeLessThan(main.indexOf(".render("));
    // Inside the frame guard's other branch (frame-guard.ts): nothing of
    // the app runs inside another site's frame.
    expect(started).toBeGreaterThan(main.indexOf("} else {", main.indexOf("if (isFramed())")));
  });

  it("keeps the stored theme off the sign-in, which follows the system (surface.ts)", () => {
    expect(main).toMatch(/^\s*startEffects\(\);\n\s*keepThemeOffSignIn\(\);$/m);
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    // Before the paint, so neither look shows a frame in the other's colours.
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*setSurface\(authScreen \? "auth" : "app"\);\s*\}, \[authScreen\]\);/);
    expect(app).not.toContain("dataset.surface =");
  });

  it("honours less motion chosen in Settings on the sign-in too", () => {
    const css = readFileSync(new URL("./auth/auth.css", import.meta.url), "utf8");
    expect(css).toContain('html[data-motion="reduce"] :is(.pa-step, .pa-hero, .pa-spin) {');
    expect(css).toContain('html[data-motion="reduce"] :is(.pa-btn, .pa-input) {');
  });
});

describe("the portal's stylesheets", () => {
  const index = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("give the sign-in page only what it draws with: Pearl Glass loads with the screens behind it", () => {
    // Every sign-in visit waits for the main stylesheet (stylesheet.ts),
    // often over a slow, filtered link.
    expect(index).not.toMatch(/@import "[^"]*(pearl|pages)\.css"/);
    const signedIn = readFileSync(new URL("./signed-in.css", import.meta.url), "utf8");
    expect(signedIn).toContain('@import "../../desktop-windows/src/pearl.css";');
    expect(signedIn).toContain('@import "../../desktop-windows/src/pages.css";');
    expect(readFileSync(new URL("./signed-in-styles.ts", import.meta.url), "utf8")).toContain('import "./signed-in.css";');
    expect(app).toContain('Promise.all([load(), import("./signed-in-styles")]).then(([screen]) => screen);');
    // Each screen behind sign-in, with them.
    const loaders = app.slice(app.indexOf("const SIGNED_IN = {"), app.indexOf("};", app.indexOf("const SIGNED_IN = {")));
    const lines = loaders.split("\n").filter((line) => line.includes("import("));
    expect(lines.length).toBe(5);
    for (const line of lines) expect(line).toMatch(/withStyles\(\(\) => import\(/);
  });

  it("never let the sign-in steps draw with a Pearl class", () => {
    // auth/ draws from auth.css alone; a Pearl class there would be
    // unstyled until the screens behind sign-in had loaded.
    for (const file of ["AuthShell", "PortalLogin", "PortalRegister", "PortalVerifyEmail", "PortalForgotPassword", "controls", "marks"]) {
      const source = readFileSync(new URL(`./auth/${file}.tsx`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/className=["{`][^"}`]*\bnx-/);
    }
  });
});
