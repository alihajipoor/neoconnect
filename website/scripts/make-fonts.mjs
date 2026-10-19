#!/usr/bin/env node
/**
 * Rebuild the three subset webfonts in assets/fonts/ from the app's own
 * font files, so the site and the app set type identically.
 *
 *   node website/scripts/make-fonts.mjs --src <dir with the app's fonts>
 *   node website/scripts/make-fonts.mjs --src <dir> --check   (coverage only)
 *
 * <dir> holds Inter-latin-wght.woff2, InterTight-latin-wght.woff2 and
 * Vazirmatn-variable.woff2 -- apps/desktop-windows/src/assets/ once the app
 * redesign is merged. Needs `subset-font` (harfbuzz compiled to wasm, so no
 * native binary): run `npm i subset-font@2` in a scratch directory and set
 * NODE_PATH to its node_modules, or install it next to this script.
 *
 * WHAT IT KEEPS AND WHY
 *   Inter        body text, English pages. wght 400-700 (the stylesheet
 *                never asks for anything else), Latin + Latin-1 + the
 *                punctuation the copy uses.
 *   Inter Tight  display type, English pages. Pinned to 700: the tagline
 *                and headings never vary weight, and pinning halves it.
 *   Vazirmatn    everything on Persian pages, Latin words included, so a
 *                Persian page loads exactly one font. wght 400-800.
 *                Persian letters (plus the Arabic forms that appear in
 *                Persian text), Persian digits, Persian punctuation, ZWNJ,
 *                ASCII, and the copyright/registered/trade mark signs.
 *
 * --check re-reads every character in inc/lang/*.php and inc/content/*.php
 * and reports any the subsets do not cover, and any in fa.php that
 * Vazirmatn alone does not (a Persian page loads no other font). A missing glyph does not break
 * a page -- it falls through to a system font and looks subtly wrong in one
 * spot, which is exactly the kind of fault nobody notices for months. Run
 * it after any copy change.
 *
 * Licences: all three are SIL OFL 1.1, which permits subsetting and
 * self-hosting; the licence files ship beside the fonts and the copyright
 * and licence records stay in each file's name table (ids 0, 13, 14).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.dirname(here);
const out = path.join(site, 'assets', 'fonts');
const args = process.argv.slice(2);
const src = args.includes('--src') ? args[args.indexOf('--src') + 1] : path.join(site, '..', 'apps', 'desktop-windows', 'src', 'assets');
const check = args.includes('--check');

const range = (a, b) => { let s = ''; for (let c = a; c <= b; c++) s += String.fromCodePoint(c); return s; };
const PUNCT = ' ‐‑–—‘’‚“”„•…′″‹›€™←↑→↓−·✓✕×';
const LATIN = range(0x20, 0x7e) + range(0xa1, 0xff) + 'ıŒœˆ˚˜' + PUNCT;
// The Persian alphabet and the Arabic letters that turn up in Persian text,
// harakat, Persian and Arabic digits, Persian punctuation, joiners and marks.
const PERSIAN = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی' + 'ءأإؤئةيكۀۀ' + range(0x64b, 0x655) + 'ٰ'
  + range(0x6f0, 0x6f9) + range(0x660, 0x669) + '،؛؟٪٫٬ـ«»' + '‌‍‎‏⁦⁧⁨⁩';
// © ® ™ too: the Persian footer and pages carry a ©, and without it in the
// subset that one character fell through to Tahoma (2026-10-19, v1 -> v2).
const VAZIR = PERSIAN + range(0x20, 0x7e) + ' –—‘’“”…·•×→←✓' + '©®™';

const FONTS = [
  { src: 'Inter-latin-wght.woff2', out: 'inter-latin-v1.woff2', text: LATIN, axes: { wght: { min: 400, max: 700 } } },
  { src: 'InterTight-latin-wght.woff2', out: 'inter-tight-latin-v1.woff2', text: LATIN, axes: { wght: 700 } },
  { src: 'Vazirmatn-variable.woff2', out: 'vazirmatn-v2.woff2', text: VAZIR, axes: { wght: { min: 400, max: 800 } } },
];

function inventory(files) {
  const chars = new Set();
  for (const f of files) for (const ch of fs.readFileSync(path.join(site, f), 'utf8')) chars.add(ch);
  return chars;
}
const phpIn = (dir) => fs.readdirSync(path.join(site, dir)).filter((f) => f.endsWith('.php')).map((f) => dir + '/' + f);

if (check) {
  // ⟪ ⟫ appear only in comments, where they describe the missing-key marker.
  const gaps = (chars, have) => [...chars].filter((c) => c.codePointAt(0) > 0x20 && !have.has(c) && !/s/.test(c) && !'⟪⟫'.includes(c));
  const fmt = (cs) => cs.map((c) => c + ' U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(', ');
  // Everything must be covered by one subset or the other...
  const anywhere = gaps(inventory([...phpIn('inc/lang'), ...phpIn('inc/content')]), new Set([...LATIN, ...VAZIR]));
  // ...and the Persian strings by Vazirmatn ALONE, because a Persian page
  // loads no other font. Checking against both together is how a © on the
  // Persian pages passed this check while drawing in Tahoma.
  const persian = gaps(inventory(['inc/lang/fa.php']), new Set(VAZIR));
  if (anywhere.length) console.log('Not covered by any subset:', fmt(anywhere));
  if (persian.length) console.log('In fa.php but not in the Vazirmatn subset:', fmt(persian));
  if (anywhere.length || persian.length) process.exit(1);
  console.log('All characters in inc/lang and inc/content are covered; fa.php by Vazirmatn alone.');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const subsetFont = require('subset-font');
for (const f of FONTS) {
  const input = fs.readFileSync(path.join(src, f.src));
  const buf = await subsetFont(input, f.text, {
    targetFormat: 'woff2',
    variationAxes: f.axes,
    preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
  });
  fs.writeFileSync(path.join(out, f.out), buf);
  console.log(f.out, buf.length, 'bytes');
}
