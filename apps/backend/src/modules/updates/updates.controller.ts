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

  /** The stable download link for the website.
   *
   * Always redirects to the newest release's branded installer, so the
   * site is set once and never edited again. Kept here rather than on a
   * marketing page for the same reason the update manifest is: it is
   * ours, so where the file actually lives can change without anybody
   * updating a link. */
  @Get("/installer/windows")
  async installer(@Res() res: Response) {
    res.redirect(302, await this.updates.installerUrl());
  }

  /** The same thing for Android.
   *
   * A tablet opens this in its browser and gets the APK; Android then
   * asks whether to install it. That confirmation tap cannot be skipped
   * by any app that is not the device owner, which is why there is no
   * silent-update counterpart here the way there is for Windows. */
  @Get("/installer/android")
  async androidInstaller(@Res() res: Response) {
    res.redirect(302, await this.updates.androidApkUrl());
  }

  @Get("download/:tag/:asset")
  async download(
    @Param("tag") tag: string,
    @Param("asset") asset: string,
    @Res() res: Response,
  ) {
    const url = await this.updates.downloadUrl(tag, asset);
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

    const check = await this.updates.checkFor(currentVersion);

    if (check.status === "current") {
      // 204 is how Tauri's updater is told "you are up to date". An
      // error here would surface to the customer as a failed update
      // check, which is the wrong thing to say when nothing is wrong.
      res.status(204).send();
      return;
    }

    if (check.status === "unknown") {
      // Nothing is up to date here -- we simply could not find out. 204
      // would claim otherwise, and during the 2026-08-22 GitHub blip it
      // did exactly that: clients on 0.9.24 were told they were current
      // while 0.9.25 sat published. Reporting a state nothing verified
      // is the one thing this app must never do, so say so instead and
      // let the updater try again on its next check.
      res.status(503).json({ message: "Could not determine the newest release" });
      return;
    }

    res.json(check.manifest);
  }
}
