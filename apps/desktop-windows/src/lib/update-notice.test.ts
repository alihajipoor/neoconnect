import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Linux update notice (lib/update-notice.ts): the API is asked as the
 * Android build asks it, the updater plugin never, and the notice offers
 * the website's download page -- no download, no install, no restart. */

const publicRequest = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("./api", () => ({ publicRequest: (path: string) => publicRequest(path) }));
const getAppLinks = vi.fn<() => Promise<unknown>>();
vi.mock("./customer", () => ({ getAppLinks: () => getAppLinks() }));
vi.mock("./social-auth", () => ({ socialStartBase: async () => "https://api.example.com/" }));
const openUrl = vi.fn<(url: string) => Promise<void>>();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));

const notice = await import("./update-notice");
const { I18nProvider } = await import("./i18n");
const { UpdateBanner } = await import("../components/UpdateBanner");
import type { UpdateState } from "./updates";

beforeEach(() => {
  publicRequest.mockReset();
  getAppLinks.mockReset();
  openUrl.mockReset();
  check.mockReset();
  notice.resetUpdateNoticeForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Linux update check", () => {
  it("asks the API for this version on x86_64", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    expect(await notice.checkForNotice("0.1.0")).toEqual({ state: "current" });
    expect(publicRequest).toHaveBeenCalledWith("/updates/linux/x86_64/0.1.0");
  });

  it("reads 204 as current, a release as available, and anything else as nothing", () => {
    expect(notice.readNoticeAnswer({ ok: true, data: "" } as never)).toEqual({ state: "current" });
    expect(
      notice.readNoticeAnswer({ ok: true, data: { version: "0.2.0", downloadPath: "/updates/installer/linux-deb" } } as never),
    ).toEqual({ state: "available", version: "0.2.0", downloadPath: "/updates/installer/linux-deb" });
    expect(notice.readNoticeAnswer({ ok: true, data: { version: "latest", downloadPath: "/updates/x" } } as never)).toEqual({
      state: "unknown",
    });
    expect(notice.readNoticeAnswer({ ok: true, data: { version: "0.2.0", downloadPath: "https://example.com/x" } } as never)).toEqual({
      state: "unknown",
    });
    expect(notice.readNoticeAnswer({ ok: false } as never)).toEqual({ state: "unknown" });
  });

  it("says a newer version is available, and never calls the updater", async () => {
    vi.useFakeTimers();
    publicRequest.mockResolvedValue({ ok: true, data: { version: "0.2.0", downloadPath: "/updates/installer/linux-deb" } });
    const states: UpdateState[] = [];
    const stop = notice.startUpdateNotices((s) => states.push(s));
    await vi.advanceTimersByTimeAsync(25_000);
    stop();
    expect(states).toEqual([{ status: "available", version: "0.2.0" }]);
    expect(check).not.toHaveBeenCalled();
  });

  it("opens the website's download page, in the customer's language", async () => {
    getAppLinks.mockResolvedValue({ ok: true, data: { websiteUrl: "https://www.example.com/" } });
    expect(await notice.downloadPageUrl("en")).toBe("https://www.example.com/download/");
    expect(await notice.downloadPageUrl("fa")).toBe("https://www.example.com/fa/download/");
    await notice.openDownloadPage("en");
    expect(openUrl).toHaveBeenCalledWith("https://www.example.com/download/");
  });

  it("without a website address, opens the package on whichever of our addresses answers", async () => {
    getAppLinks.mockResolvedValue({ ok: false });
    expect(await notice.downloadPageUrl("en")).toBe("https://api.example.com/updates/installer/linux-deb");
  });
});

describe("the update banner", () => {
  const render = (state: UpdateState, onOpenDownload?: () => void) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(UpdateBanner, { state, onRestart: () => undefined, busy: false, blocked: false, onOpenDownload }),
      ),
    );

  it("on Linux says a new version is available and offers the download page, not a restart", () => {
    const html = render({ status: "available", version: "0.2.0" }, () => undefined);
    expect(html).toContain("Neoxify 0.2.0 is available.");
    expect(html).toContain("Download");
    expect(html).not.toContain("Restart");
    expect(html).not.toContain("ready to install");
  });

  it("on Windows is what it was", () => {
    const html = render({ status: "ready", version: "0.9.65" });
    expect(html).toContain("Neoxify 0.9.65 is ready to install.");
    expect(html).toContain("Restart now");
    expect(render({ status: "none" })).toBe("");
  });
});
