import { deflateSync } from "node:zlib";

/** The Neoxify mark, as both SVG and PNG.
 *
 * One geometry, two encodings, because the two places that need it
 * cannot use the same one. The invoice renders in a browser and takes
 * the SVG. Email cannot: Gmail strips inline SVG and blocks data: URIs
 * on images, so a mark in an email has to be a raster fetched over
 * HTTP. Rather than keep a hand-exported PNG in the repo that silently
 * drifts from the vector, the PNG is rasterised here from the same
 * numbers.
 *
 * Rasterised in plain JS on purpose. Pulling in sharp or resvg to draw
 * two circles would add a native build dependency to the API image for
 * a 128x128 image that never changes.
 */

const VIEWBOX = 64;

// Straight from the SVG: a broken ring around a solid centre.
const CENTRE = 32;
const RING_RADIUS = 21;
const RING_WIDTH = 7;
const CORE_RADIUS = 8;
const ROTATION_DEG = -58;

/** r=21 gives a circumference of ~131.95, so 96 on / 36 off is exactly
 * one stroke and one gap. Changing the radius means recomputing these
 * or the gap multiplies. */
const DASH_ON = 96;
const DASH_PERIOD = 132;

const GRADIENT_FROM = [0x8b, 0x5c, 0xf6] as const; // violet
const GRADIENT_TO = [0x22, 0xd3, 0xee] as const; // cyan

/** White, for placing on the violet header both the invoice and the
 * email use.
 *
 * Not a stylistic preference -- the gradient runs violet to cyan, and
 * on a violet background the violet half of the ring simply is not
 * there. A brand mark that reads as a broken crescent is worse than one
 * drawn in a single colour.
 */
export const BRAND_LOGO_SVG_MONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
  <circle cx="32" cy="32" r="21" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-dasharray="96 36" transform="rotate(-58 32 32)"/>
  <circle cx="32" cy="32" r="8" fill="currentColor"/>
</svg>`;

export const BRAND_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="nx" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="21" stroke="url(#nx)" stroke-width="7" stroke-linecap="round" stroke-dasharray="96 36" transform="rotate(-58 32 32)"/>
  <circle cx="32" cy="32" r="8" fill="url(#nx)"/>
</svg>`;

/** Where a dash ends up once the whole ring is rotated. Used for the
 * round caps, which are semicircles centred on the stroke's endpoints
 * -- without them the mark reads as chopped off rather than drawn. */
function dashEndpoint(arcLength: number): { x: number; y: number } {
  const angle = ((arcLength / DASH_PERIOD) * 360 + ROTATION_DEG) * (Math.PI / 180);
  return {
    x: CENTRE + RING_RADIUS * Math.cos(angle),
    y: CENTRE + RING_RADIUS * Math.sin(angle),
  };
}

const CAP_RADIUS = RING_WIDTH / 2;
const CAP_START = dashEndpoint(0);
const CAP_END = dashEndpoint(DASH_ON);

/** Whether a point in viewBox space is inside the mark. */
function covers(x: number, y: number): boolean {
  const dx = x - CENTRE;
  const dy = y - CENTRE;
  const distance = Math.hypot(dx, dy);

  if (distance <= CORE_RADIUS) return true;

  const inAnnulus =
    distance >= RING_RADIUS - CAP_RADIUS && distance <= RING_RADIUS + CAP_RADIUS;
  if (inAnnulus) {
    // Undo the rotation, then ask where along the dash pattern this
    // angle falls. Degrees measured clockwise from +x, matching SVG's
    // y-down coordinates.
    let degrees = (Math.atan2(dy, dx) * 180) / Math.PI - ROTATION_DEG;
    degrees = ((degrees % 360) + 360) % 360;
    if ((degrees / 360) * DASH_PERIOD < DASH_ON) return true;
  }

  return (
    Math.hypot(x - CAP_START.x, y - CAP_START.y) <= CAP_RADIUS ||
    Math.hypot(x - CAP_END.x, y - CAP_END.y) <= CAP_RADIUS
  );
}

/** The gradient runs corner to corner, so a point's colour depends only
 * on how far along that diagonal it sits -- which is what
 * `x1=0 y1=0 x2=1 y2=1` in objectBoundingBox units means. */
function gradientAt(x: number, y: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * VIEWBOX)));
  return [
    Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
    Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
    Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
  ];
}

/** 4x4 per pixel. The mark is nothing but curves, and at the sizes an
 * email header uses, aliased curves are the difference between a logo
 * and a jagged approximation of one. */
const SAMPLES = 4;

type Paint = (x: number, y: number) => [number, number, number];

function rasterise(size: number, paint: Paint): Buffer {
  // One filter byte per scanline (always 0 = None) plus RGBA.
  const raw = Buffer.alloc(size * (1 + size * 4));
  const scale = VIEWBOX / size;

  for (let py = 0; py < size; py++) {
    const rowStart = py * (1 + size * 4);
    raw[rowStart] = 0;
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (covers(x, y)) hits++;
        }
      }
      const offset = rowStart + 1 + px * 4;
      if (hits === 0) continue;

      const [r, g, b] = paint((px + 0.5) * scale, (py + 0.5) * scale);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }

  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size: number, paint: Paint): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace -- all zero, the only values
  // the spec defines.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rasterise(size, paint), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 128px so it still looks sharp on a high-DPI screen at the ~32px an
 * email header actually displays it. Built once at import: it never
 * changes, and rasterising it per request would be pure waste. */
export const BRAND_LOGO_PNG: Buffer = encodePng(128, gradientAt);

/** The white variant, for the violet email header -- same reasoning as
 * BRAND_LOGO_SVG_MONO above. */
export const BRAND_LOGO_PNG_MONO: Buffer = encodePng(128, () => [255, 255, 255]);
