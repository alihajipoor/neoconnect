import { describe, expect, it } from "vitest";
import { chromiumFromUserAgent, cleanVersion, engineLine, engineMajor, engineNote } from "./webview-engine";

describe("the Windows web component's version", () => {
  it("is read as its leading digits and dots", () => {
    expect(cleanVersion("100.0.1185.36")).toBe("100.0.1185.36");
    expect(cleanVersion(" 157.0.1 beta")).toBe("157.0.1");
    expect(cleanVersion("99.")).toBe("99");
    expect(cleanVersion("garbage")).toBeNull();
    expect(cleanVersion("")).toBeNull();
  });

  it("gives a major version or nothing", () => {
    expect(engineMajor("99.0")).toBe(99);
    expect(engineMajor("100.0.4896.75")).toBe(100);
    expect(engineMajor("0.0")).toBeNull();
    expect(engineMajor(null)).toBeNull();
  });

  it("is noted below 111 only", () => {
    expect(engineNote("100.0.4896.75")).toBe("webview 100.0.4896.75");
    expect(engineNote("110.0.1587.69")).toBe("webview 110.0.1587.69");
    expect(engineNote("111.0.1661.41")).toBeNull();
    expect(engineNote("157.0.1")).toBeNull();
    expect(engineNote(null)).toBeNull();
  });

  it("is in the diagnostics with the page's Chromium beside it", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Edg/100.0.1185.36";
    expect(chromiumFromUserAgent(ua)).toBe("100.0.4896.75");
    expect(engineLine("100.0.1185.36", chromiumFromUserAgent(ua))).toBe("webview2: 100.0.1185.36 (Chromium 100.0.4896.75)");
    expect(engineLine(null, null)).toBe("webview2: could not be read");
  });
});
