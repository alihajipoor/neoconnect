// Copies the flags the app does not draw by hand out of country-flag-icons.
//
//   node scripts/gen-flags.mjs --from <country-flag-icons>/3x2 [--out src/assets/flags]
//
// Run from apps/desktop-windows. The output is committed; rerun only to take
// a newer version of the set, or when ISO 3166-1 gains a code (name it in
// src/lib/country-names.ts first: that list is what this copies).
//
// The input is country-flag-icons' `3x2` folder, fetched as data into an
// empty folder outside the repo, never installed:
//
//   npm pack country-flag-icons@1.6.20 --ignore-scripts --pack-destination <empty dir>
//   tar -xzf <empty dir>/country-flag-icons-1.6.20.tgz -C <empty dir>
//   node scripts/gen-flags.mjs --from <empty dir>/package/3x2
//
// Only the .svg files are read, as text. Nothing from the package runs.
//
// Why this set: it covers every ISO code, its flags are simplified the way
// the hand-drawn ones are (a coat of arms is a smudge at 20px), the whole
// of it is about 160 kB, and no file carries an `id`, a style sheet or a
// reference -- so any number of them can sit inline in one page without one
// flag's gradient or clip path answering to another's name. That last
// property is checked here and again by src/lib/flags.test.ts, because the
// app puts these files' insides straight into its own page.
//
// What is changed on the way in: the root tag is rewritten to one fixed form
// (xmlns, then viewBox), and stray `class` attributes are dropped (four
// files carry a `class="st1"` left by an editor, with no style sheet for it
// to mean anything). The drawing is not touched.
//
// Licence: country-flag-icons is MIT, (c) 2020 @catamphetamine; its notice
// is kept in src/assets/flags-LICENSE.txt and must stay in the app's
// third-party notices.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
if (!args.from) {
  console.error("usage: node scripts/gen-flags.mjs --from <country-flag-icons>/3x2 [--out src/assets/flags]");
  process.exit(2);
}
const OUT = args.out ?? "src/assets/flags";

// Every country the app names...
const names = fs.readFileSync("src/lib/country-names.ts", "utf8");
const codes = [...names.matchAll(/^ {2}([a-z]{2}): \{ en: /gm)].map((m) => m[1]);
// ...less the ones Flag.tsx draws itself, which keep their own art.
const flagTsx = fs.readFileSync("src/components/Flag.tsx", "utf8");
const table = /const FLAGS: [^=]+= \{([\s\S]*?)\n\};/.exec(flagTsx)?.[1] ?? "";
const drawn = [...table.matchAll(/^ {2}([a-z]{2}): \(/gm)].map((m) => m[1]);
if (codes.length !== 249 || drawn.length === 0) {
  console.error(`expected 249 codes and the hand-drawn flags; read ${codes.length} and ${drawn.length}`);
  process.exit(1);
}

/** What a flag may be made of. Anything else stops the run: these files'
 * insides are placed in the app's page as they are. */
const TAGS = new Set(["path", "circle", "ellipse", "g", "rect", "polygon"]);
const ATTRS = new Set([
  "d", "fill", "fill-rule", "clip-rule", "opacity", "fill-opacity", "stroke", "stroke-width", "stroke-miterlimit",
  "stroke-linejoin", "stroke-linecap", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "points", "transform",
]);

fs.mkdirSync(OUT, { recursive: true });
for (const old of fs.readdirSync(OUT)) if (old.endsWith(".svg")) fs.rmSync(path.join(OUT, old));
let bytes = 0;
let written = 0;
for (const cc of codes) {
  if (drawn.includes(cc)) continue;
  const file = path.join(args.from, `${cc.toUpperCase()}.svg`);
  if (!fs.existsSync(file)) {
    console.error(`${cc}: the set has no flag for it`);
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf8").trim();
  const root = /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/.exec(src);
  const viewBox = root && /\sviewBox="([-\d. ]+)"/.exec(root[1])?.[1];
  if (!root || !viewBox) {
    console.error(`${cc}: not an <svg> with a viewBox`);
    process.exit(1);
  }
  const [, , w, h] = viewBox.trim().split(/\s+/).map(Number);
  if (!(Math.abs(w / h - 1.5) < 0.01)) {
    console.error(`${cc}: drawn ${w}x${h}, not 3:2`);
    process.exit(1);
  }
  const body = root[2].replace(/\sclass="[^"]*"/g, "");
  if (body.replace(/<[^>]*>/g, "").trim() !== "") {
    console.error(`${cc}: text outside its tags`);
    process.exit(1);
  }
  for (const tag of body.matchAll(/<\/?([^\s/>]*)([^>]*)>/g)) {
    if (!TAGS.has(tag[1])) {
      console.error(`${cc}: <${tag[1]}> is not allowed`);
      process.exit(1);
    }
    for (const attr of tag[2].matchAll(/([^\s=/]+)\s*=\s*"([^"]*)"/g)) {
      if (!ATTRS.has(attr[1]) || /url\(|javascript:|&/i.test(attr[2])) {
        console.error(`${cc}: ${attr[1]}="${attr[2].slice(0, 40)}" is not allowed`);
        process.exit(1);
      }
    }
  }
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.trim()}">${body}</svg>\n`;
  fs.writeFileSync(path.join(OUT, `${cc}.svg`), out);
  bytes += Buffer.byteLength(out);
  written++;
}
console.log(JSON.stringify({ codes: codes.length, handDrawn: drawn.length, written, bytes }));
