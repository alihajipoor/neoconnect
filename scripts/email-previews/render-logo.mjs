// Renders the logo the emails show, as PNG.
//
//   node scripts/email-previews/render-logo.mjs
//
// A mail client cannot show SVG, so the glass mark the app and the website
// draw (website/assets/img/brand/neoxify-glass-*.svg) has to reach a
// mailbox as a raster. This draws that same SVG on a small plate and
// screenshots it, so the email's mark is the app's mark and not a second
// drawing of it.
//
// The plate is part of the image on purpose. A mail client in dark mode may
// recolour the card behind the logo by rules of its own, and a mark with a
// transparent background then sits on whatever that produced. On its own
// plate it looks the same everywhere.
//
// Writes four files into apps/backend/src/modules/brand/assets/, which the
// API serves under /brand/ (brand.controller.ts). Run it again only when
// the glass logo itself changes, and commit what it writes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { launch } from "./cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const art = join(root, "website/assets/img/brand");
const out = join(root, "apps/backend/src/modules/brand/assets");

/** The size the mark is shown at, in CSS pixels. */
const SIZE = 40;

const PLATES = {
  light: {
    svg: "neoxify-glass-light.svg",
    // Pearl: --pearl over white, a hairline, and the lit top edge every
    // glass surface in the app carries (theme.css, --edge).
    css: `background: linear-gradient(160deg, #ffffff 0%, #f1f3f6 100%);
          box-shadow: inset 0 0 0 1px rgba(32, 48, 80, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9);`,
  },
  dark: {
    svg: "neoxify-glass-dark.svg",
    // Smoked: the dark theme's --pearl, and its fainter rim.
    css: `background: linear-gradient(160deg, #1b2130 0%, #10141d 100%);
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.11), inset 0 1px 0 rgba(255, 255, 255, 0.08);`,
  },
};

function page(plate) {
  const svg = readFileSync(join(art, plate.svg), "utf8");
  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; }
  .plate { width: ${SIZE}px; height: ${SIZE}px; border-radius: 12px; ${plate.css}
           display: flex; align-items: center; justify-content: center; }
  /* The mark's own contact shadow sits under it, so it is nudged up a
     little to look centred on the plate. */
  .plate svg { width: 30px; height: 30px; display: block; margin-top: -1px; }
</style>
<div class="plate">${svg}</div>`;
}

mkdirSync(out, { recursive: true });
const work = join(tmpdir(), `nx-email-logo-${process.pid}`);
mkdirSync(work, { recursive: true });

const browser = await launch();
try {
  for (const [name, plate] of Object.entries(PLATES)) {
    const html = join(work, `${name}.html`);
    writeFileSync(html, page(plate));
    for (const scale of [1, 2]) {
      const { png } = await browser.shoot(pathToFileURL(html).href, {
        width: SIZE,
        height: SIZE,
        scale,
        transparent: true,
        clip: { x: 0, y: 0, width: SIZE, height: SIZE },
      });
      const file = `email-logo-${name}${scale === 2 ? "-2x" : ""}.png`;
      writeFileSync(join(out, file), png);
      console.log(`${file}  ${SIZE * scale}x${SIZE * scale}  ${png.length} bytes`);
    }
  }
} finally {
  await browser.close();
}
