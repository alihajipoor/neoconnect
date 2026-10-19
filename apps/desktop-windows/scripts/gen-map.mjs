// Turns Natural Earth land into the main page's dotted world map.
//
//   node scripts/gen-map.mjs --land <land-110m.json> [--svg src/assets/world-map.svg]
//                            [--geo src/lib/map-geo.json] [--cols 200] [--north 78] [--south -56]
//
// Run from apps/desktop-windows. Both outputs are committed; rerun only when
// a country is added to the list (an anchor below) or the look changes.
//
// The input is world-atlas's `land-110m.json`, fetched as data into an empty
// folder outside the repo, never installed:
//
//   npm pack world-atlas@2.0.2 --ignore-scripts --pack-destination <empty dir>
//   tar -xzf <empty dir>/world-atlas-2.0.2.tgz -C <empty dir>
//   node scripts/gen-map.mjs --land <empty dir>/package/land-110m.json
//
// The TopoJSON is decoded here (about thirty lines below), so no downloaded
// code runs. Decoding follows the TopoJSON spec: quantized, delta-encoded
// arcs; a negative index ~i is arc i reversed; consecutive arcs of a ring
// share their joining point.
//
// Outputs:
//   world-map.svg  one <path> of zero-length, round-capped segments -- dots --
//                  on a regular grid in the Robinson projection, cropped to
//                  the populated world (Antarctica and the high Arctic
//                  dropped). Stroked with currentColor, so the app tints it
//                  with a design token and one file serves both themes.
//   map-geo.json   the grid, and one display anchor per country the app can
//                  list, in the SVG's own units.
//
// The anchors are a representative CITY for a COUNTRY, chosen for display.
// They are never node locations or addresses, and nothing about a node may
// ever feed them: the app places a light by the country code of a route's
// region slug, and draws nothing for a country with no anchor here.
//
// Licences: Natural Earth data is in the public domain. world-atlas, which
// packages it as TopoJSON, is ISC, (c) Michael Bostock; its notice is kept
// in src/assets/world-atlas-LICENSE.txt beside the generated map, and must
// stay in the app's third-party notices.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
if (!args.land) {
  console.error("usage: node scripts/gen-map.mjs --land <land-110m.json> [--svg <out.svg>] [--geo <out.json>] [--cols 200]");
  process.exit(2);
}
const SVG_OUT = args.svg ?? "src/assets/world-map.svg";
const GEO_OUT = args.geo ?? "src/lib/map-geo.json";
const COLS = Number(args.cols ?? 200);
const NORTH = Number(args.north ?? 78);
const SOUTH = Number(args.south ?? -56);

/* ---------- TopoJSON decode (the land object only: Polygon and MultiPolygon) ---------- */
const topo = JSON.parse(fs.readFileSync(args.land, "utf8"));
const {
  scale: [kx, ky],
  translate: [dx, dy],
} = topo.transform;
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([a, b]) => {
    x += a;
    y += b;
    return [x * kx + dx, y * ky + dy];
  });
});
const arcPoints = (i) => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
const ring = (ids) => {
  const out = [];
  ids.forEach((id, k) => {
    const p = arcPoints(id);
    out.push(...(k ? p.slice(1) : p));
  });
  return out;
};

/* world-atlas 2 keeps spherical rings: one that crosses the antimeridian
   (Chukotka, Wrangel Island, Fiji) jumps from +180 to -180, which a planar
   point-in-polygon test reads as an edge across the whole map. Each ring is
   unwrapped into a continuous run of longitudes (which may pass 180), and
   points are tested at lon and lon +/- 360. A ring that circles the pole
   (Antarctica) cannot be unwrapped into a plane; it lies south of the crop
   and is dropped. */
const unwrap = (r) => {
  const out = [r[0].slice()];
  let off = 0;
  for (let i = 1; i < r.length; i++) {
    const dl = r[i][0] - r[i - 1][0];
    if (dl > 180) off -= 360;
    else if (dl < -180) off += 360;
    out.push([r[i][0] + off, r[i][1]]);
  }
  return out;
};
const polygons = [];
let dropped = 0;
for (const g of topo.objects.land.geometries) {
  const polys = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
  for (const rings of polys) {
    const rs = rings.map(ring).map(unwrap);
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const [x, y] of rs[0]) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    // Did not close after unwrapping: it circles a pole.
    const open = Math.abs(rs[0][0][0] - rs[0][rs[0].length - 1][0]) > 1;
    if (open || y1 < SOUTH - 4) {
      dropped++;
      continue;
    }
    polygons.push({ rs, bb: [x0, y0, x1, y1] });
  }
}
/* Even-odd over every ring of a polygon, so holes (the Caspian, large lakes) stay out. */
function inPolygon(p, lon, lat) {
  const [x0, y0, x1, y1] = p.bb;
  if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  let inside = false;
  for (const r of p.rs) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function onLand(lon, lat) {
  for (const p of polygons) {
    if (inPolygon(p, lon, lat) || inPolygon(p, lon + 360, lat) || inPolygon(p, lon - 360, lat)) return true;
  }
  return false;
}

/* ---------- Robinson (Robinson 1974 table, 5-degree steps, linear interpolation), R = 1 ---------- */
const PLEN = [1.0, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const PDFE = [0.0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1.0];
const interp = (table, alat) => {
  const f = Math.min(17.9999, alat / 5);
  const i = Math.floor(f);
  return table[i] + (table[i + 1] - table[i]) * (f - i);
};
const robX = (lon, lat) => 0.8487 * interp(PLEN, Math.abs(lat)) * ((lon * Math.PI) / 180);
const robY = (lat) => Math.sign(lat) * 1.3523 * interp(PDFE, Math.abs(lat));
function invLat(y) {
  const yn = Math.abs(y) / 1.3523;
  if (yn >= 1) return Math.sign(y) * 90;
  let i = 0;
  while (i < 17 && PDFE[i + 1] < yn) i++;
  return Math.sign(y) * 5 * (i + (yn - PDFE[i]) / (PDFE[i + 1] - PDFE[i]));
}

/* ---------- the dot grid: regular in projected space ---------- */
const XMAX = 0.8487 * Math.PI; // half the width at the equator
const PITCH = (2 * XMAX) / COLS; // projection units per dot
const YTOP = robY(NORTH);
const YBOT = robY(SOUTH);
const ROWS = Math.ceil((YTOP - YBOT) / PITCH);
let d = "";
let dots = 0;
for (let j = 0; j < ROWS; j++) {
  const y = YTOP - (j + 0.5) * PITCH;
  const lat = invLat(y);
  const plen = 0.8487 * interp(PLEN, Math.abs(lat));
  let last = null;
  for (let i = 0; i < COLS; i++) {
    const x = -XMAX + (i + 0.5) * PITCH;
    const lon = ((x / plen) * 180) / Math.PI;
    if (Math.abs(lon) > 180) continue; // outside the outline at this latitude
    if (!onLand(lon, lat)) continue;
    d += last == null ? `M${i} ${j}h0` : `m${i - last} 0h0`;
    last = i;
    dots++;
  }
}

/* ---------- display anchors: one city per country the app can name (route-place.ts) ----------
   `listed`: in the route list when this was generated (2026-10-19). The app
   fits the box around those into the hero, and widens it for any other
   country its list names. Never a node's location. */
const ANCHORS = [
  { cc: "gb", city: "London", lat: 51.5074, lon: -0.1278, listed: true },
  { cc: "fr", city: "Paris", lat: 48.8566, lon: 2.3522, listed: true },
  { cc: "de", city: "Frankfurt", lat: 50.1109, lon: 8.6821, listed: true },
  { cc: "fi", city: "Helsinki", lat: 60.1699, lon: 24.9384, listed: true },
  { cc: "tr", city: "Istanbul", lat: 41.0082, lon: 28.9784, listed: true },
  { cc: "ir", city: "Tehran", lat: 35.6892, lon: 51.389, listed: true, role: "relay-entry" },
  { cc: "sg", city: "Singapore", lat: 1.3521, lon: 103.8198, listed: true },
  { cc: "nl", city: "Amsterdam", lat: 52.3676, lon: 4.9041, listed: false },
  { cc: "ae", city: "Dubai", lat: 25.2048, lon: 55.2708, listed: false },
  { cc: "us", city: "New York", lat: 40.7128, lon: -74.006, listed: false },
];
const toGrid = (lon, lat) => [(robX(lon, lat) + XMAX) / PITCH - 0.5, (YTOP - robY(lat)) / PITCH - 0.5];
const anchors = {};
for (const a of ANCHORS) {
  const [x, y] = toGrid(a.lon, a.lat);
  anchors[a.cc] = { city: a.city, x: +x.toFixed(3), y: +y.toFixed(3), listed: a.listed, ...(a.role ? { role: a.role } : {}) };
}
const listed = Object.values(anchors).filter((a) => a.listed);
const box = {
  x0: Math.min(...listed.map((a) => a.x)),
  y0: Math.min(...listed.map((a) => a.y)),
  x1: Math.max(...listed.map((a) => a.x)),
  y1: Math.max(...listed.map((a) => a.y)),
};

/* ---------- write ---------- */
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 ${COLS} ${ROWS}" aria-hidden="true" focusable="false" preserveAspectRatio="none">` +
  `<!-- Natural Earth land 1:110m (public domain) via world-atlas 2.0.2 (ISC, (c) Michael Bostock). Robinson, ${COLS} columns, ${NORTH}N to ${-SOUTH}S. Generated by scripts/gen-map.mjs. -->` +
  `<path fill="none" stroke="currentColor" stroke-width=".56" stroke-linecap="round" d="${d}"/></svg>\n`;
fs.mkdirSync(path.dirname(SVG_OUT), { recursive: true });
fs.writeFileSync(SVG_OUT, svg);
const geo = {
  source: "Natural Earth 1:110m land (public domain), via world-atlas 2.0.2 (ISC, (c) Michael Bostock). Generated by scripts/gen-map.mjs.",
  projection: "Robinson (1974 table, 5-degree steps, linear interpolation)",
  grid: { cols: COLS, rows: ROWS, north: NORTH, south: SOUTH, dots },
  units: "Grid steps: dot (i, j) is at (i, j); the SVG's viewBox starts at -0.5.",
  anchors,
  listedBox: box,
  privacy: "Anchors are one representative city per country, chosen for display. They are not node locations or addresses, and the app never derives one from a node.",
};
fs.mkdirSync(path.dirname(GEO_OUT), { recursive: true });
fs.writeFileSync(GEO_OUT, JSON.stringify(geo, null, 2) + "\n");
console.log(JSON.stringify({ droppedPolarRings: dropped, cols: COLS, rows: ROWS, dots, svgBytes: Buffer.byteLength(svg), listedBox: box }));
