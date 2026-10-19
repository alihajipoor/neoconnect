import type { ShownTone } from "../../lib/hero-model";
import type { LayoutMode } from "../../lib/layout-mode";

/** The scene behind the main page: the slot for the dotted world map, a
 * light on each location in the list, the relay arcs from Iran to their
 * exits, and the glass ribbon (owner decision, 2026-10-19).
 *
 * The map asset and the lights' semantics are a separate piece of work
 * (the session scratchpad's `ui-redesign/map`). Until it lands this draws
 * a neutral placeholder: a quiet gradient in the Pearl or Smoked palette,
 * and the calm tone's ambient glow. Nothing in it is a claim.
 *
 * The contract the map has to keep, whatever it draws:
 *  - decorative: `aria-hidden`, never the only place a fact is shown;
 *  - a light blinks only where there is a real reason to say a location
 *    works (`HeroPlace.connected`, `workedHere`), and is dim when nothing is
 *    known -- never lit from a guess, and never by the raw state: `tone` is
 *    the calm tone the rest of the screen wears, held through short gaps;
 *  - nothing loops at rest under reduced motion (`data-motion` on <html>),
 *    and nothing animates under the panel's or the tray's blur;
 *  - mirrored in RTL like the rest of the scene, the ribbon excepted. */

export interface HeroPlace {
  /** `placeKey(route)`: one light per place in the list. */
  key: string;
  /** Region code of the country the traffic leaves from. */
  exit: string;
  /** Region code a relay enters through (Iran), drawn as an arc to `exit`. */
  via?: string;
  /** A verified tunnel leaves from here now: the only "connected" light. */
  connected: boolean;
  /** A tunnel is up here and has not been verified: no claim either way. */
  inUse: boolean;
  /** A real reason to say this place works on this network -- a recent
   * success from this device here, or most people on this network
   * succeeding. False when there is no evidence; never inferred. */
  workedHere: boolean;
}

export interface HeroArtProps {
  /** The calm tone (`data-shown`), never the raw state. */
  tone: ShownTone;
  /** A connect, check or disconnect is under way: the light sweep. */
  busy: boolean;
  /** Every place in the locations list, with what is known of each. */
  places: readonly HeroPlace[];
  layout: LayoutMode;
  /** The glass ribbon over the map (owner: keep it, with a toggle to judge). */
  ribbon?: boolean;
}

export function HeroArt({ tone }: HeroArtProps) {
  return (
    <div className="nx-scene" aria-hidden data-tone={tone}>
      <div
        className="nx-scene-mirror"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(120% 90% at 70% 10%, var(--sky-top), transparent 60%), linear-gradient(180deg, var(--sky-top) 0%, var(--base) 55%, var(--sky) 100%)",
        }}
      />
      <div className="nx-amb ok" />
      <div className="nx-amb warn" />
      <div className="nx-amb hl" />
    </div>
  );
}
