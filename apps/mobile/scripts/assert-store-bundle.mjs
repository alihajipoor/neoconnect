// Proves a built web bundle carries no way to buy anything.
//
// Apple's guideline 3.1.1 does not ask that the purchase screen be
// hidden; it asks that the app not sell. An `IS_STORE_BUILD` check that
// merely skips a route would still ship the checkout call, and a
// reviewer who finds it -- or a user who reaches it through a stale
// deep link -- is looking at a violation. So this asserts on absence
// from the bytes, not on behaviour.
//
// Why these two markers and not the obvious `plans.toAddress`: the
// Android release counts that one, and in a store build it still reads
// 2 rather than 0. Those two are the English and Farsi entries in the
// i18n dictionary -- object literals that no tree-shaker can drop, and
// inert, because nothing left in the bundle looks them up. Counting
// them can only ever produce a relative comparison ("store is smaller
// than direct"), which needs both builds to exist side by side.
//
// `checkoutUrl` (the field the backend returns to send a customer to
// payment) and `redeem` (the voucher path, which Apple's 3.1.1 names as
// a prohibited unlock in its own right) both go to exactly zero. That
// is an absolute claim about one bundle, so it can be made on iOS,
// where only the store flavour is ever built and there is no direct
// build to compare against.
//
// Measured 2026-09-23: direct checkoutUrl=4 redeem=1, store 0 and 0.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKERS = ["checkoutUrl", "redeem"];
const root = process.argv[2] ?? "dist";

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(root);

const hits = [];
for (const file of files) {
  // Read as latin1 rather than utf8 so a byte sequence inside an image
  // or a wasm blob is still searched rather than replaced with U+FFFD.
  const text = readFileSync(file, "latin1");
  for (const marker of MARKERS) {
    let index = text.indexOf(marker);
    while (index !== -1) {
      hits.push({ file, marker, index });
      index = text.indexOf(marker, index + 1);
    }
  }
}

if (hits.length > 0) {
  console.error(
    `${root}/ contains ${hits.length} purchase marker(s). This bundle sells ` +
      `inside the app and the App Store will reject it under 3.1.1.`,
  );
  for (const hit of hits.slice(0, 20)) {
    console.error(`  ${hit.file}: ${hit.marker} at byte ${hit.index}`);
  }
  console.error(
    "\nThe usual cause is a build that did not set VITE_DISTRIBUTION=store.",
  );
  process.exit(1);
}

console.log(
  `${root}/ carries no purchase surface: ${MARKERS.map((m) => `${m}=0`).join(", ")} ` +
    `across ${files.length} files.`,
);
