import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Flag, HAND_DRAWN, RouteFlag } from "../components/Flag";
import { COUNTRY_NAMES, isCountry } from "./country-names";
import { flagSet, loadFlagSet } from "./flag-art";

/** Every country has a flag inside the package, so a server opened in a
 * new country never again shows a globe until the next release -- which is
 * what Sweden's did on 2026-11-11. */

const CODES = Object.keys(COUNTRY_NAMES);
const FLAGS_DIR = fileURLToPath(new URL("../assets/flags/", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

// The first test to load the set waits while the runner reads and
// transforms 237 files one by one, which takes seconds when the whole
// suite runs beside it. (The app reads one chunk the build already made.)
// For every test here, so that any one of them can be run alone.
vi.setConfig({ testTimeout: 120_000 });

const flag =(region: string | null) => renderToStaticMarkup(createElement(Flag, { region }));
const GLOBE = "lucide-globe";

describe("a flag for every country", () => {
  /** Before the set has loaded -- it is a chunk of its own, read from the
   * package the first time it is wanted -- a country's row shows the flag's
   * box, never the globe: the globe would say "no such country". */
  it("holds the flag's box, not the globe, until the set has loaded", () => {
    expect(flagSet()).toBeUndefined();
    const html = flag("jp-japan");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="jp-japan"');
    expect(html).not.toContain(GLOBE);
    expect(html).not.toContain("<path");
  });

  it("keeps the hand-drawn flags out of the set, and has a file for every other country", async () => {
    const set = (await loadFlagSet())!;
    expect(CODES).toHaveLength(249);
    expect(HAND_DRAWN).toHaveLength(12);
    const fromSet = CODES.filter((code) => !HAND_DRAWN.includes(code));
    expect(Object.keys(set).sort()).toEqual(fromSet.sort());
    expect(readdirSync(FLAGS_DIR).sort()).toEqual(fromSet.map((code) => `${code}.svg`).sort());
  });

  it("draws a flag, not the globe, for all 249", async () => {
    const set = (await loadFlagSet())!;
    for (const code of CODES) {
      const html = flag(`${code}-somewhere`);
      expect(html, code).toMatch(/^<svg /);
      expect(html, code).toContain('role="img"');
      expect(html, code).not.toContain(GLOBE);
      if (HAND_DRAWN.includes(code)) {
        expect(html, code).toContain('viewBox="0 0 4 3"');
      } else {
        // The country's own drawing, in its own coordinate box.
        expect(html, code).toContain(`viewBox="${set[code].viewBox}"`);
        expect(html, code).toContain(set[code].body);
        expect(set[code].body.length, code).toBeGreaterThan(40);
      }
    }
  });

  it("leaves the globe for a region that names no country", async () => {
    await loadFlagSet();
    // Among them plain words whose first two letters are some country's
    // code: "No region" is not Norway.
    const none = ["zz-nowhere", "xx-lab", "xk-pristina", "deu-frankfurt", "frankfurt", "No region", "St Petersburg", "", null];
    for (const region of none) {
      const html = flag(region);
      expect(html, String(region)).toContain(GLOBE);
      expect(html, String(region)).not.toContain('role="img"');
    }
    expect(isCountry("zz")).toBe(false);
    expect(isCountry("xx")).toBe(false);
    expect(isCountry(null)).toBe(false);
    expect(isCountry("se")).toBe(true);
  });

  /** `uk` is what people type for Britain and `el` is the EU's Greece:
   * each draws the flag of the country meant, not the globe. */
  it("draws the country meant by uk and by el", async () => {
    await loadFlagSet();
    const inner = (html: string) => html.slice(html.indexOf(">") + 1);
    expect(flag("uk-london")).not.toContain(GLOBE);
    expect(inner(flag("uk-london"))).toBe(inner(flag("gb-united-kingdom")));
    expect(inner(flag("el-athens"))).toBe(inner(flag("gr-greece")));
  });

  /** Same box, same rounding, same fit as a hand-drawn flag, at every size
   * the screens ask for: no row shifts for a flag from the set. */
  it("puts a flag from the set in the box a hand-drawn one has", async () => {
    await loadFlagSet();
    const box = (html: string) => ({
      cls: /class="([^"]*)"/.exec(html)?.[1],
      fit: /preserveAspectRatio="([^"]*)"/.exec(html)?.[1],
    });
    expect(box(flag("jp-japan"))).toEqual(box(flag("de-germany")));
    expect(box(flag("jp-japan")).fit).toBe("xMidYMid slice");
    for (const size of ["md", "sm", "row", "lg"] as const) {
      const drawn = renderToStaticMarkup(createElement(RouteFlag, { region: "de-germany", exitRegion: null, size }));
      const fromSet = renderToStaticMarkup(createElement(RouteFlag, { region: "jp-japan", exitRegion: null, size }));
      expect(box(fromSet), size).toEqual(box(drawn));
    }
  });

  it("draws a set flag as a relay's exit with the entry as its badge", async () => {
    await loadFlagSet();
    const html = renderToStaticMarkup(
      createElement(RouteFlag, { region: "ir-iran", exitRegion: "ch-zurich", label: "Backup route → Switzerland" }),
    );
    expect(html.match(/<svg/g)?.length).toBe(2);
    expect(html).toContain("#239f40");
    expect(html).not.toContain(GLOBE);
  });
});

describe("the flag set's files", () => {
  const files = readdirSync(FLAGS_DIR).map((name) => ({ name, svg: readFileSync(FLAGS_DIR + name, "utf8") }));

  /** Their insides go into the app's page as they are, many to a screen.
   * So: nothing that can run or reach out, and nothing one flag could share
   * a name with another through -- no id, no class, no style, no reference. */
  it("are plain shapes: nothing to run, and nothing for two flags on a page to collide over", () => {
    expect(files).toHaveLength(237);
    for (const { name, svg } of files) {
      const root = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="([-\d. ]+)">([\s\S]*)<\/svg>\n$/.exec(svg);
      expect(root, name).not.toBeNull();
      const body = root![2];
      const tags = [...body.matchAll(/<([a-zA-Z][^\s/>]*)/g)].map((m) => m[1]);
      expect(
        tags.filter((tag) => !["path", "circle", "ellipse", "g", "rect", "polygon"].includes(tag)),
        name,
      ).toEqual([]);
      expect(body, name).not.toMatch(/\s(id|class|style|href|xlink:href|on[a-z]+)\s*=/i);
      expect(body, name).not.toMatch(/url\(|javascript:|<!|&/i);
      // Nothing but tags: no stray text.
      expect(body.replace(/<[^>]*>/g, "").trim(), name).toBe("");
    }
  });

  /** Drawn 3:2. The flag keeps that box and is fitted by covering the
   * app's, so it is trimmed a little and never stretched. */
  it("are all drawn 3:2", () => {
    for (const { name, svg } of files) {
      const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
      expect(w / h, name).toBeCloseTo(1.5, 2);
    }
  });

  it("stay small enough to load in one piece", () => {
    const total = files.reduce((sum, file) => sum + file.svg.length, 0);
    expect(total).toBeLessThan(200_000);
  });
});

/** The set is a chunk of its own only while nothing imports it outright:
 * one `import ... from "./flag-set"` anywhere moves all 237 flags into the
 * first load, and every other test here still passes. */
describe("the flag set stays out of the first load", () => {
  const sources = (dir: string) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => ({ name: name.replace(/\\/g, "/"), text: readFileSync(dir + name, "utf8") }));
  // Any import, export or import() that names the module.
  const NAMES_IT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'][^"']*\/flag-set(?:\.ts)?["']/g;
  const TYPE_ONLY = /\bimport\s+type\s[^;]*?from\s*["'][^"']*\/flag-set(?:\.ts)?["']/g;

  it("is imported by flag-art.ts alone, and there only on demand", () => {
    const files = [...sources(fileURLToPath(new URL("../", import.meta.url))), ...sources(REPO + "apps/mobile/src/")];
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter((file) => file.text.match(NAMES_IT));
    expect(naming.map((file) => file.name)).toEqual(["lib/flag-art.ts"]);

    const loader = naming[0].text;
    expect(loader.match(TYPE_ONLY)).toHaveLength(1);
    // What is left once the type import is set aside is the one import().
    const rest = loader.replace(TYPE_ONLY, "").match(NAMES_IT) ?? [];
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatch(/^import\s*\(/);
  });
});

/** A server's label is held to `<country code>-<name>` where it is typed:
 * by the backend, for the panel's form and anything else that creates a
 * node, and by the installer's own prompt. Both must accept exactly the
 * countries the app can draw and name -- one fewer and a real country is
 * refused, one more and that country's server is back to a globe. */
describe("the lists that decide whether a label names a country", () => {
  const codesIn = (file: string, pattern: RegExp) => {
    const found = pattern.exec(readFileSync(REPO + file, "utf8"));
    expect(found, file).not.toBeNull();
    return found![1].trim().split(/\s+/);
  };

  it("are the app's 249, in the backend", () => {
    const backend = codesIn("apps/backend/src/common/iso-countries.ts", /ISO_COUNTRY_CODES[^=]*=\s*new Set\(\s*`([a-z\s]+)`/);
    expect(backend).toEqual([...CODES].sort());
  });

  it("are the app's 249, in the installer", () => {
    const installer = codesIn("installer/lib/agent.sh", /^ISO_COUNTRY_CODES="([a-z\s]+)"$/m);
    expect(installer).toEqual([...CODES].sort());
  });
});
