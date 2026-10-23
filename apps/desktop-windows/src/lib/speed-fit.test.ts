import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DICTIONARIES, I18nProvider, type Language, type TranslationKey } from "./i18n";
import { formatRate } from "./locale-format";
import { rateShown, SpeedSection } from "../components/main/TrafficSpeed";
import { createTrafficMeter } from "./traffic-meter";

/* ------------------------------------------------------------------ *
 * The tray's live speed, in both languages, in the room it has (VM,
 * 2026-10-20): in Persian "۵۸۵٫۹ کیلوبایت/ثانیه", 106 px of text in a 90 px
 * box at 1180x760, was cut to "کیلوبایت…" -- the number gone -- and at
 * the compact-wide 940x700 and the fitted 922x648 the box beside the
 * sparkline is about 40 px, which cut English as well.
 *
 * Now a reading is three figures at most in the unit that keeps it under a
 * thousand, Persian says "per second" once in the section's label, and the
 * sparkline steps aside where the section cannot hold it beside the widest
 * reading. The pixels are measured in headless Chrome at every desktop
 * size and language, the widest readings included (`scripts/
 * check-phone-fit.mjs --desktop`, "cut"); this pins what makes them fit.
 * ------------------------------------------------------------------ */

/** Every magnitude a rate can have, at the edges of each unit and between,
 * up to the terabytes a second no tunnel will ever carry. */
function sweep(): number[] {
  const values: number[] = [0, 1, 9, 10, 99, 100, 512, 999, 1000, 1023];
  for (let exp = 1; exp <= 3; exp += 1) {
    for (const k of [1, 1.04, 9.94, 9.95, 9.96, 10, 99.4, 99.6, 100, 512, 998.4, 999, 999.4, 999.6, 1000, 1023.9]) {
      values.push(k * 1024 ** exp);
    }
  }
  for (const k of [1, 9.94, 99.6, 998.4]) values.push(k * 1024 ** 4);
  return values;
}

const say = (language: Language) => (key: TranslationKey, vars: Record<string, string | number> = {}) =>
  DICTIONARIES[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

describe("a speed reading", () => {
  it("is three figures at most, in the unit that keeps it under a thousand", () => {
    for (const value of sweep()) {
      const [figure] = formatRate(value, "en").split(" ");
      expect(figure.replace(".", "").length, `${value} -> ${figure}`).toBeLessThanOrEqual(3);
      expect(Number(figure), `${value} -> ${figure}`).toBeLessThan(1000);
    }
    expect(formatRate(999 * 1024, "en")).toBe("999 KB");
    expect(formatRate(999.6 * 1024, "en")).toBe("1.0 MB");
    expect(formatRate(9.96 * 1024, "en")).toBe("10 KB");
    expect(formatRate(9.94 * 1024, "en")).toBe("9.9 KB");
    expect(formatRate(584.7 * 1024, "en")).toBe("585 KB");
    expect(formatRate(1.15 * 1024 ** 2, "en")).toBe("1.1 MB");
    expect(formatRate(512, "en")).toBe("512 B");
    expect(formatRate(0, "en")).toBe("0 B");
    expect(formatRate(Number.NaN, "en")).toBe("0 B");
  });

  it("is in Persian digits and Persian units in Persian", () => {
    expect(formatRate(585.9 * 1024, "fa")).toBe("۵۸۶ کیلوبایت");
    expect(formatRate(7.2 * 1024 ** 2, "fa")).toBe("۷٫۲ مگابایت");
    expect(formatRate(999, "fa")).toBe("۹۹۹ بایت");
  });

  it("is never longer than the widest the tray is measured with", () => {
    // "999 KB/s" and "۹۹۹ گیگابایت": the preview's widest state, which the
    // headless check measures in the real box at every desktop size.
    const widest = { en: "999 KB/s".length, fa: "۹۹۹ گیگابایت".length };
    for (const language of ["en", "fa"] as const) {
      for (const value of sweep()) {
        const shown = rateShown(value, language, say(language));
        expect(shown.length, `${language} ${shown}`).toBeLessThanOrEqual(widest[language]);
      }
    }
  });

  it("says per second once, in the section's label, in Persian, and in each reading in English", () => {
    expect(rateShown(585.9 * 1024, "en", say("en"))).toBe("586 KB/s");
    const fa = rateShown(585.9 * 1024, "fa", say("fa"));
    expect(fa).toBe("۵۸۶ کیلوبایت");
    expect(fa).not.toContain("ثانیه");
    expect(DICTIONARIES.fa["tr.speed"]).toContain("ثانیه");
    // A screen reader hears it in words, in both.
    expect(DICTIONARIES.en["tr.perSecSpoken"]).toBe("{size} per second");
    expect(DICTIONARIES.fa["tr.perSecSpoken"]).toContain("ثانیه");
    expect(rateShown(null, "fa", say("fa"))).toBe("—");
  });

  it("is drawn that way, and heard per second, in the tray", () => {
    const meter = createTrafficMeter();
    meter.observe({ rx_bytes: 5e9, tx_bytes: 2e8, rx_per_sec: 585.9 * 1024, tx_per_sec: 999 * 1024 ** 3, window_ms: 1000 });
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SpeedSection, { meter })));
    expect(html).toContain(">586 KB/s<");
    expect(html).toContain(">999 GB/s<");
    expect(html).toContain('aria-label="Download: 586 KB per second"');
  });
});

describe("the tray's speed section", () => {
  const css = readFileSync(new URL("../pearl.css", import.meta.url), "utf8");

  it("sets readings in figures of one width", () => {
    const row = css.slice(css.indexOf("  .nx-srow {"), css.indexOf("}", css.indexOf("  .nx-srow {")));
    expect(row).toContain("font-variant-numeric: tabular-nums;");
  });

  it("lets the sparkline step aside where it would leave the reading too little room", () => {
    const section = css.slice(css.indexOf("  .nx-speed {"), css.indexOf("}", css.indexOf("  .nx-speed {")));
    expect(section).toContain("container: nxspeed / inline-size;");
    const query = css.match(/@container nxspeed \(max-width: ([\d.]+)px\) \{\s*\.nx-spark \{\s*display: none;/);
    expect(query).not.toBeNull();
    // Arrow 14 + gap 6 + gap 6 + sparkline 56 beside it: the reading keeps
    // at least the widest one's 80 px (Persian "۹۹۹ گیگابایت", measured)
    // wherever the sparkline is drawn.
    const threshold = Number(query![1]);
    expect(Math.ceil(threshold) - (14 + 6 + 6 + 56)).toBeGreaterThanOrEqual(80);
    expect(css).toMatch(/\n {2}\.nx-spark \{\s*width: 56px;/);
  });
});
