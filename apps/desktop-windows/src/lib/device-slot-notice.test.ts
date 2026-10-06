import { describe, expect, it } from "vitest";
import { DICTIONARIES, type Language, type TranslationKey } from "./i18n";
import { describeSlotNotice, deviceName, formatSlotTime, type NoticeContext } from "./device-slot-notice";

/** The card's words, in both languages, from the limit and the holders.
 *
 * Times are formatted in UTC here so the assertions do not depend on the
 * machine running them; the app passes no zone and gets the device's. */

function ctx(language: Language, overrides: Partial<NoticeContext> = {}): NoticeContext {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => {
    let text: string = DICTIONARIES[language][key];
    for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
  return {
    t,
    language,
    tunnelDown: true,
    now: Date.parse("2026-10-06T12:00:00Z"),
    timeZone: "UTC",
    // en-GB for a 24-hour clock the assertions can spell; the app passes
    // none for English and gets the device's own.
    locale: language === "en" ? "en-GB" : undefined,
    ...overrides,
  };
}

const PC = {
  handle: "pc",
  label: "Windows PC",
  platform: "windows",
  since: "2026-10-06T10:32:04.120Z",
  lastSeen: "2026-10-06T10:55:41.004Z",
};

describe("the refusal card", () => {
  it("says the limit and where Neoxify is in use, since when", () => {
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 1, holders: [PC] } }, ctx("en"));
    expect(copy.lines[0]).toBe("Your plan allows 1 device at a time.");
    expect(copy.lines[1]).toMatch(/^Neoxify is in use on Windows PC since 10:32\.$/);
    expect(copy.useHere).toEqual({ label: "Use on this device instead", takeover: ["pc"] });
    expect(copy.dismiss).toBe("Cancel");
  });

  it("says it in Persian, with the device named in Persian", () => {
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 1, holders: [PC] } }, ctx("fa"));
    expect(copy.lines[0]).toBe(DICTIONARIES.fa["slots.limitOne"]);
    expect(copy.lines[1]).toContain(DICTIONARIES.fa["slots.labelWindows"]);
    expect(copy.lines[1]).not.toContain("Windows PC");
    // Persian digits: the time is written the way a reader in Iran reads it.
    expect(copy.lines[1]).toMatch(/[۰-۹]/);
    expect(copy.useHere?.label).toBe(DICTIONARIES.fa["slots.useHere"]);
    expect(copy.dismiss).toBe(DICTIONARIES.fa["slots.cancel"]);
  });

  it("offers every holder to the server on a plan of more than one, which frees only what it needs", () => {
    const phone = { ...PC, handle: "phone", label: "Android phone (Pixel 7)", platform: "android", since: "2026-10-05T09:15:00.000Z" };
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 2, holders: [PC, phone] } }, ctx("en"));
    expect(copy.lines[0]).toBe("Your plan allows 2 devices at a time.");
    expect(copy.lines[1]).toMatch(/^Neoxify is in use on Windows PC \(since 10:32\), Android phone \(Pixel 7\) \(since 5 Oct, 09:15\)\.$/);
    expect(copy.useHere?.takeover).toEqual(["pc", "phone"]);
  });

  it("says \"another device\" for a device that was never named, and drops a time it cannot read", () => {
    const copy = describeSlotNotice(
      { kind: "refused", refusal: { limit: 1, holders: [{ ...PC, label: null, since: null }] } },
      ctx("en"),
    );
    expect(copy.lines[1]).toBe("Neoxify is in use on another device.");
  });

  it("still words a refusal that named nobody", () => {
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 1, holders: [] } }, ctx("en"));
    expect(copy.lines).toEqual(["Your plan allows 1 device at a time.", "Neoxify is in use on another device."]);
    expect(copy.useHere?.takeover).toEqual([]);
  });
});

describe("the displaced card", () => {
  const by = { handle: "phone", label: "Android phone (Pixel 7)", platform: "android" };

  it("says Disconnected only once the tunnel is confirmed down", () => {
    expect(describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en")).lines).toEqual([
      "Disconnected: Neoxify is now in use on Android phone (Pixel 7).",
    ]);
    expect(describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en", { tunnelDown: false })).lines).toEqual([
      "Neoxify is now in use on Android phone (Pixel 7).",
    ]);
  });

  it("offers to take the slot back from that device", () => {
    const copy = describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en"));
    expect(copy.useHere).toEqual({ label: "Use on this device instead", takeover: ["phone"] });
    expect(copy.dismiss).toBe("Dismiss");
  });

  it("keeps a phone model intact inside a Persian sentence", () => {
    const line = describeSlotNotice({ kind: "displaced", by, at: null }, ctx("fa")).lines[0];
    expect(line).toContain(`${DICTIONARIES.fa["slots.labelAndroid"]} ⁨(Pixel 7)⁩`);
  });
});

describe("the other notices", () => {
  it("says how long until a takeover is allowed again, and offers no takeover", () => {
    const copy = describeSlotNotice({ kind: "takeoverLimited", retryAfterSec: 1260 }, ctx("en"));
    expect(copy.lines).toEqual(["You've switched devices too many times in the last hour. Try again in 21 min."]);
    expect(copy.useHere).toBeNull();
  });

  it("names the limit as a possibility when the API could not be asked, and offers nothing to press", () => {
    const copy = describeSlotNotice({ kind: "unchecked", limit: 1 }, ctx("en"));
    expect(copy.lines[0]).toMatch(/^We couldn't reach Neoxify to check\./);
    expect(copy.lines[0]).toContain("may be the reason");
    expect(copy.useHere).toBeNull();
    expect(copy.dismiss).toBeNull();
  });
});

describe("names and times", () => {
  it("translates only the generic part of a label", () => {
    expect(deviceName("Windows PC", ctx("en"))).toBe("Windows PC");
    expect(deviceName("My laptop", ctx("fa"))).toBe("⁨My laptop⁩");
    expect(deviceName(null, ctx("fa"))).toBe(DICTIONARIES.fa["slots.anotherDevice"]);
  });

  it("gives the date as well for an earlier day, and nothing for a time it cannot read", () => {
    expect(formatSlotTime("2026-10-06T10:32:04.120Z", ctx("en"))).toMatch(/^10:32$/);
    expect(formatSlotTime("2026-10-04T10:32:04.120Z", ctx("en"))).toMatch(/Oct/);
    expect(formatSlotTime("yesterday", ctx("en"))).toBeNull();
    expect(formatSlotTime(null, ctx("en"))).toBeNull();
  });
});
