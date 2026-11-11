import { useEffect, useSyncExternalStore } from "react";
import { Globe } from "lucide-react";
import { cn } from "../lib/utils";
import { isCountry } from "../lib/country-names";
import { flagSet, loadFlagSet, subscribeFlagSet } from "../lib/flag-art";
import { countryCode } from "../lib/route-place";

/** A country flag for a server location.
 *
 * Drawn inline rather than pulled from an icon font, an image host or an
 * emoji, and each of those was ruled out for its own reason:
 *
 * - **Emoji** (🇫🇷) is the obvious choice and is wrong here. Windows has
 *   never shipped glyphs for regional-indicator pairs, so the desktop
 *   client would render "FR" as two letter boxes while Android showed a
 *   flag. The clients are meant to look like one product.
 * - **A remote sprite** would put a network fetch in front of the server
 *   list -- for customers whose networks are the reason they installed a
 *   VPN, and whose first view of the app is often before a tunnel is up.
 * - **A flag package** as a dependency costs every screen its whole
 *   bundle, for flags of countries the screen is not showing.
 *
 * So the flags come from two places, both inside the package:
 *
 * - The countries below are drawn here by hand. They are deliberately
 *   simple: at 20px wide the details of a coat of arms are a smudge, so
 *   each flag keeps only what identifies it at a glance -- bands, crosses,
 *   a crescent.
 * - Every other country's is a file in `src/assets/flags`, copied from a
 *   set drawn the same plain way, and loaded in one piece the first time
 *   any of them is wanted (`lib/flag-art.ts`). A server can open in any
 *   country and have its flag without a new release of the app, which is
 *   what Sweden did not have on 2026-11-11.
 */

// Read from the region slug; lives with the country names now. Anything
// it cannot read falls through to the globe, which is the honest answer
// for a region that names no country.
export { countryCode };

const FLAGS: Record<string, React.ReactNode> = {
  // Three vertical bands.
  fr: (
    <>
      <rect width="4" height="3" fill="#fff" />
      <rect width="1.34" height="3" fill="#0055a4" />
      <rect x="2.66" width="1.34" height="3" fill="#ef4135" />
    </>
  ),
  // Nordic cross, offset towards the hoist.
  fi: (
    <>
      <rect width="4" height="3" fill="#fff" />
      <rect y="1.2" width="4" height="0.72" fill="#002f6c" />
      <rect x="1.1" width="0.72" height="3" fill="#002f6c" />
    </>
  ),
  // The same cross, gold on blue, and a little finer as the flag has it.
  se: (
    <>
      <rect width="4" height="3" fill="#006aa7" />
      <rect y="1.2" width="4" height="0.6" fill="#fecc00" />
      <rect x="1.2" width="0.6" height="3" fill="#fecc00" />
    </>
  ),
  // Red over white, with the crescent. The stars are dots at this size --
  // five of them, which is what the eye counts.
  sg: (
    <>
      <rect width="4" height="3" fill="#fff" />
      <rect width="4" height="1.5" fill="#ed2939" />
      <circle cx="0.95" cy="0.75" r="0.52" fill="#fff" />
      <circle cx="1.18" cy="0.75" r="0.44" fill="#ed2939" />
      <circle cx="1.72" cy="0.42" r="0.1" fill="#fff" />
      <circle cx="2.06" cy="0.62" r="0.1" fill="#fff" />
      <circle cx="1.93" cy="1.0" r="0.1" fill="#fff" />
      <circle cx="1.51" cy="1.0" r="0.1" fill="#fff" />
      <circle cx="1.38" cy="0.62" r="0.1" fill="#fff" />
    </>
  ),
  // Green, white, red. The emblem and the kufic script are illegible at
  // this size, so they are left out rather than drawn as noise.
  ir: (
    <>
      <rect width="4" height="3" fill="#fff" />
      <rect width="4" height="1" fill="#239f40" />
      <rect y="2" width="4" height="1" fill="#da0000" />
    </>
  ),
  de: (
    <>
      <rect width="4" height="1" fill="#000" />
      <rect y="1" width="4" height="1" fill="#dd0000" />
      <rect y="2" width="4" height="1" fill="#ffce00" />
    </>
  ),
  nl: (
    <>
      <rect width="4" height="1" fill="#ae1c28" />
      <rect y="1" width="4" height="1" fill="#fff" />
      <rect y="2" width="4" height="1" fill="#21468b" />
    </>
  ),
  tr: (
    <>
      <rect width="4" height="3" fill="#e30a17" />
      <circle cx="1.5" cy="1.5" r="0.62" fill="#fff" />
      <circle cx="1.72" cy="1.5" r="0.5" fill="#e30a17" />
      <circle cx="2.42" cy="1.5" r="0.24" fill="#fff" />
    </>
  ),
  ae: (
    <>
      <rect width="4" height="1" fill="#00732f" />
      <rect y="1" width="4" height="1" fill="#fff" />
      <rect y="2" width="4" height="1" fill="#000" />
      <rect width="1" height="3" fill="#ff0000" />
    </>
  ),
  us: (
    <>
      <rect width="4" height="3" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((i) => (
        <rect key={i} y={(i * 3) / 13} width="4" height={3 / 13} fill="#b22234" />
      ))}
      <rect width="1.7" height={(3 / 13) * 7} fill="#3c3b6e" />
    </>
  ),
  // Saffron, white, green, and the wheel in navy. Its twenty-four spokes
  // are a smudge at this size, so it is the rim and the hub: a ring with a
  // dot, which is what reads as the wheel.
  in: (
    <>
      <rect width="4" height="1" fill="#ff9933" />
      <rect y="1" width="4" height="1" fill="#fff" />
      <rect y="2" width="4" height="1" fill="#138808" />
      <circle cx="2" cy="1.5" r="0.36" fill="none" stroke="#000080" strokeWidth="0.09" />
      <circle cx="2" cy="1.5" r="0.09" fill="#000080" />
    </>
  ),
  gb: (
    <>
      <rect width="4" height="3" fill="#012169" />
      <path d="M0 0 L4 3 M4 0 L0 3" stroke="#fff" strokeWidth="0.6" />
      <path d="M0 0 L4 3 M4 0 L0 3" stroke="#c8102e" strokeWidth="0.36" />
      <path d="M2 0 V3 M0 1.5 H4" stroke="#fff" strokeWidth="1" />
      <path d="M2 0 V3 M0 1.5 H4" stroke="#c8102e" strokeWidth="0.6" />
    </>
  ),
};

/** The countries drawn by hand above. Every other country's flag is a
 * file from the set (`scripts/gen-flags.mjs` reads this table to know
 * which ones to leave out). */
export const HAND_DRAWN: readonly string[] = Object.keys(FLAGS);

/** The flag's box: its size, its rounding and the hairline around it. One
 * constant, so a flag from the set sits in exactly the box a hand-drawn
 * one does and no row shifts. */
const FLAG_BOX = "h-4 w-[1.35rem] rounded-[2px] ring-1 ring-inset ring-white/15";

function NoFlag({ className }: { className?: string }) {
  return <Globe className={cn("size-4 text-muted-foreground", className)} aria-hidden />;
}

/** Renders the flag for a region, or a globe when it names no country.
 *
 * Every ISO 3166-1 country has a flag, so the globe is left for a region
 * that is not one: `zz`, `xx`, a slug with no code in front, nothing at
 * all. It must stay a neutral icon, never an empty box or the wrong
 * country's colours.
 */
export function Flag({ region, className }: { region?: string | null; className?: string }) {
  const code = countryCode(region);
  const art = code ? FLAGS[code] : null;

  if (!art) {
    return isCountry(code) ? <SetFlag code={code} region={region} className={className} /> : <NoFlag className={className} />;
  }

  return (
    <svg
      viewBox="0 0 4 3"
      className={cn(FLAG_BOX, className)}
      role="img"
      // Named for screen readers and for anyone reading a bug report: the
      // slug is what the picker and the dashboard both key off.
      aria-label={region ?? "unknown location"}
      preserveAspectRatio="xMidYMid slice"
    >
      {art}
    </svg>
  );
}

/** Shown in the flag's box for the moment the set takes to load: the box
 * itself, faintly, so the row holds its shape and nothing reads as a
 * country yet. */
const PENDING = { viewBox: "0 0 4 3", body: '<rect width="4" height="3" fill="currentColor" opacity="0.1"/>' };

/** A flag from the bundled set, in the same box as a hand-drawn one.
 *
 * The set is drawn 3:2 and the box is nearer 4:3, so the flag keeps its own
 * coordinate box and is fitted the way the hand-drawn ones already are:
 * scaled until it covers the box and trimmed evenly, a few percent off each
 * end, never stretched.
 *
 * The file's shapes go into the page as they are. That is safe to do with
 * any number of flags on one screen because no file in the set carries an
 * `id`, a style or a reference for another flag's to collide with, and
 * nothing in it can run: `gen-flags.mjs` refuses a file that does, and
 * `flags.test.ts` checks the committed ones again. */
function SetFlag({ code, region, className }: { code: string; region?: string | null; className?: string }) {
  const set = useSyncExternalStore(subscribeFlagSet, flagSet, flagSet);
  useEffect(() => {
    void loadFlagSet();
  }, []);

  // The set could not be read, or has no file for this code: neither
  // should happen, and the neutral icon is the honest thing to show.
  if (set === null || (set && !set[code])) return <NoFlag className={className} />;
  const art = set?.[code] ?? PENDING;

  return (
    <svg
      viewBox={art.viewBox}
      className={cn(FLAG_BOX, className)}
      role="img"
      aria-label={region ?? "unknown location"}
      preserveAspectRatio="xMidYMid slice"
      dangerouslySetInnerHTML={{ __html: art.body }}
    />
  );
}

const ROUTE_FLAG_SIZES = {
  // The server list's rows.
  md: { main: "h-4 w-[1.35rem]", badge: "h-2.5 w-[0.85rem]", at: "-bottom-1 -end-1.5", wrap: "" },
  // The dashboard's server tile, beside a caption -- spaced so the badge,
  // which hangs past the flag's edge, does not touch the caption's text.
  sm: { main: "h-3 w-[1rem]", badge: "h-2 w-[0.65rem]", at: "-bottom-1 -end-1", wrap: "me-1" },
  // The Pearl locations panel's rows (30x21), and the tray's location (40x28).
  row: { main: "h-[21px] w-[30px] rounded-[5px]", badge: "h-[11px] w-[16px] rounded-[3px]", at: "-bottom-1.5 -end-[7px]", wrap: "" },
  lg: { main: "h-[28px] w-[40px] rounded-[7px]", badge: "h-[14px] w-[20px] rounded-[3px]", at: "-bottom-1.5 -end-[7px]", wrap: "" },
} as const;

/** A route's flag: one for a direct route, and for a relay the exit
 * country's flag with the entry's -- Iran's -- as a badge in its corner.
 *
 * The exit is the large one because it is the place the customer is
 * choosing and the one the far end sees; the badge says how the traffic
 * gets there. Side by side with an arrow was the other way to draw it,
 * and does not fit the round slot the list gives each row.
 *
 * With no `exitRegion` -- a direct route, or a relay from a backend that
 * names no exit -- this is exactly `Flag`. The ring around the badge is
 * the page's own background, so it reads as cut out of the larger flag
 * rather than as a second flag pasted on top. */
export function RouteFlag({
  region,
  exitRegion,
  label,
  size = "md",
}: {
  region?: string | null;
  exitRegion?: string | null;
  /** Read out for the pair, e.g. "Iran → Germany" (`placeLabel`). */
  label?: string;
  size?: keyof typeof ROUTE_FLAG_SIZES;
}) {
  const s = ROUTE_FLAG_SIZES[size];
  if (!exitRegion) return <Flag region={region} className={s.main} />;
  return (
    <span role="img" aria-label={label ?? `${region ?? "unknown location"} → ${exitRegion}`} className={cn("relative inline-flex shrink-0", s.wrap)}>
      <Flag region={exitRegion} className={s.main} />
      <span className={cn("absolute flex rounded-[2px] ring-[1.5px] ring-background", s.at)}>
        <Flag region={region} className={s.badge} />
      </span>
    </span>
  );
}
