import { Globe } from "lucide-react";
import { cn } from "../lib/utils";

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
 * - **A flag package** costs a dependency and a bundle for the handful of
 *   countries we actually run nodes in.
 *
 * These are deliberately simple: at 20px wide the details of a coat of
 * arms are a smudge, so each flag keeps only what identifies it at a
 * glance -- bands, crosses, a crescent.
 */

/** The ISO code out of a region slug.
 *
 * `region` is free text in the database (`fi-finland`, `fr-france`,
 * `sg-singapore`), so this reads the prefix rather than trusting a
 * column that does not exist. Anything that is not two letters before a
 * dash falls through to the globe, which is the honest answer for a
 * region nobody has taught this component about yet.
 */
export function countryCode(region: string | undefined | null): string | null {
  if (!region) return null;
  const head = region.trim().toLowerCase().split(/[-_\s]/)[0];
  return /^[a-z]{2}$/.test(head) ? head : null;
}

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

/** Renders the flag for a region, or a globe when we have no flag for it.
 *
 * The fallback matters more than it looks: a node can be added in any
 * country from the installer without touching this file, and a missing
 * flag must degrade to a neutral icon rather than to an empty box or the
 * wrong country's colours.
 */
export function Flag({ region, className }: { region?: string | null; className?: string }) {
  const code = countryCode(region);
  const art = code ? FLAGS[code] : null;

  if (!art) {
    return <Globe className={cn("size-4 text-muted-foreground", className)} aria-hidden />;
  }

  return (
    <svg
      viewBox="0 0 4 3"
      className={cn("h-4 w-[1.35rem] rounded-[2px] ring-1 ring-inset ring-white/15", className)}
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
