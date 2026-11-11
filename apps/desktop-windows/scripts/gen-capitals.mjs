// Reads every country's capital out of Natural Earth's populated places.
//
//   node scripts/gen-capitals.mjs --places <ne_10m_populated_places_simple.geojson> [--out scripts/capitals.json]
//
// Run from apps/desktop-windows. The output is committed, and is what
// scripts/gen-map.mjs turns into the world map's display anchors: one per
// ISO 3166-1 country, so a server opened in any country has a place for its
// light without a new release of the app. Rerun only to take a newer Natural
// Earth, or when the standard gains a code (name it in
// src/lib/country-names.ts first: that list is what this walks).
//
// The input is Natural Earth 5.1.2's populated places at 1:10m, fetched as
// data into an empty folder outside the repo:
//
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_populated_places_simple.geojson
//
// It is parsed as JSON and nothing else is done with it. Natural Earth is in
// the public domain (https://www.naturalearthdata.com/about/terms-of-use/).
//
// Where each capital comes from, recorded per entry as `from`:
//
//   "ne"         Natural Earth's own national capital for that ISO code. Where
//                it lists several (South Africa, Bolivia), the one it marks as
//                the capital proper, then the largest.
//   "ne-admin1"  Natural Earth files the territory under its parent country
//                and lists its capital as a regional one (the French overseas
//                departments, Puerto Rico, the Faroes). Named in ADMIN1 below.
//   "hand"       Natural Earth has no capital for it at all: small island
//                territories, and four places with no town to name
//                (Antarctica, Bouvet Island, Heard Island, the U.S. outlying
//                islands), which get a point on the territory itself. Written
//                in HAND below, to a tenth of a degree or better -- one step of
//                the map's grid is 1.8 degrees.
//
// These are capitals of countries. Nothing about a server feeds this file.

import fs from "node:fs";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
if (!args.places) {
  console.error("usage: node scripts/gen-capitals.mjs --places <ne_10m_populated_places_simple.geojson> [--out scripts/capitals.json]");
  process.exit(2);
}
const OUT = args.out ?? "scripts/capitals.json";

const names = fs.readFileSync("src/lib/country-names.ts", "utf8");
const codes = [...names.matchAll(/^ {2}([a-z]{2}): \{ en: /gm)].map((m) => m[1]);
if (codes.length !== 249) {
  console.error(`expected 249 codes in src/lib/country-names.ts; read ${codes.length}`);
  process.exit(1);
}

/** National capitals Natural Earth has, where its own ranking would pick
 * another of the same class. Ramallah and Gaza City are both listed for
 * Palestine; the administrative centre is the first. */
const PREFER = { ps: "Ramallah" };

/** Capitals Natural Earth lists as regional ones under a parent country. */
const ADMIN1 = {
  ck: "Avarua",
  fo: "Tórshavn",
  gf: "Cayenne",
  gp: "Basse-terre",
  gs: "Grytviken",
  mp: "Capitol Hill",
  mq: "Fort-de-France",
  pr: "San Juan",
  re: "St.-Denis",
};

/** Not in Natural Earth: [city or place, latitude, longitude]. */
const HAND = {
  ai: ["The Valley", 18.217, -63.058],
  aq: ["McMurdo Station", -77.846, 166.676],
  bl: ["Gustavia", 17.896, -62.85],
  bq: ["Kralendijk", 12.144, -68.266],
  bv: ["Bouvet Island", -54.42, 3.36],
  cc: ["West Island", -12.157, 96.823],
  cx: ["Flying Fish Cove", -10.422, 105.679],
  gg: ["St Peter Port", 49.456, -2.537],
  hm: ["Heard Island", -53.1, 73.51],
  io: ["Diego Garcia", -7.313, 72.411],
  je: ["St Helier", 49.186, -2.11],
  mf: ["Marigot", 18.068, -63.083],
  ms: ["Brades", 16.793, -62.211],
  nf: ["Kingston", -29.057, 167.962],
  nr: ["Yaren", -0.548, 166.921],
  nu: ["Alofi", -19.055, -169.918],
  pm: ["Saint-Pierre", 46.781, -56.176],
  pn: ["Adamstown", -25.067, -130.1],
  sh: ["Jamestown", -15.925, -5.718],
  sx: ["Philipsburg", 18.024, -63.046],
  tf: ["Port-aux-Français", -49.35, 70.22],
  tk: ["Fakaofo", -9.38, -171.219],
  um: ["Wake Island", 19.282, 166.647],
  vg: ["Road Town", 18.429, -64.619],
  vi: ["Charlotte Amalie", 18.342, -64.931],
  wf: ["Mata-Utu", -13.283, -176.174],
  yt: ["Mamoudzou", -12.781, 45.228],
};

const places = JSON.parse(fs.readFileSync(args.places, "utf8")).features.map((f) => ({
  ...f.properties,
  lon: f.geometry.coordinates[0],
  lat: f.geometry.coordinates[1],
}));
const CLASS = { "Admin-0 capital": 0, "Admin-0 capital alt": 1, "Admin-0 region capital": 2 };
const tidy = (name) => name.replace(/\s+/g, " ").trim();
const round = (n) => +n.toFixed(3);

const capitals = {};
const count = { ne: 0, "ne-admin1": 0, hand: 0 };
for (const cc of codes) {
  const here = places.filter((p) => p.iso_a2 === cc.toUpperCase());
  const national = here
    .filter((p) => p.featurecla in CLASS)
    .sort(
      (a, b) =>
        (PREFER[cc] === b.name) - (PREFER[cc] === a.name) ||
        CLASS[a.featurecla] - CLASS[b.featurecla] ||
        b.adm0cap - a.adm0cap ||
        a.capalt - b.capalt ||
        b.pop_max - a.pop_max,
    )[0];
  const regional = ADMIN1[cc] ? here.find((p) => p.name === ADMIN1[cc]) : null;
  let entry;
  if (national) entry = { city: tidy(national.name), lat: round(national.lat), lon: round(national.lon), from: "ne" };
  else if (regional) entry = { city: tidy(regional.name), lat: round(regional.lat), lon: round(regional.lon), from: "ne-admin1" };
  else if (HAND[cc]) entry = { city: HAND[cc][0], lat: HAND[cc][1], lon: HAND[cc][2], from: "hand" };
  else {
    console.error(`${cc}: no capital in Natural Earth and none written here`);
    process.exit(1);
  }
  capitals[cc] = entry;
  count[entry.from]++;
}
for (const cc of [...Object.keys(ADMIN1), ...Object.keys(HAND)]) {
  if (capitals[cc].from === "ne") console.error(`note: ${cc} is in Natural Earth now (${capitals[cc].city}); its entry here is unused`);
}

const out = {
  source:
    "Capitals from Natural Earth 5.1.2 populated places 1:10m (public domain). `from` says where each came from: ne, ne-admin1, or hand for the territories Natural Earth lists no capital for. Generated by scripts/gen-capitals.mjs.",
  capitals,
};
// One line per country, so a change reads as one line in a diff.
const line = ([cc, c]) => `    "${cc}": { "city": ${JSON.stringify(c.city)}, "lat": ${c.lat}, "lon": ${c.lon}, "from": "${c.from}" }`;
fs.writeFileSync(
  OUT,
  `{\n  "source": ${JSON.stringify(out.source)},\n  "capitals": {\n${Object.entries(capitals).map(line).join(",\n")}\n  }\n}\n`,
);
console.log(JSON.stringify({ codes: codes.length, ...count }));
