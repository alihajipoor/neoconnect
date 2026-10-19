/**
 * Turns on the main stylesheet and says when it applies.
 *
 * The build writes it into index.html as `media="print"` with
 * `data-app-css` (vite.config.ts, portalHtml), which a browser fetches
 * without holding the first paint for it: the page shows its canvas and
 * map from the HTML and a few hundred bytes of inline CSS, instead of
 * waiting on the whole stylesheet first. Switching `media` to `all` here
 * applies it -- done from this module rather than an inline `onload`
 * handler, which a content security policy without 'unsafe-inline' would
 * refuse.
 *
 * Resolves once the sheet applies, or failed to load (rendering unstyled
 * beats rendering nothing), or at once when there is no such link: the
 * dev server, and any build without the split.
 */
export const STYLESHEET_WAIT_MS = 10_000;

export function stylesheetApplied(doc: Document = document): Promise<void> {
  const links = [...doc.querySelectorAll<HTMLLinkElement>("link[data-app-css]")];
  return Promise.all(
    links.map(
      (link) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          if (link.sheet) {
            link.media = "all";
            return done();
          }
          link.addEventListener("load", done, { once: true });
          link.addEventListener("error", done, { once: true });
          // A load that failed before this script ran leaves no event to
          // wait for and no sheet: never hold the page on it forever.
          setTimeout(done, STYLESHEET_WAIT_MS);
          link.media = "all";
        }),
    ),
  ).then(() => undefined);
}
