import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAndroidUpdate } from "./android-update";

/** The direct Android build's update notice (inventory B6): what the
 * backend's answer means, and that only that build asks. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the backend's answer", () => {
  it("is an update only with a plain version and a path on the API", () => {
    expect(readAndroidUpdate({ ok: true, data: { version: "0.2.30", downloadPath: "/updates/installer/android" } })).toEqual({
      state: "available",
      version: "0.2.30",
      downloadPath: "/updates/installer/android",
    });
    expect(readAndroidUpdate({ ok: true, data: { version: "0.2.30-beta", downloadPath: "/updates/installer/android" } }).state).toBe(
      "unknown",
    );
    expect(readAndroidUpdate({ ok: true, data: { version: "0.2.30", downloadPath: "https://example.com/x.apk" } }).state).toBe(
      "unknown",
    );
    expect(readAndroidUpdate({ ok: true, data: { version: "0.2.30" } }).state).toBe("unknown");
  });

  it("is current on the backend's 204, and unknown -- never current -- when nothing compared", () => {
    expect(readAndroidUpdate({ ok: true, data: undefined })).toEqual({ state: "current" });
    expect(readAndroidUpdate({ ok: false, error: "x", status: 503 })).toEqual({ state: "unknown" });
    expect(readAndroidUpdate({ ok: false, error: "x" })).toEqual({ state: "unknown" });
  });
});

describe("who asks", () => {
  it("only the direct Android build, from Settings' About", () => {
    const app = source("../App.tsx");
    expect(app).toContain("aboutExtra={isAndroid() && !IS_STORE_BUILD ? <AndroidUpdateRow /> : null}");
    expect(app.match(/<AndroidUpdateRow \/>/g)?.length).toBe(1);
    const settings = source("../../../desktop-windows/src/screens/Settings.tsx");
    expect(settings).toMatch(/\{version \? <Row label=\{t\("set\.version"\)\}[^\n]*\n\s+\{aboutExtra\}/);
  });

  it("says nothing until there is something newer to say", () => {
    const row = source("../components/AndroidUpdateRow.tsx");
    expect(row).toContain('if (update.state !== "available") return null;');
  });
});
