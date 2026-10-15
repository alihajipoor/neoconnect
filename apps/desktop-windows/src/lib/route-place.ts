import type { Language } from "./i18n";
import type { RouteOption } from "./types";

/** Where a route goes, in words a customer reads.
 *
 * A relayed route is dialled in one country and leaves from another, and
 * until the route list named the exit's country the apps could only say
 * where it was dialled: every relay through Iran read "ir2 / ir-iran",
 * whichever of four countries it actually left from. That is the place a
 * customer is choosing, and the one the far end sees.
 */

/** The ISO code out of a region slug.
 *
 * `region` is free text in the database (`fi-finland`, `fr-france`,
 * `sg-singapore`), so this reads the prefix rather than trusting a
 * column that does not exist. Anything that is not two letters before a
 * dash is not a country this can name. */
export function countryCode(region: string | undefined | null): string | null {
  if (!region) return null;
  const head = region.trim().toLowerCase().split(/[-_\s]/)[0];
  return /^[a-z]{2}$/.test(head) ? head : null;
}

/** The countries the app draws a flag for (`Flag.tsx`), named in each
 * language. A `Record<Language, ...>` so a language added later is a
 * build error here until it names them too. */
const COUNTRY_NAMES: Record<string, Record<Language, string>> = {
  ir: { en: "Iran", fa: "ایران" },
  de: { en: "Germany", fa: "آلمان" },
  fr: { en: "France", fa: "فرانسه" },
  fi: { en: "Finland", fa: "فنلاند" },
  tr: { en: "Turkey", fa: "ترکیه" },
  nl: { en: "Netherlands", fa: "هلند" },
  sg: { en: "Singapore", fa: "سنگاپور" },
  ae: { en: "UAE", fa: "امارات" },
  us: { en: "USA", fa: "آمریکا" },
  gb: { en: "UK", fa: "بریتانیا" },
};

/** The country a region slug is in, or the slug as written when this
 * cannot name it.
 *
 * A node can be added in any country from the installer without touching
 * this file. The platform's own list is asked next; failing that the slug
 * stands, which is what the apps showed before and is never the wrong
 * country. */
export function countryName(region: string, language: Language): string {
  const code = countryCode(region);
  if (!code) return region;
  const known = COUNTRY_NAMES[code]?.[language];
  if (known) return known;
  // `zz` is the standard's own code for "unknown region", which the
  // platform would name as such -- a worse answer than the slug.
  if (code === "zz") return region;
  try {
    const name = new Intl.DisplayNames([language], { type: "region", fallback: "none" }).of(code.toUpperCase());
    if (name && name.toUpperCase() !== code.toUpperCase()) return name;
  } catch {
    // An engine without DisplayNames, or a code it rejects.
  }
  return region;
}

type Placed = Pick<RouteOption, "isRelay" | "location" | "exitLocation">;

/** A route's entry and, for a relay, its exit -- both region slugs.
 *
 * `exit` is null for a direct route, which leaves from where it is
 * dialled, and for a relay from a backend too old to name its exit: the
 * entry is then all there is to show, as before. */
export function routePlace(route: Placed): { entry: string; exit: string | null } {
  const exit = route.isRelay ? route.exitLocation?.region?.trim() || null : null;
  return { entry: route.location.region, exit };
}

/** Points from the entry to the exit in each language's reading order.
 * Arrows are not mirrored in a right-to-left line, so the one that points
 * from Iran towards the exit there is the leftward one. */
const TOWARDS: Record<Language, string> = { en: "→", fa: "←" };

/** "Iran → Germany" for a relay, "Germany" for a direct route.
 *
 * Countries, not node names: the picker keeps the node name on the line
 * beneath, which is where two routes to one country differ. */
export function placeLabel(route: Placed, language: Language): string {
  const { entry, exit } = routePlace(route);
  const from = countryName(entry, language);
  return exit ? `${from} ${TOWARDS[language]} ${countryName(exit, language)}` : from;
}

/** The country this route's traffic appears from: the exit's for a relay
 * the backend named, otherwise the entry's. For a space too narrow for
 * the whole of `placeLabel`, beside a flag that shows the rest. */
export function exitCountryName(route: Placed, language: Language): string {
  const { entry, exit } = routePlace(route);
  return countryName(exit ?? entry, language);
}

/** Equal for two routes that go between the same places. Iran to Finland
 * and Finland itself are different places, though both end in Finland:
 * one of them is dialled in Iran. */
export function placeKey(route: Placed): string {
  const { entry, exit } = routePlace(route);
  return exit ? `${entry}>${exit}` : entry;
}

/** The list with every route to one place together.
 *
 * Places come in the order each first appears and routes keep their order
 * within a place, so a list the server sent already grouped is left
 * exactly as it was. Route names are free text, though, and the older
 * relay's routes interleave their exits -- which put "Iran → Germany",
 * "Iran → France", "Iran → Germany" in a row once the exits were named.
 *
 * Grouped on the route data alone, never on tags or latency, so nothing
 * moves under the customer's finger as those arrive. */
export function groupByPlace<T extends Placed>(routes: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const route of routes) {
    const key = placeKey(route);
    const group = groups.get(key);
    if (group) group.push(route);
    else groups.set(key, [route]);
  }
  return [...groups.values()].flat();
}
