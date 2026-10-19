import { describe, expect, it } from "vitest";
import { LOADER, csp, inlineSceneCss, sha256, transformPortalHtml } from "../portal-html";
import { STYLESHEET_WAIT_MS, stylesheetApplied } from "./stylesheet";

/** The page as Vite writes it, before portal-html.ts. */
const VITE_OUTPUT = `<!doctype html>
<html lang="en" class="dark" data-surface="auth">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>Your account — Neoxify</title>
    <link rel="preload" href="/account/assets/Inter-latin-wght-AAAA.woff2" as="font" type="font/woff2" crossorigin />
    <script type="module" crossorigin src="/account/assets/index-BBBB.js"></script>
    <link rel="stylesheet" crossorigin href="/account/assets/index-CCCC.css">
  </head>
  <body><div class="pa-scene"></div><div id="root"></div></body>
</html>`;

describe("the built page's head", () => {
  const html = transformPortalHtml(VITE_OUTPUT);
  const head = html.slice(0, html.indexOf("</head>"));

  it("asks for nothing heavy before the first paint", () => {
    // The script, stylesheet and typeface are no longer in the markup,
    // where the browser would fetch them at once; the loader has them.
    expect(head).not.toMatch(/<script type="module"/);
    expect(head).not.toMatch(/<link rel="stylesheet"/);
    expect(head).not.toMatch(/<link rel="preload"/);
    expect(head).toContain(
      '<meta name="pa-boot" data-js="/account/assets/index-BBBB.js" data-css="/account/assets/index-CCCC.css"' +
        ' data-font="/account/assets/Inter-latin-wght-AAAA.woff2" />',
    );
  });

  it("paints the canvas and map from inline CSS, and loads the rest after", () => {
    expect(head).toContain(`<style>${inlineSceneCss()}</style>`);
    expect(head).toContain(`<script>${LOADER}</script>`);
    expect(inlineSceneCss()).toMatch(/\.pa-scene\{/);
    expect(inlineSceneCss()).toMatch(/\.pa-map\{/);
    expect(inlineSceneCss()).toMatch(/\.pa-noscript\{/);
    expect(inlineSceneCss()).not.toContain("/*");
    // Started by the first paint, or a timer if the tab never paints.
    expect(LOADER).toContain("type:'paint',buffered:true");
    expect(LOADER).toMatch(/setTimeout\(go,\d+\)\}\)\(\);$/);
    // The stylesheet arrives as print, so it cannot hold a paint; the app
    // turns it on (stylesheet.ts reads data-app-css).
    expect(LOADER).toContain("media:'print'");
    expect(LOADER).toContain("c.dataset.appCss=''");
  });

  it("keeps the loader the same in every build, so its hash is stable", () => {
    // No file name in it: those come from <meta name="pa-boot">.
    expect(LOADER).not.toMatch(/assets\/|index-[\w-]+\.|\.woff2/);
    expect(sha256(LOADER)).toBe(sha256(LOADER));
  });

  it("carries a content security policy, before anything it governs", () => {
    const policy = csp(inlineSceneCss(), LOADER);
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
    expect(head).toContain(meta);
    expect(head.indexOf(meta)).toBeLessThan(head.indexOf("<style>"));
    expect(head.indexOf(meta)).toBeLessThan(head.indexOf("<script>"));
    expect(head.indexOf('<meta charset="UTF-8" />')).toBeLessThan(head.indexOf(meta));
    expect(policy).toContain(`script-src 'self' ${sha256(LOADER)}`);
    expect(policy).toContain(`style-src 'self' ${sha256(inlineSceneCss())}`);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    // The API's mirrors live on several domains and addresses and change
    // without a release: any https origin, never plain http.
    expect(policy).toContain("connect-src 'self' https:");
  });

  it("refuses a page it does not recognise rather than shipping a half-built one", () => {
    expect(() => transformPortalHtml(VITE_OUTPUT.replace(/<script type="module"[^>]*><\/script>/, ""))).toThrow(/app script/);
  });
});

describe("turning the stylesheet on", () => {
  type FakeLink = { sheet: object | null; media: string; listeners: Record<string, () => void>; addEventListener: (t: string, f: () => void) => void };
  const link = (loaded: boolean): FakeLink => ({
    sheet: loaded ? {} : null,
    media: "print",
    listeners: {},
    addEventListener(type, f) {
      this.listeners[type] = f;
    },
  });
  const doc = (links: FakeLink[]) => ({ querySelectorAll: () => links }) as unknown as Document;

  it("applies a sheet that has already arrived, at once", async () => {
    const l = link(true);
    await stylesheetApplied(doc([l]));
    expect(l.media).toBe("all");
  });

  it("waits for one still on its way, and gives up on none forever", async () => {
    const l = link(false);
    let applied = false;
    const done = stylesheetApplied(doc([l])).then(() => (applied = true));
    await Promise.resolve();
    expect(l.media).toBe("all");
    expect(applied).toBe(false);
    l.listeners.load();
    await done;
    expect(applied).toBe(true);
    expect(STYLESHEET_WAIT_MS).toBeLessThanOrEqual(10_000);
  });

  it("does not wait at all where there is no such link (the dev server)", async () => {
    await expect(stylesheetApplied(doc([]))).resolves.toBeUndefined();
  });
});
