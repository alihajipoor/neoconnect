import { useEffect, useState } from "react";
import type { ShownTone } from "../../lib/hero-model";
import type { LayoutMode } from "../../lib/layout-mode";
import type { MapScene } from "../../lib/map-lights";
import { MARK_TONE, type LogoTone } from "../../lib/logo-geometry";
import { WorldMap } from "./WorldMap";

/** The scene behind the main page: a quiet canvas in the Pearl or Smoked
 * palette, the calm tone's ambient glow, and -- on wide windows -- the
 * dotted world map with a light on each location in the list, the relay
 * arc from Iran to its exit, and the Neoxify mark in glass (owner
 * decisions, 2026-10-19: the map, then the logo in place of the ribbon).
 * On medium and phone layouts the map lives in the hero's column instead
 * (`MainView`'s `mapStage`, the same `WorldMap`), so it never sits under
 * the header or the nav.
 *
 * The mark's light sweep while a connect, check or disconnect is under
 * way is drawn from `data-busy` on the app root, like its colour and inner
 * glow from `data-shown`.
 *
 * The contract, whatever it draws:
 *  - decorative: `aria-hidden`, never the only place a fact is shown;
 *  - a light blinks only where `lib/map-lights.ts` found a real reason to
 *    say a location works on this network, and the connected light shows
 *    only under the verified tone -- `tone` is the calm tone the rest of
 *    the screen wears, held through short gaps, never the raw state;
 *  - nothing loops under reduced motion (`data-motion` on <html>), nothing
 *    animates under the panel's or the tray's blur, under an open dialog
 *    or menu, or while the window is hidden;
 *  - the ambient glow mirrors in RTL; the map and the mark do not. */

export interface HeroArtProps {
  /** The calm tone (`data-shown`), never the raw state. */
  tone: ShownTone;
  layout: LayoutMode;
  /** The lights and the arc, from `mapLights`; null draws no map. */
  map: MapScene | null;
  /** Every country the list can light or leave from (`mapCountries`). */
  countries: readonly string[];
  /** The glass Neoxify mark over the map. */
  logo?: boolean;
  /** Its colours (`MARK_TONE` unless the preview says otherwise). */
  logoTone?: LogoTone;
  /** A banner, an error or the device limit is showing: the compact
   * window's band of lights gives way to it. */
  alert?: boolean;
}

/** The mark floats once a session, for about 20 s after its first
 * verified connect (design-system.md 5.1). Per process, so a screen that
 * remounts -- Settings opened and closed -- does not float it again. */
let floatedThisSession = false;
const FLOAT_MS = 20_000;

function useFirstVerifiedFloat(tone: ShownTone): boolean {
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    if (tone !== "ok" || floatedThisSession) return;
    floatedThisSession = true;
    setFloating(true);
  }, [tone]);
  // Its own clock: a change of tone meanwhile does not cut it short or
  // leave it running.
  useEffect(() => {
    if (!floating) return;
    const timer = setTimeout(() => setFloating(false), FLOAT_MS);
    return () => clearTimeout(timer);
  }, [floating]);
  return floating;
}

export function HeroArt({ tone, layout, map, countries, logo = true, logoTone = MARK_TONE, alert = false }: HeroArtProps) {
  const float = useFirstVerifiedFloat(tone);
  return (
    <div className="nx-scene" aria-hidden data-tone={tone}>
      <div className="nx-amb ok" />
      <div className="nx-amb warn" />
      <div className="nx-amb hl" />
      {map && layout === "wide" ? (
        <WorldMap host="scene" lights={map.lights} arc={map.arc} countries={countries} logo={logo} logoTone={logoTone} alert={alert} float={float} />
      ) : null}
    </div>
  );
}
