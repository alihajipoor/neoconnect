#!/usr/bin/env node
/**
 * Render the social preview cards, one per language, in a real browser.
 *
 *   node website/scripts/make-og-image.mjs [--chrome <path to chrome>]
 *
 * Writes assets/img/og-en-v2.png and og-fa-v2.png (1200x630, the size
 * Telegram, WhatsApp, Facebook, LinkedIn and X all crop from). Needs
 * `puppeteer-core` (no browser download -- it drives the Chrome already
 * installed); install it in a scratch directory and set NODE_PATH, as for
 * make-fonts.mjs.
 *
 * WHY A BROWSER. The card used to be drawn with Pillow, which cannot shape
 * Persian, so the Persian pages shared a Latin card. Chrome shapes Persian
 * correctly with the site's own Vazirmatn, so each language now gets its
 * own card, set in the same type as the site.
 *
 * If the art changes, bump the -vN in the file names AND in head.php:
 * scrapers cache images by exact URL more or less forever.
 *
 * What the card says is true and checkable: the name, the app's tagline,
 * the connection method families, the platforms that exist, the domain.
 * No count, no speed, no claim that can go stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.dirname(here);
const args = process.argv.slice(2);
const chromePath = args.includes('--chrome')
  ? args[args.indexOf('--chrome') + 1]
  : (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome');

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const asset = (p) => pathToFileURL(path.join(site, 'assets', p)).href;

const COPY = {
  en: {
    dir: 'ltr', font: '"Inter Tight","Inter"', body: '"Inter"',
    kicker: 'A VPN for networks that fight back',
    l1: 'Your internet.', l2: 'Without limits.',
    status: 'Connected',
    platforms: 'Windows · Android',
  },
  fa: {
    dir: 'rtl', font: '"Vazirmatn"', body: '"Vazirmatn"',
    kicker: 'فیلترشکن برای شبکه‌هایی که مقاومت می‌کنند',
    l1: 'اینترنت شما.', l2: 'بدون محدودیت.',
    status: 'متصل',
    platforms: 'ویندوز · اندروید',
  },
};
const METHODS = 'VLESS + REALITY · WireGuard · Shadowsocks · Trojan · OpenVPN · IKEv2';

function html(c) {
  return `<!doctype html><html lang="${c === COPY.fa ? 'fa' : 'en'}" dir="${c.dir}"><head><meta charset="utf-8"><style>
@font-face{font-family:"Inter";src:url(${asset('fonts/inter-latin-v1.woff2')});font-weight:400 700}
@font-face{font-family:"Inter Tight";src:url(${asset('fonts/inter-tight-latin-v1.woff2')});font-weight:700}
@font-face{font-family:"Vazirmatn";src:url(${asset('fonts/vazirmatn-v2.woff2')});font-weight:400 800}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:${c.body};color:#090B10;
  background:radial-gradient(55% 60% at 80% 18%,rgba(16,69,255,.18),transparent 70%),radial-gradient(40% 50% at 4% 96%,rgba(14,124,134,.12),transparent 70%),linear-gradient(#F7F9FC,#EDF1F6)}
.map{position:absolute;left:330px;top:40px;width:1300px;aspect-ratio:200/82;direction:ltr}
.map::before{content:"";position:absolute;inset:0;background:#BFCADC;-webkit-mask:url(${asset('map/world-map.svg')}) 0 0/100% 100% no-repeat}
.lamp{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:#1A7FD4;box-shadow:0 0 0 3px #fff,0 0 18px 5px rgba(26,127,212,.34)}
.here{width:22px;height:22px;margin:-11px 0 0 -11px;background:#1045FF;box-shadow:0 0 0 4px #fff,0 0 0 14px rgba(16,69,255,.25),0 0 34px 10px rgba(16,69,255,.3)}
.entry{background:#fff;box-shadow:inset 0 0 0 3px #7A89A3,0 0 0 3px #fff}
.wrap{position:absolute;inset:0;padding:64px 72px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;align-items:center;gap:14px;direction:ltr;align-self:flex-start}
html[dir=rtl] .map{left:-560px}
.word{font-family:"Inter","Vazirmatn";font-weight:500;font-size:26px;letter-spacing:.42em}
.kicker{font-family:${c.body};font-weight:600;font-size:22px;color:#0B3BE0;${c.dir === 'ltr' ? 'letter-spacing:.12em;text-transform:uppercase;' : ''}margin-top:26px}
h1{font-family:${c.font};font-weight:${c.dir === 'ltr' ? 700 : 800};font-size:${c.dir === 'ltr' ? 96 : 84}px;line-height:${c.dir === 'ltr' ? .98 : 1.3};letter-spacing:${c.dir === 'ltr' ? '-.05em' : '0'}}
h1 span{display:block}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:auto}
.chip{display:inline-flex;align-items:center;height:44px;padding:0 18px;border-radius:999px;background:rgba(255,255,255,.75);box-shadow:inset 0 0 0 1px rgba(32,48,80,.15);font-size:20px;font-weight:600;color:#4A5264}
.chip b{color:#090B10}
.status{position:absolute;${c.dir === 'ltr' ? 'right' : 'left'}:72px;bottom:64px;display:flex;align-items:center;gap:10px;height:52px;padding:0 22px 0 16px;border-radius:999px;background:rgba(255,255,255,.72);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 22px 44px -22px rgba(20,40,90,.35);color:#0B3BE0;font-weight:700;font-size:20px;${c.dir === 'ltr' ? 'letter-spacing:.08em;text-transform:uppercase;' : ''}}
.status svg{width:26px;height:26px}
.domain{font-family:"Inter";font-weight:600;font-size:20px;color:#4A5264;direction:ltr}
</style></head><body>
<div class="map">
  <span class="lamp" style="left:55.53%;top:11.42%"></span><span class="lamp" style="left:50.57%;top:19.63%"></span>
  <span class="lamp here" style="left:52.09%;top:18.69%"></span><span class="lamp" style="left:57.38%;top:25.54%"></span>
  <span class="lamp" style="left:78.83%;top:55.93%"></span><span class="lamp entry" style="left:63.42%;top:29.6%"></span>
</div>
<div class="wrap">
  <div class="brand">
    <svg viewBox="0 0 64 64" width="52" height="52" fill="none"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <circle cx="32" cy="32" r="21" stroke="url(#g)" stroke-width="7" stroke-linecap="round" stroke-dasharray="96 36" transform="rotate(-58 32 32)"/><circle cx="32" cy="32" r="8" fill="url(#g)"/></svg>
    <span class="word">NEOXIFY</span>
  </div>
  <p class="kicker">${c.kicker}</p>
  <h1><span>${c.l1}</span><span>${c.l2}</span></h1>
  <div class="chips">
    <span class="chip" dir="ltr">${METHODS}</span>
  </div>
  <div class="chips" style="margin-top:0">
    <span class="chip"><b>${c.platforms}</b></span>
    <span class="chip domain">neoxify.net</span>
  </div>
</div>
<div class="status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="rgba(50,103,255,.14)" stroke="none"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>${c.status}</div>
</body></html>`;
}

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  for (const [lang, c] of Object.entries(COPY)) {
    const tmp = path.join(here, `.og-${lang}.html`);
    fs.writeFileSync(tmp, html(c));
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(site, 'assets', 'img', `og-${lang}-v2.png`);
    await page.screenshot({ path: out, type: 'png' });
    fs.unlinkSync(tmp);
    console.log(out, fs.statSync(out).size, 'bytes');
  }
} finally {
  await browser.close();
}
