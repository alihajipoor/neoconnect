import { Controller, Get, Header, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { EMAIL_LOGOS, type EmailLogoFile } from "./email-logo";
import { BRAND_LOGO_PNG, BRAND_LOGO_PNG_MONO, BRAND_LOGO_SVG } from "./logo";

/** Serves the Neoxify mark over plain HTTP.
 *
 * Unauthenticated -- like the invoice-link controller, it simply
 * carries no guard, since guards in this API are applied per
 * controller rather than globally. That is deliberate here because the consumer is a mail client
 * fetching an <img> out of an email -- it has no session, and an image
 * that 401s is an email with a broken logo in it.
 *
 * Cached hard: the mark is generated from fixed geometry at import, so
 * every response for a given build is byte-identical, and Gmail's image
 * proxy will cache it anyway.
 */
@ApiExcludeController()
@Controller("brand")
export class BrandController {
  @Get("logo.png")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  png(@Res() res: Response) {
    res.send(BRAND_LOGO_PNG);
  }

  /** The white variant, for the violet header the emails had until
   * 2026-11. Nothing sends it any more, and it stays: mail already in
   * people's inboxes still asks for it, and an email is never re-sent
   * with a corrected image address. */
  @Get("logo-mono.png")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  mono(@Res() res: Response) {
    res.send(BRAND_LOGO_PNG_MONO);
  }

  /** What the emails show now: the glass mark on its plate, pearl and
   * smoked, at 1x and 2x (email-logo.ts).
   *
   * Cached for a month, not for ever like the marks above. Those are
   * drawn from fixed geometry; these are pictures of a logo that may be
   * redrawn, and a mailbox should pick the new one up without the
   * address having to change. */
  @Get(["email-logo-light.png", "email-logo-light-2x.png", "email-logo-dark.png", "email-logo-dark-2x.png"])
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "public, max-age=2592000")
  emailLogo(@Req() req: Request, @Res() res: Response) {
    const file = req.path.slice(req.path.lastIndexOf("/") + 1) as EmailLogoFile;
    res.send(EMAIL_LOGOS[file]);
  }

  @Get("logo.svg")
  @Header("Content-Type", "image/svg+xml")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  svg(@Res() res: Response) {
    res.send(BRAND_LOGO_SVG);
  }
}
