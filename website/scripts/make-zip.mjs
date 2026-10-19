#!/usr/bin/env node
/**
 * Fallback archive builder for make-zip.sh, for a machine with neither `zip`
 * nor Python -- a stock Windows box with Node, which is what the owner's PC
 * is. Node's own zlib, no packages.
 *
 *   node scripts/make-zip.mjs <site_dir> <archive_path>
 *
 * Entry names always use FORWARD slashes, as the ZIP spec requires.
 * PowerShell's Compress-Archive writes backslashes, which unpack on the
 * Linux host as one flat pile of files literally named "inc\bootstrap.php";
 * that has bitten this project before and is why this exists at all.
 *
 * The exclusion list mirrors make-zip.sh and make-zip.py exactly. If you
 * change one, change all three in the same sitting.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [,, siteArg, archiveArg] = process.argv;
if (!siteArg || !archiveArg) {
  console.error('usage: node make-zip.mjs <site_dir> <archive_path>');
  process.exit(2);
}
const site = path.resolve(siteArg);
const archive = path.resolve(archiveArg);

function excluded(rel) {
  if (rel === 'README.md' || rel === 'make-zip.sh' || rel === '.gitignore') return true;
  if (rel.endsWith('/.gitignore')) return true;
  if (rel.startsWith('build/') || rel.startsWith('scripts/')) return true;
  if (rel === 'nginx-website.conf.example') return true;
  if (rel.endsWith('.zip')) return true;
  if (rel === 'data/secret.php' || rel === 'data/ratelimit.php') return true;
  if (/^data\/submissions-.*\.php$/.test(rel)) return true;
  return false;
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(site, abs).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (rel === 'build' || rel === 'scripts') continue;
      walk(abs, out);
    } else if (ent.isFile() && !excluded(rel)) {
      out.push({ abs, rel });
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const files = walk(site, []);
const parts = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const name = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);
  const { time, date } = dosTime(fs.statSync(f.abs).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, name, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0x0314, 4); // made by: Unix, so permissions below apply
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(((0o100644) << 16) >>> 0, 38); // -rw-r--r--
  cd.writeUInt32LE(offset, 42);
  central.push(cd, name);

  offset += local.length + name.length + body.length;
}

const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.dirname(archive), { recursive: true });
fs.writeFileSync(archive, Buffer.concat([...parts, cdBuf, end]));
console.log('Built: ' + archive);
console.log(files.length + ' files. Top level:');
for (const top of [...new Set(files.map((f) => f.rel.split('/')[0]))].sort()) console.log('  ' + top);
