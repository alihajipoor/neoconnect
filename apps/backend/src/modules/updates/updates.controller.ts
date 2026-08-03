import { Controller, Get, Param, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { UpdatesService } from "./updates.service";

/** Where the desktop app asks "is there a newer version?".
 *
 * Unauthenticated, and deliberately so. The check runs on launch,
 * before anyone has signed in, and a customer whose session expired
 * still needs to be able to receive a fix. Nothing here is private:
 * it reports the newest public release and serves a public artifact.
 *
 * The path shape is Tauri's, not ours -- the updater substitutes
 * {{target}}, {{arch}} and {{current_version}} into the endpoint
 * configured in tauri.conf.json.
 */
@ApiExcludeController()
@Controller("updates")
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get("download/:tag/:asset")
  async download(
    @Param("tag") tag: string,
    @Param("asset") asset: string,
    @Res() res: Response,
  ) {
    const url = await this.updates.assetUrl(tag, asset);
    // Redirect rather than stream. Streaming would put the whole
    // installer through this box on every update; a redirect keeps the
    // control in our hands -- the client still had to ask us where to
    // go -- without paying the bandwidth. If GitHub ever needs
    // bypassing for reachability, this is the one place that changes,
    // and old clients follow it without being updated first.
    res.redirect(302, url);
  }

  @Get(":target/:arch/:currentVersion")
  async check(
    @Param("target") target: string,
    @Param("currentVersion") currentVersion: string,
    @Res() res: Response,
  ) {
    // Only Windows exists today. Anything else is told it is current
    // rather than handed a Windows installer.
    if (target !== "windows") {
      res.status(204).send();
      return;
    }

    const manifest = await this.updates.manifestFor(currentVersion);
    if (!manifest) {
      // 204 is how Tauri's updater is told "you are up to date". An
      // error here would surface to the customer as a failed update
      // check, which is the wrong thing to say when nothing is wrong.
      res.status(204).send();
      return;
    }
    res.json(manifest);
  }
}
