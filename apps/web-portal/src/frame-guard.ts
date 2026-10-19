/**
 * The account pages do not work inside another site's frame.
 *
 * Any site could otherwise load https://neoxify.net/account/ in an iframe
 * and lay its own page over it -- the sign-in form, and after sign-in the
 * purchase, voucher and settings screens -- so that a visitor clicks or
 * types into ours while seeing theirs. The header that forbids framing
 * (CSP frame-ancestors, or X-Frame-Options) cannot be set from a <meta>,
 * and the host's headers are not this repo's to set. So the page checks
 * for itself: framed, it draws nothing of the app, only a link that opens
 * it in its own tab. Framed with scripts sandboxed off, nothing of the app
 * runs at all.
 */

/** Whether this page is inside a frame. Comparing the window proxies is
 * allowed across origins; anything that throws is treated as framed. */
export function isFramed(win: { top: unknown; self: unknown } = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** Both languages: a framed page cannot rely on the saved one, which a
 * browser keeps apart from the framing site's storage. */
export const OWN_TAB_LINK = {
  en: "Open Neoxify sign-in in its own tab",
  fa: "ورود به نئوکسیفای را در زبانه‌ای جداگانه باز کنید",
} as const;

type Doc = Pick<Document, "createElement">;

/** The one thing a framed page shows: a plain link to itself, opened at
 * the top level, where the address bar says whose page it is. Styled by
 * the inline first-paint CSS (.pa-noscript), which needs no script. */
export function showOwnTabLink(root: Element, href: string, doc: Doc = document): void {
  const box = doc.createElement("div");
  box.className = "pa-noscript";
  for (const lang of ["en", "fa"] as const) {
    const p = doc.createElement("p");
    const a = doc.createElement("a");
    a.href = href;
    a.target = "_top";
    a.textContent = OWN_TAB_LINK[lang];
    if (lang === "fa") {
      p.lang = "fa";
      p.dir = "rtl";
    }
    p.append(a);
    box.append(p);
  }
  root.replaceChildren(box);
}
