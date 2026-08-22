import { ConfigService } from "@nestjs/config";

import { UpdatesService } from "./updates.service";

/** These cover a real outage. On 2026-08-22 api.github.com returned a
 * single 504; the backend cached that as "there is no release" for the
 * full five-minute success TTL, and for four and a half minutes every
 * download link 404'd while clients on 0.9.24 were told they were up to
 * date. The release itself was fine the whole time.
 *
 * Nothing about that was a rate limit -- the box was at 14 of 60 calls
 * used. The bug was that one failed request was treated exactly like a
 * successful "nothing published", with no retry and nothing remembered.
 */
describe("UpdatesService", () => {
  const configWith = (values: Record<string, string | undefined> = {}) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  const windowsRelease = {
    tag_name: "desktop-v0.9.25",
    name: "Neoxify 0.9.25",
    body: null,
    published_at: "2026-08-22T10:03:18Z",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "Neoxify_0.9.25_x64-setup.exe",
        browser_download_url: "https://example.test/Neoxify_0.9.25_x64-setup.exe",
      },
      {
        name: "Neoxify_0.9.25_x64-setup.exe.sig",
        browser_download_url: "https://example.test/Neoxify_0.9.25_x64-setup.exe.sig",
      },
      { name: "Neoxify-Setup.exe", browser_download_url: "https://example.test/Neoxify-Setup.exe" },
    ],
  };

  const androidRelease = {
    tag_name: "android-v0.9.25",
    name: "Neoxify Android 0.9.25",
    body: null,
    published_at: "2026-08-22T10:03:18Z",
    draft: false,
    prerelease: false,
    assets: [
      { name: "Neoxify-0.9.25.apk", browser_download_url: "https://example.test/Neoxify-0.9.25.apk" },
    ],
  };

  let fetchMock: jest.Mock;

  const releasesOk = () => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve([windowsRelease, androidRelease]),
  });
  const failWith = (status: number) => ({ ok: false, status, json: () => Promise.resolve({}) });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    fetchMock = jest.fn().mockResolvedValue(releasesOk());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The retries use real setTimeout, so a fake-timer test has to let
   * them fire. Runs the promise and drains pending timers alongside it. */
  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    const result = promise.then(
      (value) => ({ value }) as { value: T },
      (error: unknown) => ({ error }) as { error: unknown },
    );
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(1_000);
    }
    const settled = await result;
    if ("error" in settled) throw settled.error;
    return settled.value;
  };

  const releasesCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes("api.github.com"));

  describe("GitHub authentication", () => {
    it("sends no Authorization header when no token is configured", async () => {
      const service = new UpdatesService(configWith({}));
      await settle(service.installerUrl());

      expect(releasesCalls()[0][1].headers.Authorization).toBeUndefined();
      expect(releasesCalls()[0][1].headers["User-Agent"]).toBe("neoxify-api");
    });

    it("authenticates the release feed when a token is configured", async () => {
      const service = new UpdatesService(configWith({ "github.token": "ghp_example" }));
      await settle(service.installerUrl());

      expect(releasesCalls()[0][1].headers.Authorization).toBe("Bearer ghp_example");
    });

    it("never sends the token to the asset host when fetching a signature", async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("api.github.com")
            ? releasesOk()
            : { ok: true, status: 200, text: () => Promise.resolve("sig-bytes") },
        ),
      );

      const service = new UpdatesService(
        configWith({ "github.token": "ghp_example", publicApiUrl: "https://example.test/api" }),
      );
      await settle(service.checkFor("0.9.24"));

      const signatureCall = fetchMock.mock.calls.find(
        (call) => !String(call[0]).includes("api.github.com"),
      );
      expect(signatureCall).toBeDefined();
      expect(signatureCall![1].headers.Authorization).toBeUndefined();
    });
  });

  describe("transient failures", () => {
    it("retries a 5xx rather than reporting no release", async () => {
      fetchMock
        .mockResolvedValueOnce(failWith(504))
        .mockResolvedValueOnce(failWith(504))
        .mockResolvedValue(releasesOk());

      const service = new UpdatesService(configWith({}));

      await expect(settle(service.installerUrl())).resolves.toContain("desktop-v0.9.25");
      expect(releasesCalls()).toHaveLength(3);
    });

    it("retries a network error", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValue(releasesOk());

      const service = new UpdatesService(configWith({}));

      await expect(settle(service.installerUrl())).resolves.toContain("Neoxify-Setup.exe");
    });

    it("does not retry a 403, which a rate limit cannot refill inside the loop", async () => {
      fetchMock.mockResolvedValue(failWith(403));

      const service = new UpdatesService(configWith({}));

      await expect(settle(service.installerUrl())).rejects.toThrow();
      expect(releasesCalls()).toHaveLength(1);
    });
  });

  describe("last known good", () => {
    it("keeps serving the previous release when the feed then fails", async () => {
      const service = new UpdatesService(configWith({}));
      const good = await settle(service.installerUrl());

      // Past the success TTL, with GitHub now failing outright.
      jest.setSystemTime(Date.now() + 6 * 60_000);
      fetchMock.mockResolvedValue(failWith(504));

      await expect(settle(service.installerUrl())).resolves.toBe(good);
    });

    it("serves last known good for Android too", async () => {
      const service = new UpdatesService(configWith({}));
      const good = await settle(service.androidApkUrl());

      jest.setSystemTime(Date.now() + 6 * 60_000);
      fetchMock.mockResolvedValue(failWith(504));

      await expect(settle(service.androidApkUrl())).resolves.toBe(good);
    });

    it("stops serving a stale result once it is more than a day old", async () => {
      const service = new UpdatesService(configWith({}));
      await settle(service.installerUrl());

      jest.setSystemTime(Date.now() + 25 * 60 * 60_000);
      fetchMock.mockResolvedValue(failWith(504));

      await expect(settle(service.installerUrl())).rejects.toThrow(
        "No release is available to download yet",
      );
    });

    it("404s only when a lookup has never succeeded", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.installerUrl())).rejects.toThrow(
        "No release is available to download yet",
      );
    });
  });

  describe("failure caching", () => {
    it("retries within seconds after a failure, not after the full success TTL", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));
      await settle(service.installerUrl().catch(() => null));

      const afterFirst = releasesCalls().length;

      // Well inside the 5-minute success TTL. The old code cached the
      // failure that long and 404'd every request in between without so
      // much as trying again.
      jest.setSystemTime(Date.now() + 31_000);
      fetchMock.mockResolvedValue(releasesOk());

      await expect(settle(service.installerUrl())).resolves.toContain("desktop-v0.9.25");
      expect(releasesCalls().length).toBeGreaterThan(afterFirst);
    });

    it("still caches a failure briefly, so an outage is not one call per request", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));

      await settle(service.installerUrl().catch(() => null));
      const afterFirst = releasesCalls().length;

      await settle(service.installerUrl().catch(() => null));
      expect(releasesCalls()).toHaveLength(afterFirst);
    });

    it("caches a success for the full TTL", async () => {
      const service = new UpdatesService(configWith({}));
      await settle(service.installerUrl());
      const afterFirst = releasesCalls().length;

      jest.setSystemTime(Date.now() + 60_000);
      await settle(service.installerUrl());

      expect(releasesCalls()).toHaveLength(afterFirst);
    });
  });

  describe("checkFor", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("api.github.com")
            ? releasesOk()
            : { ok: true, status: 200, text: () => Promise.resolve("sig-bytes\n") },
        ),
      );
    });

    it("offers an update to an older client", async () => {
      const service = new UpdatesService(configWith({ publicApiUrl: "https://example.test/api" }));
      const check = await settle(service.checkFor("0.9.24"));

      expect(check.status).toBe("update");
      expect(check.status === "update" && check.manifest.version).toBe("0.9.25");
      expect(check.status === "update" && check.manifest.platforms["windows-x86_64"].url).toBe(
        "https://example.test/api/updates/download/desktop-v0.9.25/Neoxify_0.9.25_x64-setup.exe",
      );
      // Trimmed -- Tauri rejects a signature with trailing whitespace.
      expect(check.status === "update" && check.manifest.platforms["windows-x86_64"].signature).toBe(
        "sig-bytes",
      );
    });

    it("reports current for a client already on the newest build", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkFor("0.9.25"))).resolves.toEqual({ status: "current" });
    });

    it("reports unknown, never current, when the lookup fails", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkFor("0.9.24"))).resolves.toEqual({ status: "unknown" });
    });

    it("reports unknown when the signature cannot be read", async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("api.github.com") ? releasesOk() : failWith(404),
        ),
      );
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkFor("0.9.24"))).resolves.toEqual({ status: "unknown" });
    });
  });

  describe("releaseSummary", () => {
    it("reports both platforms from one feed read", async () => {
      const service = new UpdatesService(configWith({}));
      const summary = await settle(service.releaseSummary());

      expect(summary.find((entry) => entry.platform === "windows")?.version).toBe("0.9.25");
      expect(summary.find((entry) => entry.platform === "android")?.version).toBe("0.9.25");
    });

    it("reports nulls rather than throwing when the feed is unavailable", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));
      const summary = await settle(service.releaseSummary());

      expect(summary.every((entry) => entry.version === null)).toBe(true);
    });
  });
});
