import { Controller, Get, Header, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
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

  /** The white variant, for the violet header the emails use -- the
   * gradient's violet half is invisible against it. */
  @Get("logo-mono.png")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  mono(@Res() res: Response) {
    res.send(BRAND_LOGO_PNG_MONO);
  }

  @Get("logo.svg")
  @Header("Content-Type", "image/svg+xml")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  svg(@Res() res: Response) {
    res.send(BRAND_LOGO_SVG);
  }
}
