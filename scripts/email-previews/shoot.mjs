// Screenshots every email render.ts wrote.
//
//   node scripts/email-previews/shoot.mjs <out-dir> [name-filter]
//
// Each email at 600px (the card's full width) and at 380px (a phone), into
// <out-dir>/shots. The ones named in DARK are also shot with the reader's
// theme set to dark. Prints anything that sticks out past the edge of the
// page, which is the one fault a screenshot can hide by cropping it.
//
// Every email is also loaded at 380px with its <style> block removed,
// which is what the mail clients that strip it show: no narrow-screen
// padding, no dark mode. Those are checked for overflow, and the ones in
// DARK are kept as -380-nostyle.png.
//
// This is a browser, not a mail client. It shows what the markup asks
// for; it does not show what Gmail, Apple Mail or Outlook do to it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

/** One customer mail in each direction, and one staff mail. */
const DARK = ["customer-verification-en", "customer-voucher-fa", "ops-block-likely"];

const out = process.argv[2] ? resolve(process.argv[2]) : null;
if (!out) {
  console.error("usage: node shoot.mjs <out-dir> [name-filter]");
  process.exit(1);
}
const filter = process.argv[3];

const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).filter(
  (mail) => !filter || mail.name.includes(filter),
);
mkdirSync(join(out, "shots"), { recursive: true });
mkdirSync(join(out, "nostyle"), { recursive: true });
mkdirSync(join(out, "nostyle", "brand"), { recursive: true });
for (const file of ["email-logo-light-2x.png", "email-logo-dark-2x.png"]) {
  writeFileSync(join(out, "nostyle", "brand", file), readFileSync(join(out, "brand", file)));
}

const browser = await launch();
let overflowing = 0;
try {
  for (const { name } of manifest) {
    const url = pathToFileURL(join(out, `${name}.html`)).href;
    const jobs = [
      { width: 600, dark: false, file: `${name}-600.png` },
      { width: 380, dark: false, file: `${name}-380.png` },
      ...(DARK.includes(name)
        ? [
            { width: 600, dark: true, file: `${name}-600-dark.png` },
            { width: 380, dark: true, file: `${name}-380-dark.png` },
          ]
        : []),
    ];
    // The same email as a client that strips <style> delivers it.
    const stripped = join(out, "nostyle", `${name}.html`);
    writeFileSync(stripped, readFileSync(join(out, `${name}.html`), "utf8").replace(/<style>[\s\S]*?<\/style>/, ""));
    jobs.push({
      width: 380,
      dark: false,
      url: pathToFileURL(stripped).href,
      file: `${name}-380-nostyle.png`,
      keep: DARK.includes(name),
    });
    for (const job of jobs) {
      const { png, overflow } = await browser.shoot(job.url ?? url, { width: job.width, dark: job.dark });
      if (job.keep !== false) writeFileSync(join(out, "shots", job.file), png);
      if (overflow.length) {
        overflowing += 1;
        console.log(`OVERFLOW ${job.file}: ${overflow.join("; ")}`);
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`${manifest.length} emails shot; ${overflowing} with something past the edge`);
