import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import mapSvg from "../../assets/world-map.svg?raw";
import { useI18n } from "../../lib/i18n";
import {
  MAP_COLS,
  MAP_PAD,
  MAP_ROWS,
  boxFor,
  fitBox,
  lightPoints,
  placeRibbon,
  type Box,
  type Fit,
  type Point,
  type Rect,
  type Square,
} from "../../lib/map-fit";
import type { MapArc, MapLight } from "../../lib/map-lights";
import { Sculpture } from "./Sculpture";

/** The dotted world map, its location lights, the relay arc and the glass
 * ribbon (design-system.md 5.1 to 5.4).
 *
 * Two hosts, one per layout, so the lights are never under a blur:
 *  - `scene` (wide windows): a layer behind the whole app. With 200px or
 *    more beside the hero's copy, the lights sit in that strip, low, with
 *    the ribbon above them ("strip"); narrower, they take a band along the
 *    hero's bottom, which gives way -- the lights step aside, the map stays
 *    put -- when a message must be read or the primary button would not
 *    fit above it ("band").
 *  - `stage` (medium and phone): an element in the hero's column, where the
 *    sculpture was. The lights scroll with it; the ribbon rides over the
 *    map's empty north-east, which holds no light.
 *
 * Placement depends on the window, the layout, the language and the route
 * list only -- never on the connection state -- so nothing moves when the
 * state changes. The map never mirrors in RTL: geography has no reading
 * direction. Which lights are lit, and how, is `lib/map-lights.ts`'s alone;
 * this draws what it is given. Decorative and `aria-hidden` throughout: the
 * meaning is in words in the locations panel's legend and the list.
 *
 * Motion is CSS only (pearl.css): opacity and transform, at most ten lights,
 * still under reduced motion, paused under an open dialog or menu and while
 * the window is hidden (`data-vis`). */

export type MapHost = "scene" | "stage";

export interface WorldMapProps {
  host: MapHost;
  lights: readonly MapLight[];
  arc: MapArc | null;
  /** Every country this list can light or leave from: the box the map
   * fits, and what the ribbon keeps clear of. Stable for a route list, so
   * a connect never moves anything. */
  countries: readonly string[];
  /** The glass ribbon over the map. */
  ribbon?: boolean;
  /** A message the customer must read is showing (a banner, an error, the
   * device limit): the band and the phone's stage give way to it. */
  alert?: boolean;
}

type Mode = "strip" | "band" | "band-yield" | "stage" | "none";

interface Placement {
  mode: Mode;
  fit: Fit | null;
  /** Whether the lights may show: not when the band has given way. */
  lights: boolean;
  /** Where the ribbon would like to be, before it is kept off the lights. */
  wanted: Square | null;
  /** The band's height, kept clear under the copy in "band". */
  band: number;
}

const NONE: Placement = { mode: "none", fit: null, lights: false, wanted: null, band: 0 };

function relTo(origin: DOMRect) {
  return (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  };
}

/** The wide layouts, measured against the app root (the scene's own box). */
function placeInScene(app: HTMLElement, box: Box, alert: boolean, bandNow: number): Placement {
  const hero = app.querySelector<HTMLElement>(".nx-hero");
  const copy = app.querySelector<HTMLElement>(".nx-hero-copy");
  if (!hero || !copy) return NONE;
  const origin = app.getBoundingClientRect();
  const rel = relTo(origin);
  const heroBox = rel(hero);
  if (heroBox.w < 40 || heroBox.h < 40) return NONE;
  const copyBox = rel(copy);
  const rtl = getComputedStyle(app).direction === "rtl";
  // The hero's whole height, the band it may have given up included.
  const area = { ...heroBox, h: heroBox.h + bandNow };
  const copyEnd = rtl ? copyBox.x : copyBox.x + copyBox.w;
  const stripW = rtl ? copyEnd - area.x - 16 : area.x + area.w - copyEnd - 16;

  if (stripW >= 200) {
    // Below the floating VPN / Gaming switch, when it is in its corner.
    let top = area.y + 12;
    const bar = app.querySelector<HTMLElement>(".nx-ov > .nx-modebar");
    if (bar && bar.offsetParent !== null) {
      const r = rel(bar);
      if (r.h > 0) top = Math.max(top, r.y + r.h + 14);
    }
    const x = rtl ? area.x + 6 : copyEnd + 16;
    const w = stripW - 6;
    const stage = { x, y: top, w, h: area.y + area.h - 10 - top };
    const fit = fitBox(box, stage, { align: "bottom", share: 0.5 });
    if (!fit) return { ...NONE, mode: "strip" };
    const above = fit.oy + box.y0 * fit.k - MAP_PAD - 16 - stage.y;
    const size = Math.min(w * 1.12, above);
    const wanted = size > 0 ? { x: x + w / 2 - size / 2, y: stage.y + Math.max(0, (above - size) / 2), s: size } : null;
    return { mode: "strip", fit, lights: true, wanted, band: 0 };
  }

  // Compact wide: a band along the hero's bottom.
  const bandH = Math.round(Math.max(110, Math.min(150, origin.height * 0.18)));
  const press = copy.querySelector(".nx-actions") ?? copy.querySelector(".nx-btn");
  let pressBottom = 0;
  if (press) pressBottom = press.getBoundingClientRect().bottom - hero.getBoundingClientRect().top + hero.scrollTop;
  const yieldBand = alert || pressBottom + 12 > area.h - bandH;
  const stage = { x: area.x + 8, y: area.y + area.h - bandH, w: area.w - 16, h: bandH };
  const fit = fitBox(box, stage);
  const band = yieldBand ? 0 : bandH;
  const above = area.h - band - 16;
  const size = Math.min(origin.width * 0.24, origin.height * 0.42, above);
  const wanted = size > 0 ? { x: rtl ? area.x + 8 : area.x + area.w - size - 8, y: area.y + (above - size) / 2, s: size } : null;
  return { mode: yieldBand ? "band-yield" : "band", fit, lights: !yieldBand && fit !== null, wanted, band };
}

/** The column layouts, measured in the stage's own box. */
function placeInStage(stage: HTMLElement, box: Box): Placement {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w < 40 || h < 40) return NONE;
  const fit = fitBox(box, { x: 0, y: 0, w, h });
  if (!fit) return NONE;
  // The map's empty north-east: right of Tehran, above Singapore.
  const left = fit.ox + box.x0 * fit.k;
  const top = fit.oy + box.y0 * fit.k;
  const bw = (box.x1 - box.x0) * fit.k;
  const bh = (box.y1 - box.y0) * fit.k;
  const vx0 = left + 0.56 * bw;
  const vx1 = w - 4;
  const vy0 = 2;
  const vy1 = top + 0.8 * bh;
  const size = Math.min(vx1 - vx0, vy1 - vy0);
  const wanted = size > 0 ? { x: vx0 + (vx1 - vx0 - size) / 2, y: vy0 + (vy1 - vy0 - size) / 2, s: size } : null;
  return { mode: "stage", fit, lights: true, wanted, band: 0 };
}

/** Equal to within half a pixel: a re-measure that changes nothing visible
 * does not re-render. */
function samePlacement(a: Placement, b: Placement): boolean {
  const near = (x: number | undefined, y: number | undefined, tolerance = 0.5) =>
    x === undefined || y === undefined ? x === y : Math.abs(x - y) < tolerance;
  return (
    a.mode === b.mode &&
    a.lights === b.lights &&
    a.band === b.band &&
    near(a.fit?.k, b.fit?.k, 0.001) &&
    near(a.fit?.ox, b.fit?.ox) &&
    near(a.fit?.oy, b.fit?.oy) &&
    near(a.wanted?.x, b.wanted?.x) &&
    near(a.wanted?.y, b.wanted?.y) &&
    near(a.wanted?.s, b.wanted?.s)
  );
}

/** A light's twinkle: 2.4 to 3.4 s and a phase, fixed per country, so
 * adding a country never retimes the others. */
function twinkle(cc: string): CSSProperties {
  let h = 7;
  for (let i = 0; i < cc.length; i++) h = (h * 31 + cc.charCodeAt(i)) % 9973;
  const period = 2.4 + (h % 100) / 100;
  const phase = -((h * 0.83) % period);
  return { "--tw": `${period.toFixed(2)}s`, "--twd": `${phase.toFixed(2)}s` } as CSSProperties;
}

function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

export function WorldMap({ host, lights, arc, countries, ribbon = true, alert = false }: WorldMapProps) {
  const { language } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(NONE);
  const hidden = useWindowHidden();
  const bandRef = useRef(0);
  const countryKey = countries.join(",");
  const box = useMemo(() => boxFor(countries), [countryKey]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const app = node.closest<HTMLElement>(".nx-app");
    let frame = 0;

    const measure = () => {
      frame = 0;
      let next: Placement;
      if (host === "scene") {
        next = app ? placeInScene(app, box, alert, bandRef.current) : NONE;
        if (app) {
          if (bandRef.current !== next.band) {
            bandRef.current = next.band;
            app.style.setProperty("--band", `${next.band}px`);
          }
          if (app.dataset.mapmode !== next.mode) app.dataset.mapmode = next.mode;
        }
      } else {
        next = placeInStage(node, box);
        if (app && app.dataset.mapmode !== "stage") app.dataset.mapmode = "stage";
      }
      setPlacement((prev) => (samePlacement(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (app) observer?.observe(app);
    if (host === "scene") {
      for (const sel of [".nx-hero", ".nx-hero-copy", ".nx-ov > .nx-modebar"]) {
        const el = app?.querySelector(sel);
        if (el) observer?.observe(el);
      }
    } else observer?.observe(node);
    // The switch and the panel arrive with the subscription, after the
    // first paint: a change in what the overview holds re-measures too.
    const overview = app?.querySelector(".nx-ov");
    const mutations = overview && typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    if (overview) mutations?.observe(overview, { childList: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", schedule);
      // Leave the app root as it was found. A layout cleanup, so it runs
      // before the other host's first measure when the layout changes.
      if (app) {
        delete app.dataset.mapmode;
        app.style.removeProperty("--band");
      }
      bandRef.current = 0;
    };
  }, [host, box, alert, language]);

  const { fit } = placement;
  const shown = placement.lights && fit !== null;
  const points = useMemo<Point[]>(() => {
    if (!fit) return [];
    const all = [...new Set([...countries, ...lights.map((l) => l.cc)])];
    return lightPoints(all, fit);
  }, [fit, countryKey, lights]);
  const at = new Map(points.map((p) => [p.cc, p]));
  const sculpture = ribbon && placement.wanted ? placeRibbon(placement.wanted, shown ? points : []) : null;

  let arcPath: string | null = null;
  if (shown && arc) {
    const p0 = at.get(arc.from);
    const p1 = at.get(arc.to);
    if (p0 && p1) {
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2 - d * 0.32;
      arcPath = `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }
  }

  const dots = fit ? (
    <div
      className="nx-mapdots on"
      style={{
        width: MAP_COLS * fit.k,
        height: MAP_ROWS * fit.k,
        transform: `translate(${(fit.ox - 0.5 * fit.k).toFixed(2)}px, ${(fit.oy - 0.5 * fit.k).toFixed(2)}px)`,
      }}
      dangerouslySetInnerHTML={{ __html: mapSvg }}
    />
  ) : (
    <div className="nx-mapdots" />
  );

  return (
    <div
      ref={root}
      className={host === "scene" ? "nx-map" : "nx-mapstage"}
      aria-hidden
      data-vis={hidden ? "hidden" : "visible"}
      data-alert={host === "stage" && alert ? "1" : undefined}
      dir="ltr"
    >
      {host === "stage" ? <div className="nx-mapclip">{dots}</div> : dots}
      {shown ? (
        <>
          {arcPath ? (
            <svg className="nx-arcs" focusable="false">
              <path className={arc?.solid ? "nx-arc on" : "nx-arc"} d={arcPath} />
            </svg>
          ) : null}
          <div className="nx-lamps">
            {lights.map((light) => {
              const p = at.get(light.cc);
              if (!p) return null;
              return (
                <i
                  key={light.cc}
                  className="nx-lamp"
                  data-cc={light.cc}
                  data-look={light.look}
                  data-why={light.why}
                  data-listed={light.listed ? undefined : "0"}
                  data-exit={light.exit ? "1" : undefined}
                  data-anim={light.anim ? "1" : undefined}
                  style={{ ...twinkle(light.cc), "--lx": `${p.x.toFixed(1)}px`, "--ly": `${p.y.toFixed(1)}px` } as CSSProperties}
                />
              );
            })}
          </div>
        </>
      ) : null}
      {sculpture ? <Sculpture x={sculpture.x} y={sculpture.y} size={sculpture.s} /> : null}
    </div>
  );
}
