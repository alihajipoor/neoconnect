import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_LOGO_PNG } from "./logo";

/** The mark as the emails show it: the apps' glass logo on a small
 * plate, pearl for light and smoked for dark mode, each at 1x and 2x.
 *
 * Unlike the flat mark in logo.ts, these are not drawn here. The glass
 * logo is a stack of gradients and highlights that only a browser
 * renders faithfully, so scripts/email-previews/render-logo.mjs
 * screenshots the website's own SVG and the results are committed in
 * ./assets. `nest build` copies them next to the compiled code
 * (nest-cli.json, "assets").
 *
 * Read once at import. If a file is not there -- a build that lost the
 * asset step -- the flat mark stands in: a plainer logo in an email is a
 * cosmetic fault, and an API that will not boot over a missing PNG is
 * an outage. */
const FILES = [
  "email-logo-light.png",
  "email-logo-light-2x.png",
  "email-logo-dark.png",
  "email-logo-dark-2x.png",
] as const;

export type EmailLogoFile = (typeof FILES)[number];

export const EMAIL_LOGO_FILES: readonly EmailLogoFile[] = FILES;

function load(file: EmailLogoFile): Buffer {
  try {
    return readFileSync(join(__dirname, "assets", file));
  } catch {
    return BRAND_LOGO_PNG;
  }
}

export const EMAIL_LOGOS: Record<EmailLogoFile, Buffer> = {
  "email-logo-light.png": load("email-logo-light.png"),
  "email-logo-light-2x.png": load("email-logo-light-2x.png"),
  "email-logo-dark.png": load("email-logo-dark.png"),
  "email-logo-dark-2x.png": load("email-logo-dark-2x.png"),
};
