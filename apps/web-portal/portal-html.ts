import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * How the built page gets on screen fast on a slow network.
 *
 * The page's first paint needs only the HTML: the canvas and the dotted
 * map are plain markup (index.html), drawn by a few hundred bytes of CSS
 * inlined into the head (src/auth/scene.css). Everything heavy -- the app
 * script, its stylesheet, the Latin typeface -- is asked for by a small
 * inline loader right AFTER that first paint, so none of it competes with
 * the paint for the connection. The app then switches its stylesheet on
 * (src/stylesheet.ts) before drawing anything into #root, so no screen is
 * ever shown unstyled.
 *
 * The loader's text is the same in every build: it reads the files'
 * hashed names from <meta name="pa-boot">, so its CSP hash does not
 * change from one release to the next (see LOADER_HASH and csp() below).
 *
 * Build only; the dev server keeps Vite's own handling.
 */

/** The CSS the first paint needs, as it goes inline: comments out,
 * whitespace collapsed. */
export function inlineSceneCss(source = readFileSync(resolve(here, "src/auth/scene.css"), "utf8")): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/** What the page says, in both languages, when the app script does not
 * arrive: it failed to load (a 404, a connection cut on a censored
 * network), or nothing has been drawn after LOADER_PATIENCE_MS -- still
 * on its way over a slow link, or failed in a way that leaves no event.
 * Only said while the app has drawn nothing; once it has, it replaces
 * this. Fixed text, so the loader's hash stays the same from build to
 * build. */
export const LOAD_FAILED = {
  en: "Could not load. Reload the page.",
  fa: "بارگذاری نشد. صفحه را دوباره بارگذاری کنید.",
} as const;
export const LOAD_SLOW = {
  en: "Still loading. If nothing appears, reload the page.",
  fa: "هنوز در حال بارگذاری است. اگر چیزی نمایان نشد، صفحه را دوباره بارگذاری کنید.",
} as const;
export const LOADER_PATIENCE_MS = 20_000;

/** A message as a JavaScript array literal in single quotes, which is
 * what the loader is written in (the test keeps quotes out of the text). */
const jsList = (m: { en: string; fa: string }) => `['${m.en}','${m.fa}']`;

/** Runs once the browser reports the page's first paint (the paint
 * timing entry, read even if it came before this listener), or after
 * 400 ms if none is reported -- a background tab, or a browser without
 * paint timing. Asks for the typeface, the stylesheet (as print, so it
 * cannot hold a paint; the app turns it on) and the app script, and says
 * so (LOAD_FAILED, LOAD_SLOW) when the script does not come. The message
 * is styled by the inline first-paint CSS (.pa-noscript), since the main
 * stylesheet is never turned on without the script. */
export const LOADER =
  "(()=>{let s=0;const go=()=>{if(s)return;s=1;" +
  "const m=document.querySelector('meta[name=\"pa-boot\"]');if(!m)return;" +
  "const d=m.dataset,h=document.head,el=(t,p)=>Object.assign(document.createElement(t),p);" +
  "if(d.font)h.append(el('link',{rel:'preload',as:'font',type:'font/woff2',crossOrigin:'anonymous',href:d.font}));" +
  "const c=el('link',{rel:'stylesheet',media:'print',crossOrigin:'anonymous',href:d.css});c.dataset.appCss='';h.append(c);" +
  "const say=t=>{const r=document.getElementById('root'),o=r&&r.firstChild;if(!r||o&&o.id!=='pa-boot-msg')return;" +
  "const b=el('div',{id:'pa-boot-msg',className:'pa-noscript'});b.setAttribute('role','alert');" +
  "b.append(el('p',{textContent:t[0]}),el('p',{textContent:t[1],lang:'fa',dir:'rtl'}));r.replaceChildren(b)};" +
  `let e=0;h.append(el('script',{type:'module',crossOrigin:'anonymous',src:d.js,onerror:()=>{e=1;say(${jsList(LOAD_FAILED)})}}));` +
  `setTimeout(()=>e||say(${jsList(LOAD_SLOW)}),${LOADER_PATIENCE_MS})};` +
  "try{new PerformanceObserver(()=>setTimeout(go,0)).observe({type:'paint',buffered:true})}catch(e){}" +
  "setTimeout(go,400)})();";

export const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The page's content security policy, as a <meta> because /account/ is
 * static files on a host whose headers this repo does not set.
 *
 * - Scripts and styles from this site only, plus exactly the two inline
 *   blocks above, by hash. No 'unsafe-inline', no eval.
 * - connect-src is https: rather than a host list: the app reaches its API
 *   through mirrors on several domains and addresses, signed into the
 *   endpoint bundle and changed without a release (lib/endpoint-bundle.ts),
 *   so any list written here would go stale and cut sign-in off on exactly
 *   the networks the mirrors exist for. Plain http and websockets stay out.
 * - frame-ancestors cannot be set from a <meta>; it needs a header.
 */
export function csp(inlineStyle: string, inlineScript: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${sha256(inlineScript)}`,
    `style-src 'self' ${sha256(inlineStyle)}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https:",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1];

/** One element of `pattern` in the page, removed; its tag returned. */
function take(html: string, pattern: RegExp, what: string): [string, string] {
  const found = html.match(pattern) ?? [];
  if (found.length !== 1) throw new Error(`portal-html: expected one ${what}, found ${found.length}`);
  return [html.replace(found[0], ""), found[0]];
}

export function transformPortalHtml(html: string, { withCsp = true } = {}): string {
  let script: string, css: string, font: string;
  [html, script] = take(html, /\s*<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/g, "app script");
  [html, css] = take(html, /\s*<link rel="stylesheet"[^>]*>/g, "stylesheet link");
  [html, font] = take(html, /\s*<link rel="preload"[^>]*as="font"[^>]*>/g, "font preload");
  const boot =
    `<meta name="pa-boot" data-js="${attr(script, "src")}" data-css="${attr(css, "href")}"` +
    ` data-font="${attr(font, "href")}" />`;
  const style = inlineSceneCss();
  const head =
    (withCsp ? `\n    <meta http-equiv="Content-Security-Policy" content="${csp(style, LOADER)}" />` : "") +
    `\n    ${boot}\n    <style>${style}</style>\n    <script>${LOADER}</script>`;
  // The policy has to come before anything it governs, so straight after
  // the charset. Functions, so nothing in the CSS is read as a $-pattern.
  return html
    .replace(/(<meta charset="UTF-8" \/>)/, (m) => m + head)
    .replace(/\n\s*\n/g, "\n");
}

export function portalHtml(): Plugin {
  return {
    name: "portal-html",
    apply: "build",
    transformIndexHtml: { order: "post", handler: (html) => transformPortalHtml(html) },
  };
}
