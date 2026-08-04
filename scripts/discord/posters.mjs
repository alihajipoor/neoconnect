/**
 * Renders the channel header posters as PNGs.
 *
 * The mark is the product's own logo geometry, lifted verbatim from
 * apps/backend/src/modules/brand/logo.ts so it cannot drift from the app.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const W = 1200;
const H = 420;

/** The brand mark, from logo.ts: a rotated dashed ring plus a solid core. */
const mark = (x, y, size) => `
  <g transform="translate(${x} ${y}) scale(${size / 64})">
    <circle cx="32" cy="32" r="21" stroke="url(#nx)" stroke-width="7" stroke-linecap="round"
            stroke-dasharray="96 36" transform="rotate(-58 32 32)" fill="none"/>
    <circle cx="32" cy="32" r="8" fill="url(#nx)"/>
  </g>`;

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function poster({ title, subtitle, kicker, rtl = false }) {
  const family = rtl ? "Segoe UI, Tahoma, Arial" : "Segoe UI Semibold, Segoe UI, Arial";
  const anchor = rtl ? "end" : "start";
  const textX = rtl ? W - 96 : 96;
  const markX = rtl ? 96 : W - 232;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="nx" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.40"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d0b16"/><stop offset="1" stop-color="#08080e"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
  <ellipse cx="${markX + 84}" cy="210" rx="440" ry="300" fill="url(#glow)"/>
  ${mark(markX, 126, 168)}

  ${kicker ? `<text x="${textX}" y="150" text-anchor="${anchor}" font-family="${family}" font-size="26"
        letter-spacing="${rtl ? 0 : 6}" fill="#22d3ee" opacity="0.95">${escape(kicker)}</text>` : ""}

  <text x="${textX}" y="${kicker ? 234 : 210}" text-anchor="${anchor}" font-family="${family}"
        font-size="${title.length > 22 ? 60 : 74}" font-weight="700" fill="#f4f2ff">${escape(title)}</text>

  <rect x="${rtl ? W - 96 - 180 : 96}" y="${kicker ? 262 : 238}" width="180" height="4" rx="2" fill="url(#rule)"/>

  <text x="${textX}" y="${kicker ? 320 : 296}" text-anchor="${anchor}" font-family="${family}"
        font-size="28" fill="#a9a4c4">${escape(subtitle)}</text>
</svg>`;
}

const POSTERS = {
  welcome: { kicker: "NEOXIFY", title: "Welcome", subtitle: "Read the rules, pick your language, get connected." },
  announcements: { kicker: "NEOXIFY", title: "Announcements", subtitle: "Anything that affects your connection." },
  releases: { kicker: "NEOXIFY", title: "Releases", subtitle: "New builds, and what changed in them." },
  "server-status": { kicker: "NEOXIFY", title: "Server Status", subtitle: "Nodes and routes, as they stand right now." },
  faq: { kicker: "NEOXIFY", title: "FAQ", subtitle: "The questions that come up most." },
  resources: { kicker: "NEOXIFY", title: "Resources", subtitle: "Guides, links, and reference material." },
  "faq-fa": { kicker: "نئوکسیفای", title: "سوالات متداول", subtitle: "پرسش‌هایی که بیشتر پرسیده می‌شوند.", rtl: true },
  "resources-fa": { kicker: "نئوکسیفای", title: "منابع", subtitle: "راهنماها، لینک‌ها و منابع مفید.", rtl: true },
};

for (const [name, spec] of Object.entries(POSTERS)) {
  const svg = poster(spec);
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  writeFileSync(new URL(`./out/${name}.png`, import.meta.url), png);
  console.log(`  ${name}.png  ${(png.length / 1024).toFixed(0)} KB`);
}
