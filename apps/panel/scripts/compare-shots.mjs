#!/usr/bin/env node
// DEV ONLY: compare two folders of check:phone screenshots, pixel by pixel.
//
//   node scripts/compare-shots.mjs <before-dir> <after-dir>
//
// For each PNG in both folders: same size or not, how many pixels differ,
// and the box they fall in. Clocks and "2m ago" lines differ between any
// two runs, so a few small boxes are expected; a changed size or a large
// box is a layout change. Exits 1 when any image changed size.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Decodes the 8-bit, non-interlaced RGB/RGBA PNGs Chrome writes. */
function decode(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0, height = 0, colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: unsupported PNG`);
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`${file}: unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: compare-shots.mjs <before-dir> <after-dir>");
  process.exit(2);
}
let resized = 0;
for (const name of fs.readdirSync(beforeDir).filter((f) => f.endsWith(".png")).sort()) {
  const other = path.join(afterDir, name);
  if (!fs.existsSync(other)) {
    console.log(`missing   ${name}`);
    continue;
  }
  const a = decode(path.join(beforeDir, name));
  const b = decode(other);
  if (a.width !== b.width || a.height !== b.height) {
    resized++;
    console.log(`SIZE      ${name}: ${a.width}x${a.height} -> ${b.width}x${b.height}`);
    continue;
  }
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.bpp, j = (y * b.width + x) * b.bpp;
      if (a.data[i] !== b.data[j] || a.data[i + 1] !== b.data[j + 1] || a.data[i + 2] !== b.data[j + 2]) {
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  console.log(n ? `differs   ${name}: ${n} px in ${x0},${y0}..${x1},${y1}` : `same      ${name}`);
}
process.exit(resized ? 1 : 0);
