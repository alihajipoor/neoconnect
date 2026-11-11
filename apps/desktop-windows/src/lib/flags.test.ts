import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Flag, HAND_DRAWN, RouteFlag } from "../components/Flag";
import { COUNTRY_NAMES, isCountry } from "./country-names";
import { flagSet, loadFlagSet } from "./flag-art";

/** Every country has a flag inside the package, so a server opened in a
 * new country never again shows a globe until the next release -- which is
 * what Sweden's did on 2026-11-11. */

const CODES = Object.keys(COUNTRY_NAMES);
const FLAGS_DIR = fileURLToPath(new URL("../assets/flags/", import.meta.url));
const flag = (region: string | null) => renderToStaticMarkup(createElement(Flag, { region }));
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

  // The first load: here the test runner reads and transforms 237 files one
  // by one, which takes seconds when the whole suite runs beside it. (The
  // app reads one chunk the build already made.) Every later test awaits
  // the same, finished promise.
  it("keeps the hand-drawn flags out of the set, and has a file for every other country", async () => {
    const set = (await loadFlagSet())!;
    expect(CODES).toHaveLength(249);
    expect(HAND_DRAWN).toHaveLength(12);
    const fromSet = CODES.filter((code) => !HAND_DRAWN.includes(code));
    expect(Object.keys(set).sort()).toEqual(fromSet.sort());
    expect(readdirSync(FLAGS_DIR).sort()).toEqual(fromSet.map((code) => `${code}.svg`).sort());
  }, 120_000);

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
    for (const region of ["zz-nowhere", "xx-lab", "uk-london", "frankfurt", "", null]) {
      const html = flag(region);
      expect(html, String(region)).toContain(GLOBE);
      expect(html, String(region)).not.toContain('role="img"');
    }
    expect(isCountry("zz")).toBe(false);
    expect(isCountry("xx")).toBe(false);
    expect(isCountry(null)).toBe(false);
    expect(isCountry("se")).toBe(true);
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
