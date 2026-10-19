import { describe, expect, it } from "vitest";
import { formatDate, formatDuration, formatSize, localDigits, sizeParts } from "./locale-format";

describe("numbers in the app's language", () => {
  it("writes Persian digits, and the Persian decimal separator, only in Persian", () => {
    expect(localDigits("7.2 GB, 12 days", "fa")).toBe("۷٫۲ GB, ۱۲ days");
    expect(localDigits("7.2 GB, 12 days", "en")).toBe("7.2 GB, 12 days");
  });

  it("sizes the data used with the unit in words in Persian", () => {
    expect(formatSize(7.2 * 1024 ** 3, "en")).toBe("7.2 GB");
    expect(formatSize(7.2 * 1024 ** 3, "fa")).toBe("۷٫۲ گیگابایت");
    expect(sizeParts(512 * 1024 ** 2, "en")).toEqual({ value: "512.0", unit: "MB" });
  });

  it("times a session without ever going negative", () => {
    expect(formatDuration(6128, "en")).toBe("01:42:08");
    expect(formatDuration(40 * 3600 + 5, "en")).toBe("40:00:05");
    expect(formatDuration(65, "en")).toBe("01:05");
    expect(formatDuration(-30, "en")).toBe("00:00");
    expect(formatDuration(6128, "fa")).toBe("۰۱:۴۲:۰۸");
  });

  it("dates in the Solar Hijri calendar in Persian", () => {
    const day = Date.UTC(2026, 9, 19, 12);
    expect(formatDate(day, "en")).toMatch(/2026/);
    const fa = formatDate(day, "fa");
    // 19 October 2026 is 27 Mehr 1405.
    expect(fa).toMatch(/۱۴۰۵/);
    expect(fa).not.toMatch(/2026|۲۰۲۶/);
    expect(formatDate("not a date", "en")).toBe("—");
  });
});
