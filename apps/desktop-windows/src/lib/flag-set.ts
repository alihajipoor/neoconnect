/** The flags the app does not draw by hand: every other ISO 3166-1
 * country's, from `src/assets/flags` (country-flag-icons, MIT; see
 * `scripts/gen-flags.mjs` and `src/assets/flags-LICENSE.txt`).
 *
 * Imported only through `import()` in `flag-art.ts`, never statically: the
 * build then puts this module and all 237 files in a chunk of their own,
 * inside the package like the rest of the app, and the first screen does
 * not pay for flags of countries it is not showing. A static import
 * anywhere would pull about 160 kB back into the first load. */
const FILES = import.meta.glob<string>("../assets/flags/*.svg", { query: "?raw", import: "default", eager: true });

/** One flag: its own coordinate box, and the shapes inside its root tag. */
export interface FlagArt {
  viewBox: string;
  body: string;
}

// The one form gen-flags.mjs writes the root tag in.
const ROOT = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="([-\d. ]+)">([\s\S]*)<\/svg>\s*$/;

function read(): Record<string, FlagArt> {
  const out: Record<string, FlagArt> = {};
  for (const [file, svg] of Object.entries(FILES)) {
    const code = /([a-z]{2})\.svg$/.exec(file)?.[1];
    const root = ROOT.exec(svg);
    if (code && root) out[code] = { viewBox: root[1], body: root[2] };
  }
  return out;
}

/** By lower-case ISO code. */
export const FLAG_SET: Readonly<Record<string, FlagArt>> = read();
