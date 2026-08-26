import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "./i18n";

/** Honesty and parity guards on the shipped strings.
 *
 * Key parity is already a compile error -- `fa` is declared
 * `Record<TranslationKey, string>`, so a missing key does not build. These
 * are the things the type system cannot see:
 *
 *  * A Persian value that is really the English one, pasted through. That
 *    compiles, ships, and is only caught by somebody who reads Persian.
 *  * A placeholder that survived in one language and not the other.
 *    `{count}` lost in translation renders as a sentence with a hole in it.
 *  * A claim the product has measured to be false. Gaming Mode is an
 *    access feature, not a latency one: Tehran to Blizzard EU is 72.0 ms
 *    direct and 72.8 ms through the best node in the fleet. Any string
 *    promising a faster or lower-ping connection is a lie, and users in
 *    Iran act on these strings.
 *  * The register. Persian here is plain formal «شما». Informal «تو» has
 *    been rejected three times.
 */

const { en, fa } = DICTIONARIES;
const keys = Object.keys(en) as (keyof typeof en)[];

/** `{name}`-style holes, which both languages must agree on. */
function placeholders(value: string): string[] {
  return (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
}

describe("translation parity", () => {
  it("has a non-empty Persian string for every key", () => {
    const empty = keys.filter((k) => !fa[k] || fa[k].trim().length === 0);
    expect(empty).toEqual([]);
  });

  it("keeps the same placeholders in both languages", () => {
    const drifted = keys
      .filter((k) => placeholders(en[k]).join(",") !== placeholders(fa[k]).join(","))
      .map((k) => `${k}: en=${placeholders(en[k])} fa=${placeholders(fa[k])}`);
    expect(drifted).toEqual([]);
  });

  it("does not leave a Persian string as untranslated English", () => {
    // Compared on the letters only, so a shared number or a brand name in
    // Latin script does not read as a false positive.
    const lettersOnly = (v: string) => v.replace(/[^A-Za-z]/g, "").toLowerCase();
    const untranslated = keys.filter((k) => {
      const e = lettersOnly(en[k]);
      // Short values are legitimately identical across languages (a brand
      // name, "VPN", "IPv6"). Only a real sentence is evidence.
      return e.length > 12 && e === lettersOnly(fa[k]);
    });
    expect(untranslated).toEqual([]);
  });

  it("writes Persian in Persian script", () => {
    // Every Persian value that is a sentence must actually contain Persian
    // letters. Catches a key that was added to `en` and copied into `fa`
    // as a placeholder to make it compile.
    const notPersian = keys.filter((k) => fa[k].length > 12 && !/[؀-ۿ]/.test(fa[k]));
    expect(notPersian).toEqual([]);
  });
});

describe("what the strings are allowed to claim", () => {
  /** The measured verdict: the best path through the fleet is 0.8 ms worse
   * than not using it at all. See docs/design/gaming-mode.md and the
   * "never say" list in its section 11. */
  const SPEED_CLAIMS = [
    /\blower(s)? (your )?ping\b/i,
    /\bless lag\b/i,
    /\breduce(s)? (your )?(ping|lag|latency)\b/i,
    /\bfaster connection\b/i,
    /\bspeed(s)? up\b/i,
    /\boptimi[sz]ed route\b/i,
    /\bping بهتر\b/,
    /\bسریع‌تر می‌کند\b/,
    /\bپینگ (را )?کاهش\b/,
  ];

  /** Denials are the point, not the problem.
   *
   * `gaming.noSpeedClaim` exists precisely to say "does not promise a
   * faster connection", and a check that cannot tell a denial from a
   * promise would flag the one string doing the honest work -- and would
   * then be deleted by whoever hit it. So the scan is per sentence, and a
   * sentence carrying a negation is not a claim. */
  const NEGATIONS = /\b(not|never|no)\b|نمی|هیچ|نیست/i;

  it("never promises a faster connection or a lower ping", () => {
    const offenders: string[] = [];
    for (const k of keys) {
      for (const [langName, lang] of [
        ["en", en],
        ["fa", fa],
      ] as const) {
        for (const sentence of lang[k].split(/[.!?؟۔]|\s—\s/)) {
          if (NEGATIONS.test(sentence)) continue;
          for (const claim of SPEED_CLAIMS) {
            if (claim.test(sentence)) offenders.push(`${langName} ${k}: ${sentence.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** Keys describing what the PRODUCT can do, where "yet" is a promise.
   *
   * Deliberately a list rather than a blanket ban. "No conversations yet"
   * is fine -- that empty state fills the moment the customer writes to
   * support. These are different: they describe capability that is not
   * being built, and "yet" turns each into a commitment. Every one of
   * these had the word and it was removed on 2026-08-25. */
  const NO_PROMISES = [
    "gaming.noResolver",
    "gaming.noResolverBody",
    "gaming.listEmpty",
    "settings.customGameEmpty",
    "settings.customGameWholeApp",
  ] as const;

  it("does not tell the customer to wait for something nobody is building", () => {
    for (const k of NO_PROMISES) {
      expect(`${k}: ${en[k]}`).not.toMatch(/\byet\b/i);
      expect(`${k}: ${fa[k]}`).not.toContain("هنوز");
    }
  });

  it("never tells a customer to wait for the resolver", () => {
    // "yet" promised a delivery nobody intends to make: no node serves the
    // DNS half of gaming mode and none is planned. See the DEAD BRANCH
    // section in apps/backend/src/modules/gaming/gaming.module.ts.
    expect(en["gaming.noResolver"]).not.toMatch(/\byet\b/i);
    expect(fa["gaming.noResolver"]).not.toContain("هنوز");
  });

  it("tells the customer what a catalogue entry actually is", () => {
    // The catalogue runs to 1,480 entries and nothing in it has been tested
    // against a running game. A long list reads as a compatibility list
    // unless something says otherwise.
    expect(en["gaming.pickerMeaning"]).toMatch(/none has been tested/i);
    expect(fa["gaming.pickerMeaning"]).toContain("آزمایش نشده");
  });

  it("keeps Persian in the formal register", () => {
    // A sample of unambiguous informal (dovom-shakhs mofrad) verb endings.
    // «شما» takes «-ید»; these are the «تو» forms that have been rejected
    // three times. Deliberately narrow -- a broad pattern would fire on
    // legitimate words and get the test deleted.
    const INFORMAL = ["می‌کنی ", "می‌شی ", "بزنی ", "کنی.", "بزن.", "برو.", "ببین."];
    const offenders: string[] = [];
    for (const k of keys) {
      for (const form of INFORMAL) {
        if (fa[k].includes(form)) offenders.push(`${k}: ${fa[k]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
