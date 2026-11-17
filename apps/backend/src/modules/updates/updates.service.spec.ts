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

  const linuxRelease = {
    tag_name: "linux-v0.1.1",
    name: "Neoxify Linux 0.1.1",
    body: null,
    published_at: "2026-11-16T20:00:00Z",
    draft: false,
    prerelease: false,
    assets: [
      { name: "Neoxify_0.1.1_amd64.deb", browser_download_url: "https://example.test/Neoxify_0.1.1_amd64.deb" },
      { name: "Neoxify-0.1.1-1.x86_64.rpm", browser_download_url: "https://example.test/Neoxify-0.1.1-1.x86_64.rpm" },
      { name: "sha256sums.txt", browser_download_url: "https://example.test/sha256sums.txt" },
    ],
  };

  let fetchMock: jest.Mock;

  const releasesOk = () => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve([windowsRelease, androidRelease, linuxRelease]),
  });
  const feedOf = (...releases: unknown[]) => ({ ok: true, status: 200, json: () => Promise.resolve(releases) });
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

  describe("checkAndroid", () => {
    it("offers the newer APK's version to an older app", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkAndroid("0.9.24"))).resolves.toEqual({ status: "update", version: "0.9.25" });
    });

    it("compares versions numerically, not as text", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkAndroid("0.9.3"))).resolves.toEqual({ status: "update", version: "0.9.25" });
      await expect(settle(service.checkAndroid("0.10.0"))).resolves.toEqual({ status: "current" });
    });

    it("reports current for an app on the newest APK", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkAndroid("0.9.25"))).resolves.toEqual({ status: "current" });
    });

    it("reports unknown, never current, when the feed cannot be read", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkAndroid("0.9.24"))).resolves.toEqual({ status: "unknown" });
    });

    it("does not offer a desktop release to the Android app", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([windowsRelease]) });
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkAndroid("0.0.1"))).resolves.toEqual({ status: "unknown" });
    });
  });

  describe("Linux", () => {
    it("offers the newer version to an older Linux app", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
    });

    it("reports current for an app on the newest build, or newer", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.1"))).resolves.toEqual({ status: "current" });
      await expect(settle(service.checkLinux("0.2.0"))).resolves.toEqual({ status: "current" });
    });

    it("reports unknown, never current, when the feed cannot be read", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "unknown" });
    });

    it("links each package format from the newest linux-v release", async () => {
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.linuxPackageUrl("deb"))).resolves.toBe(
        "https://github.com/alihajipoor/neoxify-releases/releases/download/linux-v0.1.1/Neoxify_0.1.1_amd64.deb",
      );
      await expect(settle(service.linuxPackageUrl("rpm"))).resolves.toBe(
        "https://github.com/alihajipoor/neoxify-releases/releases/download/linux-v0.1.1/Neoxify-0.1.1-1.x86_64.rpm",
      );
    });

    it("404s when no Linux release exists", async () => {
      fetchMock.mockResolvedValue(feedOf(windowsRelease, androidRelease));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.linuxPackageUrl("deb"))).rejects.toThrow(
        "No Linux release is available to download yet",
      );
    });

    it("never serves a desktop-v release to Linux, even one carrying a stray .deb", async () => {
      const strayDeb = {
        ...windowsRelease,
        tag_name: "desktop-v0.9.26",
        assets: [
          ...windowsRelease.assets,
          { name: "Neoxify_0.9.26_amd64.deb", browser_download_url: "https://example.test/x.deb" },
          { name: "Neoxify-0.9.26-1.x86_64.rpm", browser_download_url: "https://example.test/x.rpm" },
        ],
      };
      fetchMock.mockResolvedValue(feedOf(strayDeb, linuxRelease));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
      await expect(settle(service.linuxPackageUrl("deb"))).resolves.toContain("linux-v0.1.1");
    });

    it("never serves a linux-v release to Windows", async () => {
      // Given a signature and a versioned payload, so the only thing
      // keeping it from the Windows updater is its tag.
      const linuxLookingLikeWindows = {
        ...linuxRelease,
        tag_name: "linux-v0.9.99",
        assets: [
          { name: "Neoxify_0.9.99_x64-setup.exe", browser_download_url: "https://example.test/a.exe" },
          { name: "Neoxify_0.9.99_x64-setup.exe.sig", browser_download_url: "https://example.test/a.exe.sig" },
          { name: "Neoxify-Setup.exe", browser_download_url: "https://example.test/b.exe" },
        ],
      };
      fetchMock.mockResolvedValue(feedOf(linuxLookingLikeWindows, linuxRelease));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkFor("0.0.1"))).resolves.toEqual({ status: "unknown" });
      await expect(settle(service.installerUrl())).rejects.toThrow("No release is available to download yet");
    });

    it("skips a release whose packages do not carry the tag's version", async () => {
      const mislabelled = {
        ...linuxRelease,
        tag_name: "linux-v0.2.0",
        assets: [
          { name: "Neoxify_0.1.9_amd64.deb", browser_download_url: "https://example.test/x.deb" },
          { name: "Neoxify-0.1.9-1.x86_64.rpm", browser_download_url: "https://example.test/x.rpm" },
        ],
      };
      fetchMock.mockResolvedValue(feedOf(mislabelled, linuxRelease));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
    });

    it("skips a release missing one of the two packages", async () => {
      const debOnly = {
        ...linuxRelease,
        tag_name: "linux-v0.2.0",
        assets: [{ name: "Neoxify_0.2.0_amd64.deb", browser_download_url: "https://example.test/x.deb" }],
      };
      fetchMock.mockResolvedValue(feedOf(debOnly, linuxRelease));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
    });

    it("does not take a suffixed or unanchored filename for a package", async () => {
      const odd = {
        ...linuxRelease,
        tag_name: "linux-v0.2.0",
        assets: [
          { name: "Neoxify_0.2.0_amd64.deb.zip", browser_download_url: "https://example.test/x" },
          { name: "debug-Neoxify-0.2.0-1.x86_64.rpm", browser_download_url: "https://example.test/y" },
        ],
      };
      fetchMock.mockResolvedValue(feedOf(odd, linuxRelease));
      const service = new UpdatesService(configWith({}));
      await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
    });

    describe("signed packages", () => {
      const signedRelease = {
        ...linuxRelease,
        tag_name: "linux-v0.2.0",
        assets: [
          { name: "Neoxify_0.2.0_amd64.deb", browser_download_url: "https://example.test/a.deb" },
          { name: "Neoxify_0.2.0_amd64.deb.sig", browser_download_url: "https://example.test/a.deb.sig" },
          { name: "Neoxify-0.2.0-1.x86_64.rpm", browser_download_url: "https://example.test/a.rpm" },
          { name: "Neoxify-0.2.0-1.x86_64.rpm.sig", browser_download_url: "https://example.test/a.rpm.sig" },
        ],
      };
      /** The feed, and each .sig answering with its own text, or with the
       * status given for it. */
      const serving = (feed: unknown[], sigStatus: Record<string, number> = {}) =>
        fetchMock.mockImplementation((url: string) => {
          const u = String(url);
          if (u.includes("api.github.com")) return Promise.resolve(feedOf(...feed));
          const status = Object.entries(sigStatus).find(([k]) => u.endsWith(k))?.[1];
          if (status) return Promise.resolve(failWith(status));
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(`sig of ${u}\n`) });
        });
      const api = configWith({ publicApiUrl: "https://example.test/api/" });

      it("carries each package's download link and trimmed signature", async () => {
        serving([signedRelease, linuxRelease]);
        const service = new UpdatesService(api);
        await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({
          status: "update",
          version: "0.2.0",
          signed: {
            deb: {
              url: "https://example.test/api/updates/download/linux-v0.2.0/Neoxify_0.2.0_amd64.deb",
              signature: "sig of https://example.test/a.deb.sig",
            },
            rpm: {
              url: "https://example.test/api/updates/download/linux-v0.2.0/Neoxify-0.2.0-1.x86_64.rpm",
              signature: "sig of https://example.test/a.rpm.sig",
            },
          },
        });
      });

      it("answers as before, without signed, for a release published without signatures", async () => {
        serving([linuxRelease]);
        const service = new UpdatesService(api);
        await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.1.1" });
        expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("api.github.com"))).toBe(true);
      });

      it("leaves out only the package whose signature could not be read", async () => {
        serving([signedRelease], { "a.rpm.sig": 404 });
        const service = new UpdatesService(api);
        const check = await settle(service.checkLinux("0.1.0"));
        expect(check.status === "update" && Object.keys(check.signed ?? {})).toEqual(["deb"]);
      });

      it("drops signed altogether, still offering the version, when no signature is readable", async () => {
        serving([signedRelease], { "a.deb.sig": 404, "a.rpm.sig": 404 });
        const service = new UpdatesService(api);
        await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.2.0" });
      });

      it("pairs a signature only with the file it is named after", async () => {
        const misnamed = {
          ...signedRelease,
          assets: [
            signedRelease.assets[0],
            signedRelease.assets[2],
            { name: "Neoxify_0.2.0_amd64.sig", browser_download_url: "https://example.test/x.sig" },
            { name: "other-Neoxify-0.2.0-1.x86_64.rpm.sig", browser_download_url: "https://example.test/y.sig" },
          ],
        };
        serving([misnamed]);
        const service = new UpdatesService(api);
        await expect(settle(service.checkLinux("0.1.0"))).resolves.toEqual({ status: "update", version: "0.2.0" });
      });

      it("fetches nothing for an app that is already current", async () => {
        serving([signedRelease]);
        const service = new UpdatesService(api);
        await expect(settle(service.checkLinux("0.2.0"))).resolves.toEqual({ status: "current" });
        expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("api.github.com"))).toBe(true);
      });

      it("redirects the newest Linux build's two packages and nothing else", async () => {
        serving([windowsRelease, signedRelease, linuxRelease]);
        const service = new UpdatesService(api);
        await expect(settle(service.downloadUrl("linux-v0.2.0", "Neoxify_0.2.0_amd64.deb"))).resolves.toBe(
          "https://github.com/alihajipoor/neoxify-releases/releases/download/linux-v0.2.0/Neoxify_0.2.0_amd64.deb",
        );
        await expect(settle(service.downloadUrl("linux-v0.2.0", "Neoxify-0.2.0-1.x86_64.rpm"))).resolves.toContain(
          "Neoxify-0.2.0-1.x86_64.rpm",
        );
        await expect(settle(service.downloadUrl("linux-v0.2.0", "Neoxify_0.2.0_amd64.deb.sig"))).rejects.toThrow(
          "Unknown release asset",
        );
        await expect(settle(service.downloadUrl("linux-v0.1.1", "Neoxify_0.1.1_amd64.deb"))).rejects.toThrow(
          "Unknown release asset",
        );
        await expect(settle(service.downloadUrl("linux-v0.2.0", "Neoxify_0.9.25_x64-setup.exe"))).rejects.toThrow(
          "Unknown release asset",
        );
        // The Windows payload still passes, and a Windows tag cannot name a package.
        await expect(settle(service.downloadUrl("desktop-v0.9.25", "Neoxify_0.9.25_x64-setup.exe"))).resolves.toContain(
          "desktop-v0.9.25",
        );
        await expect(settle(service.downloadUrl("desktop-v0.9.25", "Neoxify_0.2.0_amd64.deb"))).rejects.toThrow(
          "Unknown release asset",
        );
      });
    });

    it("serves last known good for Linux too", async () => {
      const service = new UpdatesService(configWith({}));
      const good = await settle(service.linuxPackageUrl("rpm"));

      jest.setSystemTime(Date.now() + 6 * 60_000);
      fetchMock.mockResolvedValue(failWith(504));

      await expect(settle(service.linuxPackageUrl("rpm"))).resolves.toBe(good);
    });
  });

  describe("releaseSummary", () => {
    it("reports every platform from one feed read", async () => {
      const service = new UpdatesService(configWith({}));
      const summary = await settle(service.releaseSummary());

      expect(summary.find((entry) => entry.platform === "windows")?.version).toBe("0.9.25");
      expect(summary.find((entry) => entry.platform === "android")?.version).toBe("0.9.25");
      const linux = summary.find((entry) => entry.platform === "linux");
      expect(linux?.version).toBe("0.1.1");
      expect(linux?.url).toContain("Neoxify_0.1.1_amd64.deb");
      expect(linux?.packages?.deb).toBe(linux?.url);
      expect(linux?.packages?.rpm).toContain("Neoxify-0.1.1-1.x86_64.rpm");
      expect(linux?.publishedAt).toBe("2026-11-16T20:00:00Z");
    });

    it("reports Linux as not released rather than borrowing another platform's build", async () => {
      fetchMock.mockResolvedValue(feedOf(windowsRelease, androidRelease));
      const service = new UpdatesService(configWith({}));
      const summary = await settle(service.releaseSummary());

      expect(summary.find((entry) => entry.platform === "linux")).toEqual({
        platform: "linux",
        version: null,
        url: null,
        packages: null,
        publishedAt: null,
      });
    });

    it("reports nulls rather than throwing when the feed is unavailable", async () => {
      fetchMock.mockResolvedValue(failWith(504));
      const service = new UpdatesService(configWith({}));
      const summary = await settle(service.releaseSummary());

      expect(summary.every((entry) => entry.version === null)).toBe(true);
    });
  });

  describe("a feed longer than one page", () => {
    // GitHub does not put each product's newest release near the top. On
    // 2026-11-10 thirty agent and desktop releases filled the first page,
    // every Android release sat behind them, and Android answered 503.
    const fullPageOfDesktop = Array.from({ length: 100 }, (_, i) => ({
      ...windowsRelease,
      tag_name: "desktop-v0.8." + String(i),
    }));
    const page = (releases: unknown[]) => ({ ok: true, status: 200, json: () => Promise.resolve(releases) });
    const byPage = (pages: Record<string, unknown>) => (url: string) => {
      const n = new URL(String(url)).searchParams.get("page") ?? "1";
      return Promise.resolve(pages[n] ?? page([]));
    };

    it("finds the Android release on the second page", async () => {
      fetchMock.mockImplementation(byPage({ "1": page(fullPageOfDesktop), "2": page([androidRelease]) }));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkAndroid("0.0.1"))).resolves.toEqual({ status: "update", version: "0.9.25" });
      expect(releasesCalls().map((call) => new URL(String(call[0])).searchParams.get("page"))).toEqual(["1", "2"]);
      expect(String(releasesCalls()[0][0])).toContain("per_page=100");
    });

    it("stops at a short page", async () => {
      const service = new UpdatesService(configWith({}));
      await settle(service.installerUrl());

      expect(releasesCalls()).toHaveLength(1);
    });

    it("does not say there is no Android release when a later page cannot be read", async () => {
      fetchMock.mockImplementation(byPage({ "1": page(fullPageOfDesktop), "2": failWith(504) }));
      const service = new UpdatesService(configWith({}));

      await expect(settle(service.checkAndroid("0.0.1"))).resolves.toEqual({ status: "unknown" });
    });
  });
});
