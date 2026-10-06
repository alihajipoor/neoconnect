import { describe, expect, it } from "vitest";
import { DICTIONARIES, type Language, type TranslationKey } from "./i18n";
import { describeSlotNotice, deviceName, formatSlotTime, slotNoticeShown, type NoticeContext } from "./device-slot-notice";

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

/** As the revised contract sends a PC: no label of its own -- a kind is
 * never one -- so it is named from its platform. */
const PC = {
  handle: "pc",
  label: null,
  platform: "windows",
  since: "2026-10-06T10:32:04.120Z",
  lastSeen: "2026-10-06T10:55:41.004Z",
};

describe("the refusal card", () => {
  it("says the limit and where Neoxify is in use, since when", () => {
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 1, holders: [PC] } }, ctx("en"));
    expect(copy.lines[0]).toBe("Your plan allows 1 device at a time.");
    expect(copy.lines[1]).toMatch(/^Neoxify is in use on a Windows PC since 10:32\.$/);
    expect(copy.useHere).toEqual({ label: "Use on this device instead", takeover: ["pc"] });
    expect(copy.dismiss).toBe("Cancel");
  });

  it("says it in Persian, with the device named in Persian", () => {
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 1, holders: [PC] } }, ctx("fa"));
    expect(copy.lines[0]).toBe(DICTIONARIES.fa["slots.limitOne"]);
    expect(copy.lines[1]).toContain(DICTIONARIES.fa["slots.platformWindows"]);
    expect(copy.lines[1]).not.toContain("Windows");
    // Persian digits: the time is written the way a reader in Iran reads it.
    expect(copy.lines[1]).toMatch(/[۰-۹]/);
    expect(copy.useHere?.label).toBe(DICTIONARIES.fa["slots.useHere"]);
    expect(copy.dismiss).toBe(DICTIONARIES.fa["slots.cancel"]);
  });

  it("offers every holder to the server on a plan of more than one, which frees only what it needs", () => {
    const phone = { ...PC, handle: "phone", label: "Pixel 7", platform: "android", since: "2026-10-05T09:15:00.000Z" };
    const copy = describeSlotNotice({ kind: "refused", refusal: { limit: 2, holders: [PC, phone] } }, ctx("en"));
    expect(copy.lines[0]).toBe("Your plan allows 2 devices at a time.");
    expect(copy.lines[1]).toMatch(/^Neoxify is in use on a Windows PC \(since 10:32\), Pixel 7 \(since 5 Oct, 09:15\)\.$/);
    expect(copy.useHere?.takeover).toEqual(["pc", "phone"]);
  });

  it("says \"another device\" for a device with neither a label nor a platform, and drops a time it cannot read", () => {
    const copy = describeSlotNotice(
      { kind: "refused", refusal: { limit: 1, holders: [{ ...PC, platform: null, since: null }] } },
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
  const by = { handle: "phone", label: "Pixel 7", platform: "android" };

  it("says Disconnected only once the tunnel is confirmed down", () => {
    expect(describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en")).lines).toEqual([
      "Disconnected: Neoxify is now in use on Pixel 7.",
    ]);
    expect(describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en", { tunnelDown: false })).lines).toEqual([
      "Neoxify is now in use on Pixel 7.",
    ]);
  });

  it("names a device the server sent no label for by its platform, in the app's language", () => {
    const phone = { handle: "phone", label: null, platform: "android" };
    expect(describeSlotNotice({ kind: "displaced", by: phone, at: null }, ctx("en")).lines).toEqual([
      "Disconnected: Neoxify is now in use on an Android phone.",
    ]);
    const fa = describeSlotNotice({ kind: "displaced", by: phone, at: null }, ctx("fa")).lines[0];
    expect(fa).toContain(DICTIONARIES.fa["slots.platformAndroid"]);
    expect(fa).not.toMatch(/[A-Za-z]/);
  });

  it("offers to take the slot back from that device", () => {
    const copy = describeSlotNotice({ kind: "displaced", by, at: null }, ctx("en"));
    expect(copy.useHere).toEqual({ label: "Use on this device instead", takeover: ["phone"] });
    expect(copy.dismiss).toBe("Dismiss");
  });

  it("keeps a phone model intact inside a Persian sentence", () => {
    const line = describeSlotNotice({ kind: "displaced", by, at: null }, ctx("fa")).lines[0];
    expect(line).toContain("روی ⁨Pixel 7⁩ ");
  });
});

/** Obligation 11: never the refusal card over a tunnel still carrying
 * traffic. A refusal that arrives after connecting waits for the
 * teardown to be confirmed; the others word themselves for either. */
describe("when a notice may show", () => {
  const refused = { kind: "refused" as const, refusal: { limit: 1, holders: [PC] } };

  it("holds a refusal back until the tunnel is confirmed down", () => {
    expect(slotNoticeShown(refused, false)).toBe(false);
    expect(slotNoticeShown(refused, true)).toBe(true);
  });

  it("shows the others at once", () => {
    expect(slotNoticeShown({ kind: "displaced", by: null, at: null }, false)).toBe(true);
    expect(slotNoticeShown({ kind: "takeoverLimited", retryAfterSec: 60 }, false)).toBe(true);
    expect(slotNoticeShown({ kind: "unchecked", limit: 1, noAnswer: true }, false)).toBe(true);
  });
});

describe("the other notices", () => {
  it("says how long until a takeover is allowed again, and offers no takeover", () => {
    const copy = describeSlotNotice({ kind: "takeoverLimited", retryAfterSec: 1260 }, ctx("en"));
    expect(copy.lines).toEqual(["You've switched devices too many times in the last hour. Try again in 21 min."]);
    expect(copy.useHere).toBeNull();
  });

  it("writes counts in Persian digits on a Persian card, as it does times", () => {
    const copy = describeSlotNotice({ kind: "takeoverLimited", retryAfterSec: 1260 }, ctx("fa"));
    expect(copy.lines[0]).toContain("۲۱");
    expect(copy.lines[0]).not.toMatch(/[0-9]/);
    const limit = describeSlotNotice({ kind: "refused", refusal: { limit: 2, holders: [] } }, ctx("fa"));
    expect(limit.lines[0]).toContain("۲");
  });

  it("names the limit as a possibility when the API could not be asked, and offers nothing to press", () => {
    const copy = describeSlotNotice({ kind: "unchecked", limit: 1, noAnswer: true }, ctx("en"));
    expect(copy.lines[0]).toMatch(/^We couldn't reach Neoxify to check\./);
    expect(copy.lines[0]).toContain("may be the reason");
    expect(copy.useHere).toBeNull();
    expect(copy.dismiss).toBeNull();
  });

  /** Neoxify answered -- an error, a throttle, an answer this app could
   * not read -- so "couldn't reach" would be untrue. What is true is that
   * it did not confirm this device's slot. */
  it("never says Neoxify could not be reached when it answered without confirming", () => {
    const en = describeSlotNotice({ kind: "unchecked", limit: 2, noAnswer: false }, ctx("en"));
    expect(en.lines).toEqual([
      "Neoxify couldn't confirm this device's place on your plan right now. If Neoxify is in use on another of your devices, your plan's limit of 2 at a time may be the reason.",
    ]);
    expect(en.lines[0]).not.toMatch(/reach/);
    expect(en.useHere).toBeNull();
    expect(en.dismiss).toBeNull();

    const fa = describeSlotNotice({ kind: "unchecked", limit: 2, noAnswer: false }, ctx("fa"));
    expect(fa.lines[0]).toBe(DICTIONARIES.fa["slots.unconfirmed"].split("{limit}").join("۲"));
    // Not the sentence that says it could not be reached.
    expect(fa.lines[0]).not.toContain("دسترسی");
  });
});

describe("names and times", () => {
  /** "Naming a device on screen": the label as sent, else the platform's
   * name in the app's language, else "another device". */
  it("names each platform in English and in Persian when there is no label", () => {
    const cases = [
      ["windows", "a Windows PC", "یک رایانهٔ ویندوزی"],
      ["macos", "a Mac", "یک مک"],
      ["linux", "a Linux PC", "یک رایانهٔ لینوکسی"],
      ["android", "an Android phone", "یک گوشی اندروید"],
      ["ios", "an iPhone", "یک آیفون"],
    ];
    for (const [platform, en, fa] of cases) {
      expect(deviceName({ label: null, platform }, ctx("en"))).toBe(en);
      expect(deviceName({ label: null, platform }, ctx("fa"))).toBe(fa);
    }
    // The header is case-insensitive, and so is this.
    expect(deviceName({ label: null, platform: "Windows" }, ctx("en"))).toBe("a Windows PC");
  });

  it("shows a model or the user's own words as sent, isolated inside a Persian sentence", () => {
    expect(deviceName({ label: "Pixel 7", platform: "android" }, ctx("en"))).toBe("Pixel 7");
    expect(deviceName({ label: "iPad", platform: "ios" }, ctx("en"))).toBe("iPad");
    expect(deviceName({ label: "My laptop", platform: "windows" }, ctx("fa"))).toBe("⁨My laptop⁩");
    expect(deviceName({ label: "گوشی من", platform: "android" }, ctx("fa"))).toBe("گوشی من");
  });

  it("says another device with neither a label nor a platform it knows", () => {
    expect(deviceName(null, ctx("en"))).toBe("another device");
    expect(deviceName({ label: null, platform: null }, ctx("fa"))).toBe(DICTIONARIES.fa["slots.anotherDevice"]);
    expect(deviceName({ label: null, platform: "toString" }, ctx("en"))).toBe("another device");
    expect(deviceName({ label: "  ", platform: "web" }, ctx("en"))).toBe("another device");
  });

  /** What the apps were first built to send. The kind is the reader's to
   * name, in its own language; only the model is kept. */
  it("names a label that is only a kind from the platform, and keeps only the model of a qualified one", () => {
    expect(deviceName({ label: "Windows PC", platform: "windows" }, ctx("fa"))).toBe(
      DICTIONARIES.fa["slots.platformWindows"],
    );
    expect(deviceName({ label: "Android phone (Pixel 7)", platform: "android" }, ctx("en"))).toBe("Pixel 7");
    expect(deviceName({ label: "iPhone", platform: null }, ctx("en"))).toBe("another device");
  });

  it("gives the date as well for an earlier day, and nothing for a time it cannot read", () => {
    expect(formatSlotTime("2026-10-06T10:32:04.120Z", ctx("en"))).toMatch(/^10:32$/);
    expect(formatSlotTime("2026-10-04T10:32:04.120Z", ctx("en"))).toMatch(/Oct/);
    expect(formatSlotTime("yesterday", ctx("en"))).toBeNull();
    expect(formatSlotTime(null, ctx("en"))).toBeNull();
  });
});
